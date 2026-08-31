/**
 * Per-source state persistence (PR 3 host-loop state).
 *
 * Two lanes, two state shapes, one storage layer. The host loop
 * reads state for a source at the top of each poll and writes
 * state back at the bottom. This module is the JSON-file-backed
 * v1 implementation; Postgres is a future concern.
 *
 * State shapes:
 *
 *   - **Structured**: `lastSeenVersion` + `lastSeenHash`. The
 *     adapter needs both (ADR §5) to decide between
 *     `version_bump` and `hash_only`.
 *
 *   - **Unstructured**: `lastSeenHashes` (per entry_id) +
 *     `lastSeenAnchors` (per source). The strategy uses anchors
 *     for early-stop (paginated_index, index_then_detail) and
 *     hashes for entry-update detection.
 *
 * Common fields: `lastPolledAt` (ISO timestamp) and `pollCount`
 * (monotonic).
 *
 * Atomicity:
 *
 *   - Writes go to `{path}.tmp` first, then `rename`. POSIX
 *     guarantees `rename` is atomic on the same filesystem, which
 *     prevents partial reads if a previous run crashed mid-write.
 *
 *   - Reads do `readFile` + `JSON.parse`. We don't lock — the
 *     host loop is single-threaded in v1, and the sandbox is
 *     single-source at a time.
 *
 * Testability:
 *
 *   - `StateStore` takes an `fs` interface in its constructor;
 *     tests pass an in-memory map. The default ctor uses
 *     `node:fs/promises`.
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DerivedAnchor } from "../sources/unstructured/anchor/derive-anchor.js";

/** A single entry's last-seen signals (unstructured lane). */
export interface EntryState {
  /** The entry's stable id (URL or RSS guid). */
  readonly entryId: string;
  /** SHA-256 of the canonicalized body from the last successful fetch. */
  readonly contentHash: string;
  /** When this entry was last seen — for staleness detection. */
  readonly lastSeenAt: string;
}

/**
 * Per-version enrichment state. Tracks the last-seen content hash
 * for each version's enrichment entry, so the host loop can detect
 * edits and avoid re-fetching unchanged content.
 *
 * See [[Version-Join Architecture — Unstructured Enrichment Driven
 * by Structured Lane]] for the design.
 */
export interface EnrichmentState {
  /** The structured adapter's reported version (e.g. "2.32.4"). */
  readonly version: string;
  /** Content hash from the last successful enrichment fetch. `null` if not yet fetched. */
  readonly contentHash: string | null;
  /** When this enrichment was last seen (ISO-8601). `null` if not yet fetched. */
  readonly lastSeenAt: string | null;
}

/**
 * Per-source state. The discriminated union narrows per lane.
 * Adding a new field requires updating the JSON parser below.
 */
export type SourceState =
  | {
      readonly source_id: string;
      readonly kind: "structured";
      readonly lastSeenVersion: string | null;
      readonly lastSeenHash: string | null;
      readonly lastPolledAt: string;
      readonly pollCount: number;
      /**
       * Backfill lifecycle. `null` = never been backfilled;
       * `"pending"` = a backfill run started but didn't complete
       * (crash mid-run, P2 rejected, etc.); `"complete"` = backfill
       * succeeded and finalState was written.
       *
       * The structured lane reads this to decide whether to skip a
       * backfill call. The `--force` flag overrides `complete`.
       */
      readonly backfillStatus: BackfillStatus;
      /** Resume marker — pagination checkpoint, run id, etc. Adapter-specific. */
      readonly backfillRunId: string | null;
      /** ISO-8601 timestamp the backfill started. `null` until first run. */
      readonly backfillStartedAt: string | null;
      /**
       * Opaque adapter-specific resume marker (github_releases
       * pagination page). Persisted when a backfill stops early —
       * mid-pagination failure or budget hit — so the next run
       * resumes instead of restarting. `null` when nothing to resume.
       */
      readonly backfillCheckpoint: string | null;
      /**
       * Per-version enrichment state (version-join). Empty for
       * sources without an `enrichment` block in the spec. Populated
       * as enrichment artifacts are produced.
       */
      readonly enrichments: ReadonlyArray<EnrichmentState>;
      /**
       * Versions whose enrichment fetch failed transiently (network
       * blip, 5xx). The next poll re-fetches these before looking up
       * new versions. `null` when no pending retries.
       */
      readonly pendingEnrichments: ReadonlyArray<string>;
      /**
       * ISO-8601 timestamp the last enrichment poll ran. `null` if
       * the source has no enrichment block or has never been polled
       * for enrichment. Used for staleness detection and for the
       * "re-fetch last K versions" logic.
       */
      readonly enrichmentLastRunAt: string | null;
    }
  | {
      readonly source_id: string;
      readonly kind: "unstructured";
      readonly entries: ReadonlyArray<EntryState>;
      readonly lastSeenAnchors: ReadonlyArray<DerivedAnchor>;
      readonly lastPolledAt: string;
      readonly pollCount: number;
    };

/** Backfill lifecycle states. See `SourceState.backfillStatus` for semantics. */
export type BackfillStatus = "pending" | "complete" | null;

/**
 * Initial state for a source. Used the first time we see a source.
 */
