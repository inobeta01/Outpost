/**
 * Structured-lane host execution for backfill mode (PR 4 Slice 2).
 *
 * Mirror of `runStructuredSource` but for the one-time onboarding
 * backfill operation. Behavior:
 *
 *   1. Load state; if `backfillStatus === "complete"` and `--force`
 *      is not set, return `skipped`.
 *   2. Write `backfillStatus: "pending"` to state **first** so a
 *      crash mid-run leaves a recoverable marker.
 *   3. Call `adapter.backfill(source, ctx, deps, opts)`.
 *   4. On `AdapterError("backfill_unsupported", ...)` → return
 *      `backfill_skipped` (state untouched — adapter never claimed
 *      to support backfill).
 *   5. For each artifact in the result, convert to the unified
 *      `Artifact` envelope with `fetch_mode: "backfill"`,
 *      `backfill_event`, `backfill_range`, push to P2.
 *   6. Write final state atomically (per ADR §2.4 / §3.3) — last,
 *      and only after every artifact has been pushed. A P2 throw
 *      before this write leaves `backfillStatus: "pending"` for
 *      resume on next run.
 *
 * v1 caveats:
 *
 *   - The unstructured lane is **not** backfilled in this PR. The
 *     plan defers it explicitly. Unstructured sources passed in are
 *     skipped with a structured outcome.
 *   - Source types without vendor history (openapi, git_tracked_file)
 *     get `backfill_skipped` from the adapter throwing
 *     `backfill_unsupported`.
 */

import {
  type Artifact,
  type StructuredSource,
  type StructuredSourceType,
} from "@outpost/shared";

import {
  AdapterError,
  getStructuredAdapter,
  type AdapterContext,
  type BackfillOptions,
  type BackfillPlanEvent,
  type BackfillResult,
  type FetchLike,
  type NormalizedArtifact,
  type ReadEnvLike,
} from "../sources/structured/index.js";

import {
  loadOrInit,
  type SourceState,
  StateStore,
} from "./state-store.js";
import type { P2Receiver } from "./p2-receiver.js";

export interface StructuredBackfillResult {
  readonly status:
    | "success"
    | "skipped"
    | "failed"
    | "backfill_skipped";
  /** All artifacts pushed to P2 (only when status === "success"). */
  readonly artifacts: ReadonlyArray<Artifact>;
  /** The finalState written (only when status === "success"). */
  readonly finalState: { lastSeenVersion: string; lastSeenHash: string } | null;
  /** Stable error code (only when status === "failed"). */
  readonly errorCode: string | null;
  /** Human-readable diagnostic for the run log. */
  readonly message: string;
  /** Number of plan events the adapter produced. */
  readonly planEventCount: number;
  /** Number of observations dropped by the age filter. */
  readonly droppedObservationCount: number;
}

export interface StructuredBackfillOptions {
  readonly source: StructuredSource;
  readonly now: string;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
  };
  readonly state: StateStore;
  readonly p2: P2Receiver;
  /** Overrides for the backfill plan math. */
  readonly backfill?: Omit<BackfillOptions, "now">;
  /** Re-run even when `backfillStatus === "complete"`. */
  readonly force?: boolean;
}

/**
 * Generate a stable-ish run id. v1 uses `crypto.randomUUID` when
 * available (Node 19+), falls back to a timestamp-based id for
 * older runtimes / tests that stub it. The run id only needs to be
 * unique within a single source's state file — operators see it in
 * the run report when something crashes mid-pagination.
 */
function generateRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `run_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

export async function runStructuredBackfill(
  opts: StructuredBackfillOptions,
): Promise<StructuredBackfillResult> {
  const { source, now, deps, state, p2, backfill, force } = opts;

  // 1. Load existing state.
  let prev: SourceState;
  try {
    prev = await loadOrInit(state, source.id, "structured", now);
  } catch (cause) {
    return {
      status: "failed",
      artifacts: [],
      finalState: null,
      errorCode: "state_corrupt",
      message: `state file unreadable for ${source.id}: ${(cause as Error).message}`,
      planEventCount: 0,
      droppedObservationCount: 0,
    };
  }
  if (prev.kind !== "structured") {
    return {
      status: "failed",
      artifacts: [],
      finalState: null,
      errorCode: "state_corrupt",
      message: `state kind drift for ${source.id}`,
      planEventCount: 0,
      droppedObservationCount: 0,
    };
  }

  // 2. Skip when already complete (unless --force).
  if (prev.backfillStatus === "complete" && !force) {
    return {
      status: "skipped",
      artifacts: [],
      finalState: null,
      errorCode: null,
      message: `backfill already complete for ${source.id}; pass --force to re-run`,
      planEventCount: 0,
      droppedObservationCount: 0,
    };
  }

  // 3. Mark pending before doing any work. A crash here leaves
  // backfillStatus: "pending" — recoverable on next run.
  const runId = generateRunId();
  const pendingState: SourceState = {
    ...prev,
    backfillStatus: "pending",
    backfillRunId: runId,
    backfillStartedAt: now,
  };
  await state.write(pendingState);

  // 4. Invoke the adapter's backfill.
  const ctx: AdapterContext = {
    lastSeenVersion: prev.lastSeenVersion,
    lastSeenHash: prev.lastSeenHash,
    now,
  };
  const adapter = getStructuredAdapter(source.source_type);
  const backfillOpts: BackfillOptions = {
    now,
    ...(backfill ?? {}),
  };
  let result: BackfillResult;
  try {
    result = await adapter.backfill(source, ctx, deps, backfillOpts);
  } catch (err) {
    if (err instanceof AdapterError && err.code === "backfill_unsupported") {
      // Adapter never claimed to support backfill — revert pending
      // state to the previous shape so the operator can re-run
      // without `--force` later if the adapter gains support.
      await state.write({
        ...prev,
        backfillStatus: null,
        backfillRunId: null,
        backfillStartedAt: null,
      });
      return {
        status: "backfill_skipped",
        artifacts: [],
        finalState: null,
        errorCode: null,
        message: `${source.source_type} does not support backfill: ${err.message}`,
        planEventCount: 0,
        droppedObservationCount: 0,
      };
    }
    const code = err instanceof AdapterError ? err.code : "adapter_threw";
    return {
      status: "failed",
      artifacts: [],
      finalState: null,
      errorCode: code,
      message: `adapter ${source.source_type} for ${source.id} threw: ${(err as Error).message}`,
      planEventCount: 0,
      droppedObservationCount: 0,
    };
  }

  // 5. Convert NormalizedArtifacts → Artifact envelopes, zipping
  // each artifact with its corresponding plan event so the
  // envelope carries the real from/to/version_count metadata.
  const envelopes: Artifact[] = result.artifacts.map((raw, idx) => {
    const ev = result.plan.events[idx];
    if (!ev) {
      // Adapter returned more artifacts than plan events — adapter
      // bug. Surface as failure so operators can investigate.
      throw new Error(
        `adapter ${source.source_type} for ${source.id} returned ${result.artifacts.length} ` +
          `artifacts but only ${result.plan.events.length} plan events`,
      );
    }
    return backfillEnvelope(raw, ev);
  });

  // 6. Push to P2 — every artifact, in plan-event order. A throw
  // here leaves the pending state intact for resume.
  for (const env of envelopes) {
    let pushResult;
    try {
      pushResult = await p2.push(env);
    } catch (cause) {
      return {
        status: "failed",
        artifacts: [],
        finalState: null,
        errorCode: "p2_transport",
        message: `p2.push threw mid-backfill for ${source.id}: ${(cause as Error).message}`,
        planEventCount: result.plan.events.length,
        droppedObservationCount: result.plan.droppedObservations.length,
      };
    }
    if (!pushResult.ok) {
      return {
        status: "failed",
        artifacts: [],
        finalState: null,
        errorCode: "p2_rejected",
        message: `p2 rejected artifact mid-backfill for ${source.id}: ${pushResult.reason}`,
        planEventCount: result.plan.events.length,
        droppedObservationCount: result.plan.droppedObservations.length,
      };
    }
  }

  // 7. Atomic final write — last, only after every artifact pushed.
  const finalState: SourceState = {
    source_id: source.id,
    kind: "structured",
    lastSeenVersion: result.plan.finalState.lastSeenVersion,
    lastSeenHash: result.plan.finalState.lastSeenHash,
    lastPolledAt: now,
    pollCount: prev.pollCount + 1,
    backfillStatus: "complete",
    backfillRunId: runId,
    backfillStartedAt: now,
  };
  await state.write(finalState);

  return {
    status: "success",
    artifacts: envelopes,
    finalState: result.plan.finalState,
    errorCode: null,
    message: `pushed ${envelopes.length} backfill artifact(s) for ${source.id}`,
    planEventCount: result.plan.events.length,
    droppedObservationCount: result.plan.droppedObservations.length,
  };
}

/**
 * Convert a `NormalizedArtifact` from the backfill result into the
 * unified `Artifact` envelope, populating `fetch_mode`,
 * `backfill_event`, and `backfill_range` from the corresponding
 * plan event so downstream consumers see the actual from/to range
 * (not just the `to` version).
 */
function backfillEnvelope(
  raw: NormalizedArtifact,
  event: BackfillPlanEvent,
): Artifact {
  return {
    source_id: raw.source_id,
    source_type: raw.source_type as StructuredSourceType,
    unstructured_strategy: null,
    version: raw.version,
    content_hash: raw.content_hash,
    body: raw.raw_bytes,
    content_type: raw.raw_content_type,
    anchor: null,
    entry_id: null,
    detection_method: raw.detection_method,
    detected_at: raw.detected_at,
    fetch_provenance: {
      url: raw.fetch_metadata.url,
      auth: raw.fetch_metadata.auth,
      httpStatus: raw.fetch_metadata.status,
      fetchedAt: raw.detected_at,
    },
    fetch_mode: "backfill",
    backfill_event: event.type,
    backfill_range: {
      from: event.fromVersion,
      to: event.toVersion,
      ...(event.versionCount !== undefined
        ? { version_count: event.versionCount }
        : {}),
      confidence: event.type === "backfill_pair" ? "high" : "low",
    },
  };
}
