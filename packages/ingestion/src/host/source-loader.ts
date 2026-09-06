/**
 * Source-spec loader — PR 3 first stage of the host loop.
 *
 * Walks a directory of `*.json` files, parses each, validates
 * against the JSON Schema, and produces a typed work queue:
 * `[StructuredSource | UnstructuredSource]`.
 *
 * Validation happens at two layers:
 *
 *   1. JSON.parse — catches malformed JSON.
 *   2. `validateSourceSpec` (from @outpost/shared) — catches
 *      schema drift (typos in `source_type`, missing required
 *      fields, etc.).
 *
 * The loader is not the host loop's only validation step — the
 * registry's `getStructuredAdapter` / `getStrategy` will throw at
 * runtime if an adapter/strategy isn't registered. The loader's
 * job is just to fail fast on bad SPECs (a curated-set PR-time
 * concern, not a runtime concern).
 *
 * Filesystem is injectable (FsLike) for tests. The directory must
 * exist; the loader doesn't auto-create it.
 */

import type { SourceSpec } from "@outpost/shared";
import { validateSourceSpec, SourceSpecValidationError } from "@outpost/shared";

import type { FsLike } from "./state-store.js";

export interface LoadedSource {
  /** The basename (e.g. "stripe-changelog.json") of the source's file. */
  readonly file: string;
  /** The validated spec. */
  readonly spec: SourceSpec;
}

export type LoadFailure =
  | { readonly file: string; readonly reason: "read_failed"; readonly cause: unknown }
  | { readonly file: string; readonly reason: "parse_failed"; readonly cause: unknown }
  | { readonly file: string; readonly reason: "validation_failed"; readonly cause: unknown };

export interface LoadReport {
  readonly sources: ReadonlyArray<LoadedSource>;
  readonly failures: ReadonlyArray<LoadFailure>;
}

/**
 * List `*.json` files in a directory. We deliberately don't use
 * `fs.glob` / `fs.readdir` with type filters — Node's `readdir`
 * with `withFileTypes: true` is enough. Hidden files (starting
 * with `.`) are skipped.
 */
async function listJsonFiles(
  dir: string,
  fs: FsLike & { readdir?: (p: string) => Promise<Array<{ name: string; isFile: () => boolean }>> },
): Promise<string[]> {
  if (!fs.readdir) {
    // The "real" fs is passed in via `FsLike` which DOESN'T have
    // readdir; the orchestrator wraps node:fs/promises's readdir
    // via `loadSources` below. Tests provide their own readdir.
    throw new Error("fs.readdir missing — wrap node:fs/promises's readdir");
  }
  const entries = await fs.readdir(dir);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => e.name);
}

/**
 * Load and validate every `*.json` source spec in `dir`. Failures
 * are reported, not thrown — the host loop decides whether a
 * particular failure is fatal or skippable.
 *
 * Note: `state-store.ts` defines `FsLike` (readFile/writeFile/rename/mkdir).
 * Here we widen it with `readdir` because the source loader has a
 * different surface.
 */
export async function loadSources(
  dir: string,
  fs: FsLike & {
    readdir(p: string): Promise<Array<{ name: string; isFile: () => boolean }>>;
  },
): Promise<LoadReport> {
  const files = await listJsonFiles(dir, fs);
  const sources: LoadedSource[] = [];
  const failures: LoadFailure[] = [];
  for (const file of files) {
    const fullPath = `${dir.replace(/\/$/, "")}/${file}`;
    let raw: string;
    try {
      raw = await fs.readFile(fullPath);
    } catch (cause) {
      failures.push({ file, reason: "read_failed", cause });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      failures.push({ file, reason: "parse_failed", cause });
      continue;
    }
    try {
      const spec = await validateSourceSpec(parsed);
      sources.push({ file, spec });
    } catch (err) {
      if (err instanceof SourceSpecValidationError) {
        failures.push({ file, reason: "validation_failed", cause: err });
      } else {
        failures.push({ file, reason: "validation_failed", cause: err });
      }
    }
  }
  return { sources, failures };
}
