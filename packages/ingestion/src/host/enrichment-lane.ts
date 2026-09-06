/**
 * Enrichment lane — the version-join host execution.
 *
 * For one structured source with an `enrichment` block in its spec,
 * this module:
 *
 *   1. Loads state. Computes which versions to look up this poll:
 *      - `pendingEnrichments` (versions whose enrichment failed
 *        transiently last time) — always re-fetched.
 *      - The last K=5 known versions — re-fetched to detect edits
 *        to the enrichment body (closes the "edits to old entries
 *        are invisible" gap that the unstructured set-diff model
 *        has).
 *
 *   2. For each version to look up, calls `lookupEnrichment`.
 *      - `found` → build an enrichment artifact, push to P2, update
 *        the per-version `EnrichmentState` in the source state.
 *      - `not_found` → silent skip per the v1 decision. No telemetry.
 *      - Throws (transient) → add to `pendingEnrichments` for next
 *        poll. Continue with other versions.
 *
 *   3. Updates `pendingEnrichments` (clear any that succeeded, add
 *      any that failed) and `enrichmentLastRunAt` (set to `now`).
 *
 * Per the v1 decisions:
 *   - 404 (not_found) is silent skip.
 *   - Transient failures retry on the next poll via
 *     `pendingEnrichments`.
 *   - Re-fetch frequency default: every poll, but only the last
 *     K=5 versions. (Configurable per source via the source spec's
 *     enrichment block; v1 hardcodes K=5.)
 *
 * See [[Version-Join Architecture — Unstructured Enrichment Driven
 * by Structured Lane]] for the design.
 */

import type { Artifact, StructuredSource } from "@outpost/shared";

import type { FetchLike, ReadEnvLike } from "../sources/structured/types.js";
import type { ScrapeClient } from "../sources/unstructured/index.js";

import { lookupEnrichment } from "../sources/structured/enrichment-lookup.js";

import {
  loadOrInit,
  type EnrichmentState,
  type SourceState,
  StateStore,
} from "./state-store.js";
import type { P2Receiver } from "./p2-receiver.js";

/**
 * Default re-fetch window: every poll, re-fetch the last K versions
 * to detect edits. Configurable per source in a future PR.
 */
const DEFAULT_REFETCH_WINDOW = 5;

export interface EnrichmentRunResult {
  readonly status: "success" | "skipped" | "failed";
  /** Enrichment artifacts pushed to P2. */
  readonly artifacts: ReadonlyArray<Artifact>;
  /** How many versions we looked up this poll. */
  readonly versionsLookedUp: number;
  /** How many returned `not_found` (silent skip). */
  readonly versionsNotFound: number;
  /** How many transiently failed and were added to `pendingEnrichments`. */
  readonly versionsPending: number;
  /** Stable error code (only on `failed`). */
  readonly errorCode: string | null;
  /** Human-readable diagnostic for the run log. */
  readonly message: string;
}

export interface EnrichmentRunOptions {
  readonly source: StructuredSource;
  readonly now: string;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
    readonly scrape: ScrapeClient;
  };
  readonly state: StateStore;
  readonly p2: P2Receiver;
  /** Optional override for the re-fetch window. Defaults to 5. */
  readonly refetchWindow?: number;
}

