/**
 * Host-loop orchestrator (PR 3 Slice 7).
 *
 * Top-level entrypoint: `runIngestion(opts)` walks the sources
 * directory, validates each spec, and dispatches each source to
 * the right lane. Returns a `RunReport` covering every source's
 * outcome — successes, failures, skipped, plus spec-level
 * load failures. Per-source failures never fail the run.
 *
 * Two lanes:
 *   - structured   → runStructuredSource
 *   - unstructured → runUnstructuredSource
 *
 * Both lanes share:
 *   - the StateStore (per-source JSON files)
 *   - the P2Receiver (artifact handoff)
 *   - fetch / readEnv / scrape deps
 */

import { readdir, readFile, rename, writeFile, mkdir } from "node:fs/promises";

import type { Artifact, SourceSpec } from "@outpost/shared";
import { isStructured, isUnstructured } from "@outpost/shared";

import type { FetchLike, ReadEnvLike } from "../sources/structured/types.js";
import type { ScrapeClient } from "../sources/unstructured/strategy-registry.js";

import { runStructuredSource, type StructuredRunResult } from "./structured-lane.js";
import { runUnstructuredSource, type UnstructuredRunResult } from "./unstructured-lane.js";
import { InMemoryP2Receiver, type P2Receiver } from "./p2-receiver.js";
import { StateStore, type FsLike } from "./state-store.js";
import { loadSources, type LoadedSource, type LoadFailure } from "./source-loader.js";

export type PerSourceOutcome =
  | { readonly kind: "structured"; readonly file: string; readonly result: StructuredRunResult }
  | { readonly kind: "unstructured"; readonly file: string; readonly result: UnstructuredRunResult };

export interface RunReport {
  readonly startedAt: string;
  readonly finishedAt: string;
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
  const startedAt = opts.now;
  const fs = opts.fs ?? realFsHybrid();
  const p2 = opts.p2 ?? new InMemoryP2Receiver();
  const state = new StateStore({ baseDir: opts.stateDir, fs });

  await state.ensureDir();
  const loadReport = await loadSources(opts.sourcesDir, fs);

  const outcomes: PerSourceOutcome[] = [];
  for (const src of loadReport.sources) {
    const outcome = await dispatchOne(src, { ...opts, p2, state });
    outcomes.push(outcome);
  }

  const finishedAt = opts.now;
  const allArtifacts: ReadonlyArray<Artifact> =
    p2 instanceof InMemoryP2Receiver ? p2.artifacts : [];

  return {
    startedAt,
    finishedAt,
    outcomes,
    loadFailures: loadReport.failures,
    summary: {
      loaded: loadReport.sources.length,
      succeeded: outcomes.filter((o) => o.result.status === "success").length,
      skipped: outcomes.filter((o) => o.result.status === "skipped").length,
      failed: outcomes.filter((o) => o.result.status === "failed").length,
      loadFailed: loadReport.failures.length,
      artifactsPushed: allArtifacts.length,
    },
  };
}

async function dispatchOne(
  src: LoadedSource,
  opts: RunIngestionOptions & { p2: P2Receiver; state: StateStore },
): Promise<PerSourceOutcome> {
  const spec: SourceSpec = src.spec;
  if (isStructured(spec)) {
    const result = await runStructuredSource({
      source: spec,
      now: opts.now,
      deps: { fetch: opts.deps.fetch, readEnv: opts.deps.readEnv },
      state: opts.state,
      p2: opts.p2,
    });
    return { kind: "structured", file: src.file, result };
  }
  if (isUnstructured(spec)) {
    const result = await runUnstructuredSource({
      source: spec,
      now: opts.now,
      deps: opts.deps,
      state: opts.state,
      p2: opts.p2,
    });
    return { kind: "unstructured", file: src.file, result };
  }
  throw new Error(`unknown source kind for ${src.file}`);
}
