/**
 * Unstructured-lane host execution (PR 3 Slice 6).
 *
 * For one unstructured source: load state, run staleness sentinel,
 * call strategy.resolveItems → for each new ResolvedItem call
 * strategy.fetchItem → derive anchor → build Artifact → push to P2
 * → persist anchors + entry hashes.
 *
 * v1 emits AT MOST one artifact per resolved item, per poll cycle.
 * If the strategy resolves no new items (everything in lastSeenAnchors),
 * no artifacts are pushed and `status: "skipped"` is returned. The
 * state is still updated so we record "we polled; nothing new".
 *
 * Detection-method translation:
 *   - First poll         → `first_poll`
 *   - Entry hash matches → `entry_update`
 *   - Otherwise          → `new_entry`
 *
 * Staleness sentinel:
 *   - Run BEFORE resolveItems. If the source is stale (>90d idle
 *     by default; per-source override), emit a `stale_anchors`
 *     warning telemetry and SKIP the poll — don't burn an LLM call
 *     on a dead page.
 */

import type { Artifact, UnstructuredSource } from "@outpost/shared";

import {
  buildAnchorInput,
  deriveAnchor,
  getStrategy,
  type DerivedAnchor,
  type ExtractionTelemetry,
  type FetchItemInput,
  type FetchItemOutput,
  type ResolvedItem,
  type ResolveItemsInput,
  type ScrapeClient,
  StrategyExecutionError,
} from "../sources/unstructured/index.js";

import { checkStaleness } from "../sources/unstructured/staleness-sentinel.js";

import {
  loadOrInit,
  StateStore,
  type EntryState,
  type SourceState,
} from "./state-store.js";
import type { P2Receiver } from "./p2-receiver.js";
import type { FetchLike, ReadEnvLike } from "../sources/structured/types.js";

export interface UnstructuredRunResult {
  readonly status: "success" | "skipped" | "failed";
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly telemetry: ReadonlyArray<ExtractionTelemetry>;
  readonly errorCode: string | null;
  readonly message: string;
}

export interface UnstructuredRunOptions {
  readonly source: UnstructuredSource;
  readonly now: string;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
    readonly scrape: ScrapeClient;
  };
  readonly state: StateStore;
  readonly p2: P2Receiver;
}

interface InternalAnchor {
  readonly type: "version" | "date";
  readonly source: "url_slug" | "heading" | "inline_regex" | "feed_field" | "none";
  readonly value: string | null;
}

/**
 * Build the ResolveItemsInput from a state.
 *
 * The state carries `lastSeenAnchors` — anchors the host loop has
 * already seen. The strategy uses them for set-diff
 * (index_then_detail) or early-stop (paginated_index).
 */
function buildResolveItemsInput(
  source: UnstructuredSource,
  state: SourceState & { kind: "unstructured" },
  deps: { fetch: FetchLike; readEnv: ReadEnvLike; scrape: ScrapeClient },
  now: string,
): ResolveItemsInput {
  if (state.kind !== "unstructured") {
    // Unreachable, but TS needs it.
    throw new Error("unreachable: non-unstructured state in unstructured-lane runner");
  }
  return {
    source,
    lastSeenAnchors: state.lastSeenAnchors.map(
      (a): DerivedAnchor => ({
        type: a.type,
        source: a.source,
        value: a.value,
      }),
    ),
    deps,
  };
}

async function resolveAnchor(
  source: UnstructuredSource,
  item: ResolvedItem,
  payload: FetchItemOutput | null,
): Promise<DerivedAnchor> {
  const anchorInput = buildAnchorInput(source, item, payload);
  const anchor = deriveAnchor(
    {
      mechanism: source.anchor_source,
      pattern: source.anchor_pattern ?? null,
      strategy: source.extraction_strategy,
      source,
    },
    anchorInput,
  );
  if (anchor === null) {
    return { type: "date", source: "none", value: null };
  }
  return anchor;
}

