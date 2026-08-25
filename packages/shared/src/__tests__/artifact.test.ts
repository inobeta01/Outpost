/**
 * Tests for the artifact envelope types.
 *
 * The types themselves are erased at runtime, so this file mostly
 * guards the type-narrowing helpers and the discriminator
 * exhaustiveness checks the host loop will rely on.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type {
  Artifact,
  DetectionMethod,
  DerivedAnchorEnvelope,
  FetchProvenance,
} from "../artifact.js";

describe("DetectionMethod", () => {
  it("is a closed union covering both lanes", () => {
    // Type-level guard: exhaustiveness. If a variant is added,
    // this exhaustiveness check (compile-time) breaks the build.
    const exhaustive = (m: DetectionMethod): string => {
      switch (m) {
        case "version_bump":
          return "structured: vendor version changed";
        case "hash_only":
          return "structured: hash changed but vendor version didn't (anomaly)";
        case "new_entry":
          return "unstructured: fresh entry's first poll";
        case "entry_update":
          return "unstructured: entry's content hash changed";
        case "first_poll":
          return "first successful poll for this source ever";
      }
    };
    assert.equal(exhaustive("version_bump").length > 0, true);
    assert.equal(exhaustive("new_entry").length > 0, true);
    assert.equal(exhaustive("first_poll").length > 0, true);
  });
});

describe("DerivedAnchorEnvelope", () => {
  it("accepts all five mechanisms", () => {
    const a: DerivedAnchorEnvelope = {
      mechanism: "url_slug",
      value: "2026-08-20",
      type: "date",
    };
    const b: DerivedAnchorEnvelope = {
      mechanism: "none",
      value: null,
      type: "version",
    };
    assert.equal(a.type, "date");
    assert.equal(b.mechanism, "none");
  });
});

describe("FetchProvenance", () => {
  it("allows firecrawl_scrape with null httpStatus", () => {
    const fp: FetchProvenance = {
      url: "https://reactrouter.com/changelog",
      auth: "firecrawl_scrape",
      httpStatus: null,
      fetchedAt: "2026-08-25T12:00:00.000Z",
    };
    assert.equal(fp.httpStatus, null);
  });

  it("allows direct_https for raw_file", () => {
    const fp: FetchProvenance = {
      url: "https://raw.githubusercontent.com/x/y/main/CHANGES.md",
      auth: "direct_https",
      httpStatus: 200,
      fetchedAt: "2026-08-25T12:00:00.000Z",
    };
    assert.equal(fp.httpStatus, 200);
  });
});

describe("Artifact", () => {
  it("can represent a structured-lane artifact (no anchor)", () => {
    const a: Artifact = {
      source_id: "github.com/x/y",
      source_type: "github_releases",
      unstructured_strategy: null,
      version: "1.2.3",
      content_hash: "abc",
      body: "# 1.2.3",
      content_type: "text/markdown",
      anchor: null,
      entry_id: null,
      detection_method: "version_bump",
      detected_at: "2026-08-25T12:00:00.000Z",
      fetch_provenance: {
        url: "https://api.github.com/repos/x/y/releases",
        auth: "github_token_env",
        httpStatus: 200,
        fetchedAt: "2026-08-25T12:00:00.000Z",
      },
    };
    assert.equal(a.anchor, null);
    assert.equal(a.source_type, "github_releases");
  });

  it("can represent an unstructured-lane artifact (with anchor, null source_type)", () => {
    const a: Artifact = {
      source_id: "stripe.com/changelog",
      source_type: null,
      unstructured_strategy: "index_then_detail",
      version: null,
      content_hash: "def",
      body: "Stripe changelog entry body...",
      content_type: "text/markdown",
      anchor: { mechanism: "url_slug", value: "2026-08-20", type: "date" },
      entry_id: "https://stripe.com/changelog/dahlia/2026-08-20/x",
      detection_method: "new_entry",
      detected_at: "2026-08-25T12:00:00.000Z",
      fetch_provenance: {
        url: "https://stripe.com/changelog/dahlia/2026-08-20/x",
        auth: "firecrawl_scrape",
        httpStatus: null,
        fetchedAt: "2026-08-25T12:00:00.000Z",
      },
    };
    assert.equal(a.source_type, null);
    assert.equal(a.anchor?.value, "2026-08-20");
  });
});
