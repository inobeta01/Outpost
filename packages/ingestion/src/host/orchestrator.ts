/**
 * Host-loop orchestrator (PR 3 Slice 7; PR 4 Slice 2 added backfill mode).
 *
 * Top-level entrypoint: `runIngestion(opts)` walks the sources
 * directory, validates each spec, and dispatches each source to
 * the right lane. Returns a `RunReport` covering every source's
 * outcome — successes, failures, skipped, plus spec-level
 * load failures. Per-source failures never fail the run.
 *
 * Two modes:
 *
 *   - `incremental` (default): each source gets a normal poll cycle.
 *     Two lanes — structured → `runStructuredSource`,
 *     unstructured → `runUnstructuredSource`.
 *   - `backfill`: each source gets a one-time backfill. Only
 *     structured sources with vendor history are backfilled in
 *     this PR; unstructured sources return `backfill_skipped`,
 *     and structured sources whose adapter throws
 *     `backfill_unsupported` (openapi, git_tracked_file) return
 *     the same.
 *
 * Both modes share:
 *   - the StateStore (per-source JSON files)
 *   - the P2Receiver (artifact handoff)
 *   - fetch / readEnv / scrape deps
 *
 * Wall-clock: `startedAt` is set when the run begins (now-as-passed,
 * since callers don't have a real clock to thread through);
 * `finishedAt` is set after the last source completes. Both fields
 * are now real wall-clock timestamps.
 */

import { readdir, readFile, rename, writeFile, mkdir } from "node:fs/promises";

import type { Artifact, SourceSpec } from "@outpost/shared";
import { isStructured, isUnstructured } from "@outpost/shared";

import type { BackfillOptions } from "../sources/structured/types.js";
import type { FetchLike, ReadEnvLike } from "../sources/structured/types.js";
import type { ScrapeClient } from "../sources/unstructured/strategy-registry.js";

import { runStructuredSource, type StructuredRunResult } from "./structured-lane.js";
import { runStructuredBackfill, type StructuredBackfillResult } from "./structured-backfill.js";
import { runEnrichment, type EnrichmentRunResult } from "./enrichment-lane.js";
import { runUnstructuredSource, type UnstructuredRunResult } from "./unstructured-lane.js";
import { InMemoryP2Receiver, type P2Receiver } from "./p2-receiver.js";
import { StateStore, type FsLike } from "./state-store.js";
import { loadSources, type LoadedSource, type LoadFailure } from "./source-loader.js";

export type PerSourceOutcome =
  | { readonly kind: "structured"; readonly file: string; readonly result: StructuredRunResult }
  | { readonly kind: "unstructured"; readonly file: string; readonly result: UnstructuredRunResult }
  | { readonly kind: "structured_backfill"; readonly file: string; readonly result: StructuredBackfillResult }
  | { readonly kind: "structured_enrichment"; readonly file: string; readonly result: EnrichmentRunResult };

export interface BackfillSummary {
  readonly sourcesBackfilled: number;
  readonly sourcesBackfillSkipped: number;
  readonly sourcesFailed: number;
  readonly sourcesSkipped: number;
  readonly totalArtifactsPushed: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface RunReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: "incremental" | "backfill";
  readonly outcomes: ReadonlyArray<PerSourceOutcome>;
  readonly loadFailures: ReadonlyArray<LoadFailure>;
  readonly summary: {
    readonly loaded: number;
    readonly succeeded: number;
    readonly skipped: number;
    readonly failed: number;
    readonly loadFailed: number;
    readonly artifactsPushed: number;
  };
  /** Only present when `mode === "backfill"`. */
  readonly backfillSummary?: BackfillSummary;
}

export interface RunIngestionOptions {
  readonly sourcesDir: string;
  readonly stateDir: string;
  readonly now: string;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
    readonly scrape: ScrapeClient;
  };
  /** Dispatch mode. Default `"incremental"`. */
  readonly mode?: "incremental" | "backfill";
  /** When `mode === "backfill"`, restrict to this single source id. */
  readonly backfillSourceId?: string;
  /** Overrides for the backfill plan math, passed to adapters. */
  readonly backfillOptions?: Omit<BackfillOptions, "now">;
  /** Re-run backfill even when `backfillStatus === "complete"`. */
  readonly backfillForce?: boolean;
  readonly p2?: P2Receiver;
  readonly fs?: FsLike & {
    readdir(p: string): Promise<Array<{ name: string; isFile: () => boolean }>>;
  };
}