export async function runEnrichment(
  opts: EnrichmentRunOptions,
): Promise<EnrichmentRunResult> {
  const { source, now, deps, state, p2, refetchWindow = DEFAULT_REFETCH_WINDOW } = opts;

  // 0. Sources without an enrichment block: skip.
  if (source.enrichment === undefined) {
    return {
      status: "skipped",
      artifacts: [],
      versionsLookedUp: 0,
      versionsNotFound: 0,
      versionsPending: 0,
      errorCode: null,
      message: `source ${source.id} has no enrichment block; skipping enrichment lane`,
    };
  }
  const config = source.enrichment;

  // 1. Load state.
  let prev: SourceState;
  try {
    prev = await loadOrInit(state, source.id, "structured", now);
  } catch (cause) {
    return {
      status: "failed",
      artifacts: [],
      versionsLookedUp: 0,
      versionsNotFound: 0,
      versionsPending: 0,
      errorCode: "state_corrupt",
      message: `state file unreadable for ${source.id}: ${(cause as Error).message}`,
    };
  }
  if (prev.kind !== "structured") {
    return {
      status: "failed",
      artifacts: [],
      versionsLookedUp: 0,
      versionsNotFound: 0,
      versionsPending: 0,
      errorCode: "state_corrupt",
      message: `state kind drift for ${source.id}`,
    };
  }

  // 2. Build the list of versions to look up this poll.
  //
  // (a) pendingEnrichments: always re-fetch.
  // (b) The last K versions we've ever seen — re-fetch to detect
  //     edits. The structured lane's `lastSeenVersion` is the most
  //     recent; we use the `enrichments` array's versions (any we've
  //     ever enriched) as the "ever seen" list, ordered by recency.
  const pendingSet = new Set(prev.pendingEnrichments);
  const enrichedVersions = prev.enrichments
    .map((e) => e.version)
    // Stable order: by `lastSeenAt` descending (most recent first).
    .sort((a, b) => {
      const aRec = prev.enrichments.find((e) => e.version === a);
      const bRec = prev.enrichments.find((e) => e.version === b);
      const aTime = aRec?.lastSeenAt ?? "";
      const bTime = bRec?.lastSeenAt ?? "";
      return bTime.localeCompare(aTime);
    });
  const recentVersions = enrichedVersions.slice(0, refetchWindow);
  const versionsToFetch = new Set<string>([
    ...prev.pendingEnrichments,
    ...recentVersions,
  ]);
  // Also include the most recent structured lastSeenVersion if it's
  // not already in the set (catches a brand-new version we haven't
  // enriched yet).
  if (prev.lastSeenVersion !== null) {
    versionsToFetch.add(prev.lastSeenVersion);
  }

  if (versionsToFetch.size === 0) {
    // No versions to look up yet (source just started, no structured
    // detection has happened). Mark the run as a no-op.
    return {
      status: "skipped",
      artifacts: [],
      versionsLookedUp: 0,
      versionsNotFound: 0,
      versionsPending: 0,
      errorCode: null,
      message: `no versions to enrich for ${source.id} yet; waiting for structured detection`,
    };
  }

  // 3. Look up enrichment for each version.
  const artifacts: Artifact[] = [];
  const newPending: string[] = [];
  const newEnrichments = [...prev.enrichments];
  let notFoundCount = 0;

  for (const version of versionsToFetch) {
    let result;
    try {
      result = await lookupEnrichment(source, config, version, deps);
    } catch (err) {
      // Transient failure: add to pending for next poll. Continue
      // with other versions.
      newPending.push(version);
      continue;
    }
    if (result.status === "not_found") {
      notFoundCount++;
      // Silent skip. The version-join is "version has no entry on
      // the enrichment feed" — we don't error, we don't emit. The
      // P2 side will see the structured-only artifact and the
      // consumer's agent knows the enrichment is absent.
      continue;
    }

    // result.status === "found"
    const existing = newEnrichments.find((e) => e.version === version);
    const isNewOrChanged =
      existing === undefined || existing.contentHash !== result.contentHash;
    if (isNewOrChanged) {
      const artifact: Artifact = {
        source_id: source.id,
        source_type: null,
        unstructured_strategy: config.strategy,
        version: result.version,
        content_hash: result.contentHash,
        body: result.cleanedText,
        content_type: result.contentType,
        anchor: {
          mechanism: config.anchor_source,
          value: result.version,
          type: "version",
        },
        entry_id: result.entryUrl,
        detection_method: existing === undefined ? "new_entry" : "entry_update",
        detected_at: result.detectedAt,
        fetch_provenance: {
          url: result.entryUrl,
          auth: config.auth ?? "none",
          httpStatus: 200,
          fetchedAt: result.detectedAt,
        },
        fetch_mode: "incremental",
      };
      try {
        const push = await p2.push(artifact);
        if (!push.ok) {
          // P2 rejected: don't update the enrichment state, but
          // also don't add to pending (rejection is not transient —
          // retrying the same content won't help). The next poll
          // re-fetches this version, and the same rejection happens.
          // Surface as a version-level error in the run report.
          continue;
        }
        artifacts.push(artifact);
      } catch {
        // Transport throw: treat as transient, add to pending.
        newPending.push(version);
        continue;
      }
    }

    // Update the per-version enrichment state.
    const newState: EnrichmentState = {
      version,
      contentHash: result.contentHash,
      lastSeenAt: now,
    };
    if (existing !== undefined) {
      const idx = newEnrichments.indexOf(existing);
      newEnrichments[idx] = newState;
    } else {
      newEnrichments.push(newState);
    }
    // If this version was in pendingEnrichments, clear it from
    // pending (success).
    if (pendingSet.has(version)) {
      const pendingIdx = newPending.indexOf(version);
      if (pendingIdx === -1) {
        // The version was in pendingEnrichments; we either added
        // it to newPending above (if the lookup threw) or we just
        // succeeded. If we succeeded, it should NOT be in newPending.
        // Nothing to do.
      } else {
        newPending.splice(pendingIdx, 1);
      }
    }
  }

  // 4. Persist new state. The structured lane's `lastSeenVersion`
  // and `lastSeenHash` are preserved; we only touch the enrichment
  // fields.
  const next: SourceState = {
    source_id: source.id,
    kind: "structured",
    lastSeenVersion: prev.lastSeenVersion,
    lastSeenHash: prev.lastSeenHash,
    lastPolledAt: prev.lastPolledAt,
    pollCount: prev.pollCount,
    backfillStatus: prev.backfillStatus,
    backfillRunId: prev.backfillRunId,
    backfillStartedAt: prev.backfillStartedAt,
    backfillCheckpoint: prev.backfillCheckpoint,
    enrichments: newEnrichments,
    pendingEnrichments: newPending,
    enrichmentLastRunAt: now,
  };
  await state.write(next);

  return {
    status: artifacts.length > 0 ? "success" : "skipped",
    artifacts,
    versionsLookedUp: versionsToFetch.size,
    versionsNotFound: notFoundCount,
    versionsPending: newPending.length,
    errorCode: null,
    message: `pushed ${artifacts.length} enrichment artifact(s) for ${source.id} (${notFoundCount} not found, ${newPending.length} pending retry)`,
  };
}
