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
  BackfillEventType,
  BackfillRange,
  DetectionMethod,
  DerivedAnchorEnvelope,
  FetchMode,
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

describe("FetchMode", () => {
  it("is a closed union of 'incremental' | 'backfill'", () => {
    const exhaustive = (m: FetchMode): string => {
      switch (m) {
        case "incremental":
          return "normal polling path";
        case "backfill":
          return "first-time-onboarding history capture";
      }
    };
    assert.equal(exhaustive("incremental"), "normal polling path");
    assert.equal(exhaustive("backfill"), "first-time-onboarding history capture");
  });
});

describe("BackfillEventType", () => {
  it("is a closed union of 'backfill_pair' | 'backfill_hop'", () => {
    const exhaustive = (m: BackfillEventType): string => {
      switch (m) {
        case "backfill_pair":
          return "consecutive-version artifact (recent window, high confidence)";
        case "backfill_hop":
          return "collapsed-range artifact (older, low confidence)";
      }
    };
    assert.equal(
      exhaustive("backfill_pair"),
      "consecutive-version artifact (recent window, high confidence)",
    );
    assert.equal(
      exhaustive("backfill_hop"),
      "collapsed-range artifact (older, low confidence)",
    );
  });
});

describe("BackfillRange", () => {
  it("requires from/to/confidence; version_count is hop-only", () => {
    const pair: BackfillRange = {
      from: "1.0.0",
      to: "1.0.1",
      confidence: "high",
    };
    const hop: BackfillRange = {
      from: "0.5.0",
      to: "0.9.0",
      version_count: 4,
      confidence: "low",
    };
    assert.equal(pair.confidence, "high");
    assert.equal(hop.version_count, 4);
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
      fetch_mode: "incremental",
    };
    assert.equal(a.anchor, null);
    assert.equal(a.source_type, "github_releases");
    assert.equal(a.fetch_mode, "incremental");
    assert.equal(a.backfill_event, undefined);
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
      fetch_mode: "incremental",
    };
    assert.equal(a.source_type, null);
    assert.equal(a.anchor?.value, "2026-08-20");
    assert.equal(a.fetch_mode, "incremental");
  });

  it("can represent a backfill pair artifact with range metadata", () => {
    const a: Artifact = {
      source_id: "registry.npmjs.org/axios",
      source_type: "npm",
      unstructured_strategy: null,
      version: "1.6.0",
      content_hash: "pair-hash",
      body: "{...full npm doc...}",
      content_type: "application/json",
      anchor: null,
      entry_id: null,
      detection_method: "version_bump",
      detected_at: "2026-08-28T12:00:00.000Z",
      fetch_provenance: {
        url: "https://registry.npmjs.org/axios",
        auth: "none",
        httpStatus: 200,
        fetchedAt: "2026-08-28T12:00:00.000Z",
      },
      fetch_mode: "backfill",
      backfill_event: "backfill_pair",
      backfill_range: { from: "1.5.0", to: "1.6.0", confidence: "high" },
    };
    assert.equal(a.fetch_mode, "backfill");
    assert.equal(a.backfill_event, "backfill_pair");
    assert.equal(a.backfill_range?.confidence, "high");
  });

  it("can represent a backfill hop artifact with version_count", () => {
    const a: Artifact = {
      source_id: "registry.npmjs.org/axios",
      source_type: "npm",
      unstructured_strategy: null,
      version: "0.9.0",
      content_hash: "hop-hash",
      body: "{...full npm doc, range annotated...}",
      content_type: "application/json",
      anchor: null,
      entry_id: null,
      detection_method: "version_bump",
      detected_at: "2026-08-28T12:00:00.000Z",
      fetch_provenance: {
        url: "https://registry.npmjs.org/axios",
        auth: "none",
        httpStatus: 200,
        fetchedAt: "2026-08-28T12:00:00.000Z",
      },
      fetch_mode: "backfill",
      backfill_event: "backfill_hop",
      backfill_range: {
        from: "0.5.0",
        to: "0.9.0",
        version_count: 4,
        confidence: "low",
      },
    };
    assert.equal(a.backfill_event, "backfill_hop");
    assert.equal(a.backfill_range?.version_count, 4);
  });
});
