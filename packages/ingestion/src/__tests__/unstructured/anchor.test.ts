/**
 * Tests for the anchor derivation module (ADR §10).
 *
 * Covers each anchor source in isolation, plus the dispatcher
 * `deriveAnchor` that picks the right impl based on the spec's
 * locked `anchor_source`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import {
  ANCHOR_PRECEDENCE,
  deriveAnchor,
  type AnchorSpec,
} from "../../sources/unstructured/anchor/derive-anchor.js";

const baseSource: UnstructuredSource = {
  id: "stripe.com/changelog",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "index_then_detail",
  fetch: {
    auth: "none",
    url: "https://stripe.com/changelog",
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["stripe.com"] },
  anchor_source: "url_slug",
  anchor_pattern: "/changelog/([a-z]+)/([0-9]{4}-[0-9]{2}-[0-9]{2})/",
  firecrawl: true,
};

const spec = (overrides: Partial<AnchorSpec> = {}): AnchorSpec => ({
  mechanism: baseSource.anchor_source,
  pattern: baseSource.anchor_pattern ?? null,
  strategy: baseSource.extraction_strategy,
  source: baseSource,
  ...overrides,
});

describe("url_slug anchor", () => {
  it("extracts the date from a Stripe-style changelog URL", () => {
    // Spec author must order capture groups so the version/date is
    // group 1 — that's the conventional "primary extraction".
    // The full Stripe URL also captures the codename, but the date
    // is the anchor value we surface.
    const result = deriveAnchor(
      spec({ mechanism: "url_slug", pattern: "/changelog/[a-z]+/([0-9]{4}-[0-9]{2}-[0-9]{2})/" }),
      {
        itemUrl: "https://stripe.com/changelog/dahlia/2026-08-20/new-api-events",
        itemBody: null,
        anchorPattern: "/changelog/[a-z]+/([0-9]{4}-[0-9]{2}-[0-9]{2})/",
        feedFields: null,
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "2026-08-20");
    assert.equal(result!.type, "date"); // not a semver shape
    assert.equal(result!.source, "url_slug");
  });

  it("returns null when the pattern doesn't match", () => {
    const result = deriveAnchor(
      spec({ mechanism: "url_slug", pattern: "/changelog/([0-9-]+)/" }),
      {
        itemUrl: "https://example.com/about",
        itemBody: null,
        anchorPattern: "/changelog/([0-9-]+)/",
        feedFields: null,
      },
    );
    assert.equal(result, null);
  });
});

describe("heading anchor", () => {
  it("extracts the version from a markdown heading", () => {
    const body = [
      "# Changelog",
      "",
      "## v8.3.0",
      "",
      "Added new feature.",
      "",
      "## v8.2.0",
      "",
      "Fixed bug.",
    ].join("\n");
    const result = deriveAnchor(
      spec({ mechanism: "heading", pattern: "v?(\\d+\\.\\d+\\.\\d+)" }),
      {
        itemUrl: "https://reactrouter.com/changelog",
        itemBody: body,
        anchorPattern: "v?(\\d+\\.\\d+\\.\\d+)",
        feedFields: null,
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "8.3.0");
    assert.equal(result!.type, "version");
    assert.equal(result!.source, "heading");
  });

  it("extracts the date from a markdown heading", () => {
    const body = "## 2026-05-10\n\nSome content here.";
    const result = deriveAnchor(
      spec({ mechanism: "heading", pattern: "(\\d{4}-\\d{2}-\\d{2})" }),
      {
        itemUrl: "https://example.com/changelog",
        itemBody: body,
        anchorPattern: "(\\d{4}-\\d{2}-\\d{2})",
        feedFields: null,
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "2026-05-10");
    assert.equal(result!.type, "date");
  });

  it("scans HTML headings as well as markdown", () => {
    const body = "<h2>v1.2.3</h2><p>New release</p>";
    const result = deriveAnchor(
      spec({ mechanism: "heading", pattern: "v?(\\d+\\.\\d+\\.\\d+)" }),
      {
        itemUrl: "https://example.com",
        itemBody: body,
        anchorPattern: "v?(\\d+\\.\\d+\\.\\d+)",
        feedFields: null,
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "1.2.3");
  });
});

describe("inline_regex anchor", () => {
  it("extracts the version from prose", () => {
    const body = "As of v2.4.1, the new behavior is enabled by default.";
    const result = deriveAnchor(
      spec({ mechanism: "inline_regex", pattern: "v(\\d+\\.\\d+\\.\\d+)" }),
      {
        itemUrl: "https://example.com",
        itemBody: body,
        anchorPattern: "v(\\d+\\.\\d+\\.\\d+)",
        feedFields: null,
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "2.4.1");
    assert.equal(result!.source, "inline_regex");
  });

  it("returns null when no match", () => {
    const body = "Nothing version-like in this text at all.";
    const result = deriveAnchor(
      spec({ mechanism: "inline_regex", pattern: "v(\\d+\\.\\d+\\.\\d+)" }),
      {
        itemUrl: "https://example.com",
        itemBody: body,
        anchorPattern: "v(\\d+\\.\\d+\\.\\d+)",
        feedFields: null,
      },
    );
    assert.equal(result, null);
  });
});

describe("feed_field anchor", () => {
  it("prefers pubDate when present", () => {
    const result = deriveAnchor(
      spec({ mechanism: "feed_field" }),
      {
        itemUrl: "https://example.com/post-1",
        itemBody: null,
        anchorPattern: null,
        feedFields: { pubDate: "Mon, 20 Aug 2026 15:30:00 GMT", guid: "https://example.com/post-1" },
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "Mon, 20 Aug 2026 15:30:00 GMT");
    assert.equal(result!.source, "feed_field");
  });

  it("falls back to guid when pubDate is absent", () => {
    const result = deriveAnchor(
      spec({ mechanism: "feed_field" }),
      {
        itemUrl: "https://example.com/post-1",
        itemBody: null,
        anchorPattern: null,
        feedFields: { pubDate: null, guid: "https://example.com/post-1" },
      },
    );
    assert.ok(result);
    assert.equal(result!.value, "https://example.com/post-1");
  });

  it("returns null when both pubDate and guid are missing", () => {
    const result = deriveAnchor(
      spec({ mechanism: "feed_field" }),
      {
        itemUrl: "https://example.com/post-1",
        itemBody: null,
        anchorPattern: null,
        feedFields: { pubDate: null, guid: null },
      },
    );
    assert.equal(result, null);
  });
});

describe("none anchor", () => {
  it("returns null (no anchor at all)", () => {
    const result = deriveAnchor(
      spec({ mechanism: "none" }),
      {
        itemUrl: "https://example.com",
        itemBody: "anything",
        anchorPattern: null,
        feedFields: null,
      },
    );
    assert.equal(result, null);
  });
});

describe("ANCHOR_PRECEDENCE", () => {
  it("matches the documented ADR §10.2 order", () => {
    assert.deepEqual(ANCHOR_PRECEDENCE, [
      "url_slug",
      "heading",
      "inline_regex",
      "feed_field",
      "none",
    ]);
  });
});