/**
 * Node's default fs — readFile/writeFile/rename/mkdir with the
 * `FsLike` shape, plus `readdir` with the withFileTypes shape
 * the source loader needs. Tests inject their own.
 */
function realFsHybrid(): FsLike & {
  readdir(p: string): Promise<Array<{ name: string; isFile: () => boolean }>>;
} {
  return {
    readFile: (p) => readFile(p, "utf8"),
    writeFile: (p, d) => writeFile(p, d, "utf8"),
    rename: (f, t) => rename(f, t),
    mkdir: async (p, opts) => {
      await mkdir(p, opts);
    },
    readdir: async (p) => {
      const items = await readdir(p, { withFileTypes: true });
      return items
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, isFile: () => true }));
    },
  };
}

export async function runIngestion(opts: RunIngestionOptions): Promise<RunReport> {
  const mode = opts.mode ?? "incremental";
  const startedAt = new Date().toISOString();
  const fs = opts.fs ?? realFsHybrid();
  const p2 = opts.p2 ?? new InMemoryP2Receiver();
  const state = new StateStore({ baseDir: opts.stateDir, fs });

  await state.ensureDir();
  const loadReport = await loadSources(opts.sourcesDir, fs);

  // For backfill mode with a specific source id, filter to just
  // that source. The CLI flags it; otherwise the operator probably
  // wants to backfill everything that supports it. If the id
  // doesn't match anything, surface that as a synthetic load
  // failure in the report.
  const sourceIdFilter =
    mode === "backfill" && opts.backfillSourceId ? opts.backfillSourceId : null;
  const queue = sourceIdFilter
    ? loadReport.sources.filter((s) => s.spec.id === sourceIdFilter)
    : loadReport.sources;
  const extraLoadFailures: LoadFailure[] =
    sourceIdFilter && queue.length === 0
      ? [
          {
            file: sourceIdFilter,
            reason: "read_failed",
            cause: new Error(
              `backfill source id "${sourceIdFilter}" did not match any loaded source in ${opts.sourcesDir}`,
            ),
          },
        ]
      : [];
  const allLoadFailures: ReadonlyArray<LoadFailure> = [
    ...loadReport.failures,
    ...extraLoadFailures,
  ];

  const outcomes: PerSourceOutcome[] = [];
  for (const src of queue) {
    const sourceOutcomes = await dispatchOne(src, { ...opts, p2, state, mode });
    outcomes.push(...sourceOutcomes);
  }

  const finishedAt = new Date().toISOString();
  const allArtifacts: ReadonlyArray<Artifact> =
    p2 instanceof InMemoryP2Receiver ? p2.artifacts : [];

  const succeeded = outcomes.filter((o) => o.result.status === "success").length;
  const skipped = outcomes.filter((o) => o.result.status === "skipped").length;
  const failed = outcomes.filter((o) => o.result.status === "failed").length;

  let backfillSummary: BackfillSummary | undefined;
  if (mode === "backfill") {
    const warnings: string[] = [];
    let backfilled = 0;
    let backfillSkipped = 0;
    let backfillFailed = 0;
    let backfillSkippedAlready = 0;
    let artifactsPushedBackfill = 0;
    for (const o of outcomes) {
      if (o.kind !== "structured_backfill") continue;
      const r = o.result;
      if (r.status === "success") {
        backfilled++;
        artifactsPushedBackfill += r.artifacts.length;
        // Surface adapter warnings (e.g. PyPI detail-budget cap)
        // alongside the host's own summary warnings.
        for (const w of r.warnings) {
          warnings.push(`${o.file}: ${w}`);
        }
      } else if (r.status === "backfill_skipped") {
        backfillSkipped++;
        warnings.push(`${o.file}: ${r.message}`);
      } else if (r.status === "failed") {
        backfillFailed++;
        for (const w of r.warnings) {
          warnings.push(`${o.file}: ${w}`);
        }
        warnings.push(`${o.file}: ${r.message}`);
      } else if (r.status === "skipped") {
        backfillSkippedAlready++;
      }
    }
    backfillSummary = {
      sourcesBackfilled: backfilled,
      sourcesBackfillSkipped: backfillSkipped,
      sourcesFailed: backfillFailed,
      sourcesSkipped: backfillSkippedAlready,
      totalArtifactsPushed: artifactsPushedBackfill,
      warnings,
    };
  }

  const report: RunReport = {
    startedAt,
    finishedAt,
    mode,
    outcomes,
    loadFailures: allLoadFailures,
    summary: {
      loaded: loadReport.sources.length,
      succeeded,
      skipped,
      failed,
      loadFailed: allLoadFailures.length,
      artifactsPushed: allArtifacts.length,
    },
    ...(backfillSummary !== undefined ? { backfillSummary } : {}),
  };

  return report;
}

