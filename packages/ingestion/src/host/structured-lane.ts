/**
 * Structured-lane host execution (PR 3 Slice 5).
 *
 * For one structured source: load state, build `AdapterContext`,
 * call the adapter, on success convert the `NormalizedArtifact`
 * to the unified `Artifact` envelope + push to P2 + persist new
 * state. On failure: log + skip; the host loop never throws on
 * per-source failures (one bad source can't poison the run).
 *
 * v1: the structured lane always emits exactly one artifact per
 * poll — the whole source's content. (Multi-endpoint sources
 * split into per-endpoint artifacts in a future PR.)
 *
 * The detection-method translation:
 *   - `version_bump`  → `version_bump`
 *   - `hash_only`     → `hash_only`
 *   - first poll      → `first_poll`
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

export interface StructuredRunResult {
  /** What happened to this source in this poll cycle. */
  readonly status: "success" | "skipped" | "failed";
  /** The artifact pushed to P2 (only when status === "success"). */
  readonly artifact: Artifact | null;
  /** The stable error code (only when status === "failed"). */
  readonly errorCode: string | null;
  /** A human-readable diagnostic message for the run log. */
  readonly message: string;
}

export interface StructuredRunOptions {
  readonly source: StructuredSource;
  readonly now: string;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
  };
  readonly state: StateStore;
  readonly p2: P2Receiver;
}

export async function runStructuredSource(
  opts: StructuredRunOptions,
): Promise<StructuredRunResult> {
  const { source, now, deps, state, p2 } = opts;

  // 1. Load existing state (or initial state).
  let prev: SourceState;
  try {
    prev = await loadOrInit(state, source.id, "structured", now);
  } catch (cause) {
    return {
      status: "failed",
      artifact: null,
      errorCode: "state_corrupt",
      message: `state file unreadable for ${source.id}: ${(cause as Error).message}`,
    };
  }
  if (prev.kind !== "structured") {
    // Unreachable given loadOrInit's check, but TypeScript needs it.
    return {
      status: "failed",
      artifact: null,
      errorCode: "state_corrupt",
      message: `state kind drift for ${source.id}`,
    };
  }

  // 2. Build the AdapterContext with last-seen signals.
  const ctx: AdapterContext = {
    lastSeenVersion: prev.lastSeenVersion,
    lastSeenHash: prev.lastSeenHash,
    now,
  };

  // 3. Lookup + invoke the adapter.
  const adapter = getStructuredAdapter(source.source_type);
  let raw: NormalizedArtifact;
  try {
    raw = await adapter.fetch(source, ctx, deps);
  } catch (err) {
    const code = err instanceof AdapterError ? err.code : "adapter_threw";
    return {
      status: "failed",
      artifact: null,
      errorCode: code,
      message: `adapter ${source.source_type} for ${source.id} threw: ${(err as Error).message}`,
    };
  }

  // 4. Convert NormalizedArtifact to Artifact envelope.
  const isFirst = prev.pollCount === 0;
  const detection_method: Artifact["detection_method"] = isFirst
    ? "first_poll"
    : raw.detection_method;
  const artifact: Artifact = {
    source_id: raw.source_id,
    source_type: raw.source_type as StructuredSourceType,
    unstructured_strategy: null,
    version: raw.version,
    content_hash: raw.content_hash,
    body: raw.raw_bytes,
    content_type: raw.raw_content_type,
    anchor: null,
    entry_id: null,
    detection_method,
    detected_at: raw.detected_at,
    fetch_provenance: {
      url: raw.fetch_metadata.url,
      auth: raw.fetch_metadata.auth,
      httpStatus: raw.fetch_metadata.status,
      fetchedAt: raw.detected_at,
    },
    fetch_mode: "incremental",
  };

  // 5. Push to P2.
  let pushResult;
  try {
    pushResult = await p2.push(artifact);
  } catch (cause) {
    return {
      status: "failed",
      artifact: null,
      errorCode: "p2_transport",
      message: `p2.push threw for ${source.id}: ${(cause as Error).message}`,
    };
  }
  if (!pushResult.ok) {
    return {
      status: "failed",
      artifact: null,
      errorCode: "p2_rejected",
      message: `p2 rejected artifact for ${source.id}: ${pushResult.reason}`,
    };
  }

  // 6. Persist new state.
  const next: SourceState = {
    source_id: source.id,
    kind: "structured",
    lastSeenVersion: raw.version,
    lastSeenHash: raw.content_hash,
    lastPolledAt: now,
    pollCount: prev.pollCount + 1,
  };
  await state.write(next);

  return {
    status: "success",
    artifact,
    errorCode: null,
    message: `pushed ${raw.detection_method} artifact ${pushResult.artifactId} for ${source.id}`,
  };
}
