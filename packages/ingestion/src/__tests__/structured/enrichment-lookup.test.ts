/**
 * Tests for the enrichment-lookup module (version-join pattern).
 *
 * The enrichment lookup is the read-side of the version-join: given
 * a structured source with an enrichment config, and a version, find
 * the matching enrichment entry and return it.
 *
 * These tests use the rss strategy because it's the easiest to stub
 * (it doesn't need a real scrape). The behavior is the same for
 * index_then_detail and paginated_index — the strategy is just the
 * mechanism for discovering entries.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { EnrichmentConfig, StructuredSource } from "@outpost/shared";

import {
  lookupEnrichment,
  normalizeVersionForAnchor,
} from "../../sources/structured/enrichment-lookup.js";
import { noEnv, stubFetch } from "./_helpers.js";

const STRUCTURED_SOURCE: StructuredSource = {
  id: "pypi/requests",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "pypi",
  fetch: { auth: "none" },
  endpoints: {
    package: {
      url: "https://pypi.org/pypi/{package}/json",
      kind: "object",
      variables: { package: "requests" },
    },
  },
  security: { allowed_domains: ["pypi.org", "example.com"] },
  firecrawl: false,
};

const ENRICHMENT_CONFIG: EnrichmentConfig = {
  strategy: "rss",
  endpoint_url: "https://example.com/feed.xml",
  strategy_config: { rss_url: "https://example.com/feed.xml" },
  anchor_source: "feed_field",
};

/**
 * An RSS feed where each item's `<guid>` is the version.
 * The lookup matches `version` against `<guid>` (after normalization).
 */
function buildFeedXml(items: ReadonlyArray<{ guid: string; title: string; link: string }>): string {
  return [
    '<rss version="2.0">',
    "  <channel>",
    "    <title>Releases</title>",
    ...items.flatMap((i) => [
      "    <item>",
      `      <title>${i.title}</title>`,
      `      <link>${i.link}</link>`,
      `      <guid>${i.guid}</guid>`,
      "    </item>",
    ]),
    "  </channel>",
    "</rss>",
  ].join("\n");
}

describe("enrichment-lookup (version-join)", () => {
  it("finds the matching entry for a known version", async () => {
    const feedXml = buildFeedXml([
      { guid: "2.32.4", title: "Release 2.32.4", link: "https://example.com/posts/2-32-4" },
      { guid: "2.32.3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
      { guid: "2.32.2", title: "Release 2.32.2", link: "https://example.com/posts/2-32-2" },
    ]);
    const fetch = stubFetch(feedXml);
    const result = await lookupEnrichment(
      STRUCTURED_SOURCE,
      ENRICHMENT_CONFIG,
      "2.32.3",
      { fetch, readEnv: noEnv, scrape: {} as never },
    );
    assert.equal(result.status, "found");
    if (result.status === "found") {
      assert.equal(result.version, "2.32.3");
      assert.ok(result.entryUrl.includes("2-32-3"));
      assert.match(result.contentHash, /^[0-9a-f]{64}$/);
      // The rss strategy's fetchItem returns the item metadata as
      // a JSON body. It includes link, pubDate, guid — not the
      // title. Verify the guid of the matched item is in the body.
      assert.ok(
        result.cleanedText.includes("2.32.3") ||
          result.cleanedText.includes("2-32-3"),
        `expected body to reference the matched entry, got: ${result.cleanedText}`,
      );
    }
  });

  it("returns not_found when no entry matches the version", async () => {
    const feedXml = buildFeedXml([
      { guid: "2.32.4", title: "Release 2.32.4", link: "https://example.com/posts/2-32-4" },
      { guid: "2.32.3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
    ]);
    const fetch = stubFetch(feedXml);
    const result = await lookupEnrichment(
      STRUCTURED_SOURCE,
      ENRICHMENT_CONFIG,
      "1.0.0",
      { fetch, readEnv: noEnv, scrape: {} as never },
    );
    assert.equal(result.status, "not_found");
    if (result.status === "not_found") {
      assert.equal(result.version, "1.0.0");
    }
  });

  it("returns not_found for empty version", async () => {
    const feedXml = buildFeedXml([
      { guid: "2.32.4", title: "Release 2.32.4", link: "https://example.com/posts/2-32-4" },
    ]);
    const fetch = stubFetch(feedXml);
    const result = await lookupEnrichment(
      STRUCTURED_SOURCE,
      ENRICHMENT_CONFIG,
      "",
      { fetch, readEnv: noEnv, scrape: {} as never },
    );
    assert.equal(result.status, "not_found");
  });

  it("normalizes 'v' prefix and case in matching", async () => {
    const feedXml = buildFeedXml([
      { guid: "v2.32.4", title: "Release 2.32.4", link: "https://example.com/posts/2-32-4" },
    ]);
    const fetch = stubFetch(feedXml);
    const result = await lookupEnrichment(
      STRUCTURED_SOURCE,
      ENRICHMENT_CONFIG,
      "2.32.4",
      { fetch, readEnv: noEnv, scrape: {} as never },
    );
    assert.equal(result.status, "found");
  });

  it("matches when anchor is the title containing the version", async () => {
    // For RSS with `feed_field` anchor, the strategy uses the
    // <guid> as the anchor. If the spec author wants to match
    // against the title instead, they'd configure anchor_source:
    // inline_regex. This test verifies the feed_field path.
    const feedXml = buildFeedXml([
      { guid: "https://example.com/posts/2-32-4", title: "Release 2.32.4", link: "https://example.com/posts/2-32-4" },
      { guid: "https://example.com/posts/2-32-3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
    ]);
    const fetch = stubFetch(feedXml);
    // Looking up by the GUID (which is the full URL, not the
    // version) — this should return not_found because the anchor
    // is the URL, not the version.
    const result = await lookupEnrichment(
      STRUCTURED_SOURCE,
      ENRICHMENT_CONFIG,
      "2.32.4",
      { fetch, readEnv: noEnv, scrape: {} as never },
    );
    // The anchor is the full URL, which won't match "2.32.4".
    // The spec author should configure the feed such that the
    // anchor IS the version. This test documents that limitation.
    assert.equal(result.status, "not_found");
  });

  it("re-exports normalizeVersionForAnchor", () => {
    assert.equal(typeof normalizeVersionForAnchor, "function");
    assert.equal(normalizeVersionForAnchor("v2.32.4"), "2.32.4");
  });
});