async function dispatchOne(
  src: LoadedSource,
  opts: RunIngestionOptions & {
    p2: P2Receiver;
    state: StateStore;
    mode: "incremental" | "backfill";
  },
): Promise<PerSourceOutcome[]> {
  const spec: SourceSpec = src.spec;

  if (opts.mode === "backfill") {
    if (isUnstructured(spec)) {
      // Unstructured backfill is deferred (per the plan). Return a
      // structured backfill result that signals the skip so the
      // operator sees the reason in the run report.
      const skippedResult: StructuredBackfillResult = {
        status: "backfill_skipped",
        artifacts: [],
        finalState: null,
        errorCode: null,
        message: `unstructured backfill is deferred; source ${spec.id} skipped`,
        planEventCount: 0,
        droppedObservationCount: 0,
        warnings: [],
      };
      return [
        {
          kind: "structured_backfill",
          file: src.file,
          result: skippedResult,
        },
      ];
    }
    if (isStructured(spec)) {
      const result = await runStructuredBackfill({
        source: spec,
        now: opts.now,
        deps: { fetch: opts.deps.fetch, readEnv: opts.deps.readEnv },
        state: opts.state,
        p2: opts.p2,
        ...(opts.backfillOptions !== undefined
          ? { backfill: opts.backfillOptions }
          : {}),
        ...(opts.backfillForce !== undefined
          ? { force: opts.backfillForce }
          : {}),
      });
      return [{ kind: "structured_backfill", file: src.file, result }];
    }
    throw new Error(`unknown source kind for ${src.file}`);
  }

  // mode === "incremental"
  if (isStructured(spec)) {
    const result = await runStructuredSource({
      source: spec,
      now: opts.now,
      deps: { fetch: opts.deps.fetch, readEnv: opts.deps.readEnv },
      state: opts.state,
      p2: opts.p2,
    });
    const outcomes: PerSourceOutcome[] = [
      { kind: "structured", file: src.file, result },
    ];
    // Run the enrichment lane (version-join) for sources that
    // declared an `enrichment` block. The enrichment is a side
    // effect of the structured detection: every poll, we re-fetch
    // the last K versions of enrichment to detect edits, plus
    // any pendingEnrichments from a previous transient failure.
    // If the structured source failed, skip enrichment (no point
    // looking up versions that we don't know about).
    if (spec.enrichment !== undefined && result.status !== "failed") {
      const enrichmentResult = await runEnrichment({
        source: spec,
        now: opts.now,
        deps: opts.deps,
        state: opts.state,
        p2: opts.p2,
      });
      outcomes.push({
        kind: "structured_enrichment",
        file: src.file,
        result: enrichmentResult,
      });
    }
    return outcomes;
  }
  if (isUnstructured(spec)) {
    const result = await runUnstructuredSource({
      source: spec,
      now: opts.now,
      deps: opts.deps,
      state: opts.state,
      p2: opts.p2,
    });
    return [{ kind: "unstructured", file: src.file, result }];
  }
  throw new Error(`unknown source kind for ${src.file}`);
}