export function initialState(
  source_id: string,
  kind: "structured" | "unstructured",
  now: string,
): SourceState {
  if (kind === "structured") {
    return {
      source_id,
      kind: "structured",
      lastSeenVersion: null,
      lastSeenHash: null,
      lastPolledAt: now,
      pollCount: 0,
      backfillStatus: null,
      backfillRunId: null,
      backfillStartedAt: null,
      backfillCheckpoint: null,
      enrichments: [],
      pendingEnrichments: [],
      enrichmentLastRunAt: null,
    };
  }
  return {
    source_id,
    kind: "unstructured",
    entries: [],
    lastSeenAnchors: [],
    lastPolledAt: now,
    pollCount: 0,
  };
}

/**
 * File system shim. The default impl uses `node:fs/promises`;
 * tests pass an in-memory map.
 */
export interface FsLike {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
}

const realFs: FsLike = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, d) => writeFile(p, d, "utf8"),
  rename: (f, t) => rename(f, t),
  // mkdir with recursive:true returns the first-made directory or
  // undefined. Discard to satisfy the void-typed `FsLike.mkdir`.
  mkdir: async (p, opts) => {
    await mkdir(p, opts);
  },
};

/**
 * Marker file we'd write — but we just JSON.parse for v1.
 */
interface JsonFile {
  readonly version: 1;
  readonly state: SourceState;
}

/**
 * Verify a parsed object is a valid `SourceState`. Catches schema
 * drift between v1 and v2 of the JSON shape.
 */
function isSourceState(value: unknown): value is SourceState {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown };
  if (v.kind !== "structured" && v.kind !== "unstructured") return false;
  return typeof (v as { source_id?: unknown }).source_id === "string";
}

/**
 * Migrate older state-file shapes forward. Adds the backfill fields
 * (added in PR 4 Slice 2) and the enrichment fields (added in the
 * version-join slice) as their null/empty defaults when missing, so
 * pre-existing state files don't corrupt on first read.
 */
function migrateState(value: SourceState): SourceState {
  if (value.kind === "structured") {
    const v = value as {
      backfillStatus?: unknown;
      backfillRunId?: unknown;
      backfillStartedAt?: unknown;
      backfillCheckpoint?: unknown;
      enrichments?: unknown;
      pendingEnrichments?: unknown;
      enrichmentLastRunAt?: unknown;
    };
    return {
      ...value,
      backfillStatus:
        v.backfillStatus === "pending" || v.backfillStatus === "complete"
          ? (v.backfillStatus as "pending" | "complete")
          : null,
      backfillRunId:
        typeof v.backfillRunId === "string" ? v.backfillRunId : null,
      backfillStartedAt:
        typeof v.backfillStartedAt === "string" ? v.backfillStartedAt : null,
      backfillCheckpoint:
        typeof v.backfillCheckpoint === "string" ? v.backfillCheckpoint : null,
      enrichments: Array.isArray(v.enrichments)
        ? (v.enrichments as ReadonlyArray<EnrichmentState>)
        : [],
      pendingEnrichments: Array.isArray(v.pendingEnrichments)
        ? (v.pendingEnrichments as ReadonlyArray<string>)
        : [],
      enrichmentLastRunAt:
        typeof v.enrichmentLastRunAt === "string"
          ? v.enrichmentLastRunAt
          : null,
    };
  }
  return value;
}

export class StateStore {
  private readonly fs: FsLike;
  private readonly baseDir: string;

  constructor(opts: { baseDir: string; fs?: FsLike }) {
    this.baseDir = opts.baseDir;
    this.fs = opts.fs ?? realFs;
  }

  /** Path to the JSON file for a given source_id. */
  pathFor(source_id: string): string {
    // Hash the source_id with a stable encoding (URL-safe) so the
    // filesystem can handle special characters. We use the
    // replace-all-on-non-alphanumeric approach to keep v1 simple.
    const safe = source_id.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.baseDir, `${safe}.json`);
  }

  /** Ensure the base directory exists. Idempotent. */
  async ensureDir(): Promise<void> {
    await this.fs.mkdir(this.baseDir, { recursive: true });
  }

  /** Read state for a source. Returns `null` when no state file exists yet. */
  async read(source_id: string): Promise<SourceState | null> {
    const path = this.pathFor(source_id);
    let raw: string;
    try {
      raw = await this.fs.readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as JsonFile;
    if (!parsed || parsed.version !== 1 || !isSourceState(parsed.state)) {
      throw new Error(
        `corrupt state file for ${source_id} (version ${(parsed as { version?: unknown }).version}); ` +
          `delete the file to start fresh`,
      );
    }
    return migrateState(parsed.state);
  }

  /** Write state for a source. Atomic: writes to .tmp then renames. */
  async write(state: SourceState): Promise<void> {
    await this.ensureDir();
    const path = this.pathFor(state.source_id);
    const tmp = `${path}.tmp`;
    const payload: JsonFile = { version: 1, state };
    await this.fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await this.fs.rename(tmp, path);
  }
}

/**
 * Convenience: load existing state, or initial state if first poll.
 */
export async function loadOrInit(
  store: StateStore,
  source_id: string,
  kind: "structured" | "unstructured",
  now: string,
): Promise<SourceState> {
  const existing = await store.read(source_id);
  if (existing) {
    if (existing.kind !== kind) {
      throw new Error(
        `state-file kind mismatch for ${source_id}: ` +
          `disk=${existing.kind} expected=${kind}; ` +
          `delete the file to start fresh`,
      );
    }
    return existing;
  }
  return initialState(source_id, kind, now);
}