export async function runUnstructuredSource(
  opts: UnstructuredRunOptions,
): Promise<UnstructuredRunResult> {
  const { source, now, deps, state, p2 } = opts;
  const telemetry: ExtractionTelemetry[] = [];

  // 1. Load existing state.
  let prev: SourceState;
  try {
    prev = await loadOrInit(state, source.id, "unstructured", now);
  } catch (cause) {
    return {
      status: "failed",
      artifacts: [],
      telemetry: [],
      errorCode: "state_corrupt",
      message: `state file unreadable for ${source.id}: ${(cause as Error).message}`,
    };
  }
  if (prev.kind !== "unstructured") {
    return {
      status: "failed",
      artifacts: [],
      telemetry: [],
      errorCode: "state_corrupt",
      message: `state kind drift for ${source.id}`,
    };
  }

  // 2. Staleness sentinel — skip if the page has been idle too long.
  const lastContentHashChangeAt = computeLastContentChangeAt(prev);
  const stalenessCheckInput = {
    sourceId: source.id,
    lastContentHashChangeAt,
    now,
    ...(source.staleness_sentinel?.max_inactivity_days !== undefined
      ? { maxInactivityDays: source.staleness_sentinel.max_inactivity_days }
      : {}),
  };
  const staleness = checkStaleness(stalenessCheckInput);
  if (staleness.state === "stale") {
    telemetry.push({
      level: "warning",
      event: "stale_anchors",
      sourceId: source.id,
      dropped: 0,
    });
    return {
      status: "skipped",
      artifacts: [],
      telemetry,
      errorCode: null,
      message: `source ${source.id} is stale (${staleness.daysInactive}d > ${staleness.thresholdDays}d threshold)`,
    };
  }

  // 3. Resolve items via the registered strategy.
  const strategy = getStrategy(source.extraction_strategy);
  const input = buildResolveItemsInput(source, prev, deps, now);
  let newItems: ReadonlyArray<ResolvedItem>;
  try {
    const result = await strategy.resolveItems(input);
    newItems = result.newItems;
  } catch (err) {
    const code = err instanceof StrategyExecutionError ? err.code : "strategy_threw";
    return {
      status: "failed",
      artifacts: [],
      telemetry,
      errorCode: code,
      message: `resolveItems threw for ${source.id}: ${(err as Error).message}`,
    };
  }

  // 4. Per-item fetch + anchor + push.
  const artifacts: Artifact[] = [];
  const newEntryStates: EntryState[] = [...prev.entries];
  const newAnchors: ReadonlyArray<InternalAnchor> = prev.lastSeenAnchors.map((a) => ({
    type: a.type,
    source: a.source,
    value: a.value,
  }));

  for (const item of newItems) {
    const fetchInput: FetchItemInput = { item, source, deps };
    let payload: FetchItemOutput | null;
    try {
      payload = await strategy.fetchItem(fetchInput);
    } catch (err) {
      // Per-item fetch failures are skipped, not fatal — the
      // strategy explicitly returned null for recoverable
      // errors. Anything thrown is logged + we move on.
      telemetry.push({
        level: "warning",
        event: "fetch_warning_bot_challenge",
        sourceId: source.id,
        itemId: item.itemId,
      });
      void err;
      continue;
    }
    if (payload === null) continue; // strategy's recoverable path
    const anchor = await resolveAnchor(source, item, payload);

    const isFirstEntry =
      prev.pollCount === 0 && !prev.entries.some((e) => e.entryId === item.itemId);
    const prevEntryHash =
      prev.entries.find((e) => e.entryId === item.itemId)?.contentHash ?? null;
    const isHashOnlyBump =
      prevEntryHash !== null && prevEntryHash === payload.contentHash;
    const detection_method: Artifact["detection_method"] = isFirstEntry
      ? "first_poll"
      : isHashOnlyBump
        ? "entry_update"
        : "new_entry";

    const artifact: Artifact = {
      source_id: source.id,
      source_type: null,
      unstructured_strategy: source.extraction_strategy,
      version:
        anchor.type === "version" && anchor.value !== null ? anchor.value : null,
      content_hash: payload.contentHash,
      body: payload.cleanedText,
      content_type: payload.contentType,
      anchor: {
        mechanism: anchor.source,
        value: anchor.value,
        type: anchor.type,
      },
      entry_id: item.itemId,
      detection_method,
      detected_at: payload.fetchTimestamp,
      fetch_provenance: {
        url: payload.url,
        auth: source.firecrawl ? "firecrawl_scrape" : "direct_https",
        httpStatus: null,
        fetchedAt: payload.fetchTimestamp,
      },
      fetch_mode: "incremental",
    };

    let pushResult;
    try {
      pushResult = await p2.push(artifact);
    } catch (cause) {
      telemetry.push({
        level: "warning",
        event: "fetch_warning_bot_challenge",
        sourceId: source.id,
        itemId: item.itemId,
      });
      void cause;
      continue;
    }
    if (!pushResult.ok) {
      return {
        status: "failed",
        artifacts,
        telemetry,
        errorCode: "p2_rejected",
        message: `p2 rejected artifact for ${source.id}/${item.itemId}: ${pushResult.reason}`,
      };
    }

    artifacts.push(artifact);
    newEntryStates.push({
      entryId: item.itemId,
      contentHash: payload.contentHash,
      lastSeenAt: payload.fetchTimestamp,
    });
    if (anchor.value !== null) {
      (newAnchors as Array<InternalAnchor>).push({
        type: anchor.type,
        source: anchor.source,
        value: anchor.value,
      });
    }
  }

  // 5. Persist new state.
  const next: SourceState = {
    source_id: source.id,
    kind: "unstructured",
    entries: dedupeEntries(newEntryStates),
    lastSeenAnchors: dedupeAnchors(newAnchors),
    lastPolledAt: now,
    pollCount: prev.pollCount + 1,
  };
  await state.write(next);

  return {
    status: newItems.length === 0 ? "skipped" : "success",
    artifacts,
    telemetry,
    errorCode: null,
    message:
      newItems.length === 0
        ? `no new items for ${source.id}`
        : `pushed ${artifacts.length}/${newItems.length} new items for ${source.id}`,
  };
}

function dedupeEntries(entries: EntryState[]): EntryState[] {
  const seen = new Map<string, EntryState>();
  // Reverse so latest-write-wins on the entry state map.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!seen.has(e.entryId)) seen.set(e.entryId, e);
  }
  return Array.from(seen.values());
}

function dedupeAnchors(anchors: ReadonlyArray<InternalAnchor>): InternalAnchor[] {
  const seen = new Map<string, InternalAnchor>();
  for (let i = anchors.length - 1; i >= 0; i--) {
    const a = anchors[i]!;
    if (a.value === null) continue; // skip none-mechanism
    if (!seen.has(a.value)) seen.set(a.value, a);
  }
  return Array.from(seen.values()).map((a) => ({
    type: a.type,
    source: a.source,
    value: a.value,
  }));
}

/**
 * The staleness sentinel wants "last time the content changed".
 * For unstructured sources we approximate that as the
 * `lastSeenAt` of the most recently-seen entry.
 */
function computeLastContentChangeAt(state: SourceState & { kind: "unstructured" }): string | null {
  let latest: string | null = null;
  for (const e of state.entries) {
    if (latest === null || e.lastSeenAt > latest) latest = e.lastSeenAt;
  }
  return latest;
}
