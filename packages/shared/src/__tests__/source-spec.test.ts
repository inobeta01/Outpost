/**
 * Tests for @outpost/source-spec.
 *
 * Three goals:
 *   1. Every example source under `sources/` validates successfully.
 *      If it doesn't, the schema is wrong.
 *   2. Every example source carries the required structured-lane
 *      (`source_type`) or unstructured-lane (`extraction_strategy`)
 *      discriminator that PR 2 dispatches on.
 *   3. A handful of intentionally bad inputs are rejected with
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
  type AnchorSource,
  type ExtractionStrategy,
  type StructuredSourceType,
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

const STRUCTURED_TYPES: ReadonlySet<StructuredSourceType> = new Set([
  "openapi",
  "npm",
  "pypi",
  "github_releases",
  "git_tracked_file",
]);

const STRATEGIES: ReadonlySet<ExtractionStrategy> = new Set([
  "single_page",
  "index_then_detail",
  "paginated_index",
  "raw_file",
  "rss",
]);

const ANCHOR_SOURCES: ReadonlySet<AnchorSource> = new Set([
  "url_slug",
  "heading",
  "inline_regex",
  "feed_field",
  "none",
]);

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

  it("every example carries the PR 2 dispatch fields", async () => {
    const sources = await listExampleSources();
    for (const { relPath, spec } of sources) {
      if (isStructured(spec)) {
        assert.ok(
          STRUCTURED_TYPES.has(spec.source_type),
          `${relPath}: structured.source_type must be a closed enum value, got ${spec.source_type}`,
        );
        assert.ok(
          spec.security.allowed_domains.length >= 1,
          `${relPath}: structured.security.allowed_domains must be non-empty`,
        );
      } else {
        assert.ok(
          STRATEGIES.has(spec.extraction_strategy),
          `${relPath}: unstructured.extraction_strategy must be a closed enum value, got ${spec.extraction_strategy}`,
        );
        assert.ok(
          ANCHOR_SOURCES.has(spec.anchor_source),
          `${relPath}: unstructured.anchor_source must be a closed enum value, got ${spec.anchor_source}`,
        );
        assert.ok(
          spec.security.allowed_domains.length >= 1,
          `${relPath}: unstructured.security.allowed_domains must be non-empty`,
        );
      }
    }
  });

  it("covers at least 2 distinct structured source_types and 1 strategy", async () => {
    const sources = await listExampleSources();
    const types = new Set<StructuredSourceType>();
    const strategies = new Set<ExtractionStrategy>();
    for (const { spec } of sources) {
      if (isStructured(spec)) types.add(spec.source_type);
      else strategies.add(spec.extraction_strategy);
    }
    assert.ok(types.size >= 2, `expected ≥2 distinct structured source_types, got ${types.size}`);
    assert.ok(strategies.size >= 1, `expected ≥1 extraction_strategy, got ${strategies.size}`);
  });
});

describe("validation rejects bad inputs", () => {
  it("rejects a structured source missing source_type", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      security: { allowed_domains: ["example.com"] },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects a structured source missing security.allowed_domains", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      source_type: "openapi",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an empty security.allowed_domains array", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      source_type: "openapi",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      security: { allowed_domains: [] },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects a structured source with firecrawl=true", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      source_type: "openapi",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      security: { allowed_domains: ["example.com"] },
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an http (non-https) URL", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      source_type: "openapi",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "http://example.com/api", kind: "list" },
      },
      security: { allowed_domains: ["example.com"] },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an unknown auth mode", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "structured",
      owner: "@a",
      source_type: "openapi",
      fetch: { auth: "embedded_api_key" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      security: { allowed_domains: ["example.com"] },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects a source with id in the wrong shape", async () => {
    const bad = {
      id: "Has Spaces And Uppercase",
      kind: "structured",
      owner: "@a",
      source_type: "openapi",
      fetch: { auth: "none" },
      endpoints: {
        x: { url: "https://example.com/api", kind: "list" },
      },
      security: { allowed_domains: ["example.com"] },
      firecrawl: false,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an unstructured source missing extraction_strategy", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "unstructured",
      owner: "@a",
      fetch: { auth: "none", url: "https://example.com/changelog", type: "firecrawl", fetch_method: "scrape" },
      security: { allowed_domains: ["example.com"] },
      anchor_source: "url_slug",
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects an unstructured source missing anchor_source", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "unstructured",
      owner: "@a",
      extraction_strategy: "single_page",
      fetch: { auth: "none", url: "https://example.com/changelog", type: "firecrawl", fetch_method: "scrape" },
      security: { allowed_domains: ["example.com"] },
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects fetch_method other than 'scrape'", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "unstructured",
      owner: "@a",
      extraction_strategy: "single_page",
      fetch: { auth: "none", url: "https://example.com/changelog", type: "firecrawl", fetch_method: "crawl" },
      security: { allowed_domains: ["example.com"] },
      anchor_source: "url_slug",
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("rejects a non-positive staleness_sentinel.max_inactivity_days", async () => {
    const bad = {
      id: "example.com/bad",
      kind: "unstructured",
      owner: "@a",
      extraction_strategy: "single_page",
      fetch: { auth: "none", url: "https://example.com/changelog", type: "firecrawl", fetch_method: "scrape" },
      security: { allowed_domains: ["example.com"] },
      anchor_source: "url_slug",
      staleness_sentinel: { max_inactivity_days: 0 },
      firecrawl: true,
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });
});

describe("enrichment (version-join)", () => {
  const baseStructured = {
    id: "pypi/requests",
    kind: "structured" as const,
    owner: "@a",
    source_type: "pypi" as const,
    fetch: { auth: "none" as const },
    endpoints: {
      package: { url: "https://pypi.org/pypi/requests/json", kind: "object" as const },
    },
    security: { allowed_domains: ["pypi.org"] },
    firecrawl: false,
  };

  it("accepts a valid enrichment block with index_then_detail", async () => {
    const good = {
      ...baseStructured,
      enrichment: {
        strategy: "index_then_detail" as const,
        endpoint_url: "https://example.com/changelog",
        strategy_config: {
          index_url: "https://example.com/changelog",
          entry_link_pattern: "^/v[0-9-]+$",
        },
        anchor_source: "url_slug" as const,
        anchor_pattern: "/v([0-9-]+)",
      },
    };
    const spec = await validateSourceSpec(good);
    assert.equal(spec.kind, "structured");
    if (spec.kind === "structured") {
      assert.ok(spec.enrichment, "enrichment block must be present");
      assert.equal(spec.enrichment.strategy, "index_then_detail");
      assert.equal(spec.enrichment.anchor_source, "url_slug");
    }
  });

  it("accepts a valid enrichment block with rss", async () => {
    const good = {
      ...baseStructured,
      enrichment: {
        strategy: "rss" as const,
        endpoint_url: "https://example.com/feed.xml",
        strategy_config: { rss_url: "https://example.com/feed.xml" },
        anchor_source: "inline_regex" as const,
        anchor_pattern: "v([0-9.]+)",
      },
    };
    const spec = await validateSourceSpec(good);
    assert.equal(spec.kind, "structured");
    if (spec.kind === "structured") {
      assert.equal(spec.enrichment?.strategy, "rss");
    }
  });

  it("rejects enrichment with single_page (no per-entry resolution)", async () => {
    const bad = {
      ...baseStructured,
      enrichment: {
        strategy: "single_page" as const,
        endpoint_url: "https://example.com/changelog",
        strategy_config: { index_url: "https://example.com/changelog" },
        anchor_source: "url_slug" as const,
        anchor_pattern: "v([0-9.]+)",
      },
    };
    await assert.rejects(validateSourceSpec(bad), (err: unknown) => {
      assert.ok(err instanceof SourceSpecValidationError);
      const message = (err as Error).message;
      assert.ok(
        message.includes("single_page") && message.includes("not supported"),
        `expected rejection message to mention single_page and "not supported", got: ${message}`,
      );
      return true;
    });
  });

  it("rejects enrichment with raw_file (no per-entry resolution)", async () => {
    const bad = {
      ...baseStructured,
      enrichment: {
        strategy: "raw_file" as const,
        endpoint_url: "https://example.com/CHANGES.md",
        strategy_config: { file_url: "https://example.com/CHANGES.md" },
        anchor_source: "url_slug" as const,
        anchor_pattern: "v([0-9.]+)",
      },
    };
    await assert.rejects(validateSourceSpec(bad), (err: unknown) => {
      assert.ok(err instanceof SourceSpecValidationError);
      const message = (err as Error).message;
      assert.ok(
        message.includes("raw_file") && message.includes("not supported"),
        `expected rejection message to mention raw_file and "not supported", got: ${message}`,
      );
      return true;
    });
  });

  it("rejects an enrichment block missing required fields", async () => {
    const bad = {
      ...baseStructured,
      enrichment: {
        strategy: "index_then_detail" as const,
        // missing endpoint_url, anchor_source
      },
    };
    await assert.rejects(validateSourceSpec(bad), SourceSpecValidationError);
  });

  it("accepts a structured source without an enrichment block (default)", async () => {
    const spec = await validateSourceSpec(baseStructured);
    assert.equal(spec.kind, "structured");
    if (spec.kind === "structured") {
      assert.equal(spec.enrichment, undefined);
    }
  });
});
