/**
 * Tests for @outpost/source-spec.
 *
 * Two goals:
 *   1. Every example source under `sources/` validates successfully.
 *      If it doesn't, the schema is wrong.
 *   2. A handful of intentionally bad inputs are rejected with
 *      path-aware error messages — guards against future schema drift
 *      that loosens validation.
 *
 * Run with `pnpm --filter @outpost/shared test`. The package script
 * delegates to `node --test --import tsx/esm src/__tests__/*.test.ts`.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  isStructured,
  isUnstructured,
  SourceSpecValidationError,
  validateSourceSpec,
  type SourceSpec,
} from "../index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SOURCES_DIR = join(REPO_ROOT, "sources");

async function loadSource(relPath: string): Promise<unknown> {
  const path = join(SOURCES_DIR, relPath);
  return JSON.parse(await readFile(path, "utf8"));
}

async function listExampleSources(): Promise<
  Array<{ relPath: string; spec: SourceSpec }>
> {
  const out: Array<{ relPath: string; spec: SourceSpec }> = [];
  for (const kind of ["structured", "unstructured"]) {
    const dir = join(SOURCES_DIR, kind);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const relPath = join(kind, file);
      const spec = await validateSourceSpec(await loadSource(relPath));
      out.push({ relPath, spec });
    }
  }
  return out;
}

describe("example sources", () => {
  it("validates every JSON file under sources/", async () => {
    const sources = await listExampleSources();
    assert.ok(sources.length >= 5, `expected at least 5 example sources, found ${sources.length}`);
    for (const { relPath, spec } of sources) {
      assert.ok(spec.id, `${relPath}: missing id`);
      assert.ok(spec.owner, `${relPath}: missing owner`);
      assert.ok(
        spec.kind === "structured" || spec.kind === "unstructured",
        `${relPath}: bad kind ${spec.kind}`,
      );
    }
  });

  it("discriminates structured vs unstructured via kind", async () => {
    const sources = await listExampleSources();
    const structured = sources.filter(({ spec }) => isStructured(spec));
    const unstructured = sources.filter(({ spec }) => isUnstructured(spec));
    assert.ok(structured.length >= 4, "expected ≥4 structured examples");
    assert.ok(unstructured.length >= 1, "expected ≥1 unstructured example");
  });
});

describe("validation rejects bad inputs", () => {
  it("rejects missing required fields", async () => {
    await assert.rejects(
      validateSourceSpec({ id: "x", kind: "structured", owner: "@a", fetch: { auth: "none" } }),
      (err: unknown) => {
        assert.ok(err instanceof SourceSpecValidationError);
        assert.ok(err.issues.length > 0);
        return true;
      },
    );
  });

  it("rejects an unstructured source missing selectors", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "unstructured",
      owner: "@a",
      fetch: { auth: "none", url: "https://example.com/changelog", type: "firecrawl" },
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects a structured source with firecrawl=true", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an http (non-https) URL", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "http://example.com/api", kind: "list" },
      },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an unknown auth mode", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      fetch: { auth: "embedded_api_key" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects a source with id in the wrong shape", async () => {
    const bad = {
      id: "Has Spaces And Uppercase",
      kind: "structured",
      owner: "@a",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });
});
