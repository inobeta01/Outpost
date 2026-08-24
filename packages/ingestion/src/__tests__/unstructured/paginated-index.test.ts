/**
 * Tests for the `paginated_index` extraction strategy.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import { getStrategy } from "../../sources/unstructured/strategy-registry.js";
import { noEnv, stubScrapeClient } from "./_helpers.js";

const source: UnstructuredSource = {
  id: "twilio.com/web-changelog",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "paginated_index",
  strategy_config: {
    index_url: "https://twilio.com/changelog",
    pagination: { param: "page", max_pages: 5 },
  },
  fetch: {
    auth: "none",
    url: "https://twilio.com/changelog",
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["twilio.com"] },
  anchor_source: "url_slug",
  anchor_pattern: "/changelog/([0-9-]+)/",
  firecrawl: true,
};

describe("paginated_index strategy", () => {
  it("walks pages until it sees an anchor from lastSeenAnchors (early-stop)", async () => {
    const p1 = [
      "- [New release](/changelog/2026-08-22/a)",
      "- [Release](/changelog/2026-08-15/b)",
    ].join("\n");
    const p2 = [
      "- [Old](/changelog/2026-08-08/c)",
      "- [Older](/changelog/2026-08-01/d)",
    ].join("\n");

    const scrape = stubScrapeClient(
      new Map([
        ["https://twilio.com/changelog", p1],
        ["https://twilio.com/changelog?page=2", p2],
      ]),
    );
    const strategy = getStrategy("paginated_index");

    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [
        // Pretend the 2026-08-08 anchor is already-seen —
        // we should stop after page 2 returns it.
        { type: "date", source: "url_slug", value: "2026-08-08" },
      ],
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
    });

    const urls = out.newItems.map((i) => i.url);
    // Page 1 entries are new (anchors 2026-08-22, 2026-08-15).
    assert.ok(urls.includes("https://twilio.com/changelog/2026-08-22/a"));
    assert.ok(urls.includes("https://twilio.com/changelog/2026-08-15/b"));
    // Page 2 returns 2026-08-08 first → triggers early-stop, so
    // 2026-08-01 is NOT fetched.
    assert.ok(!urls.includes("https://twilio.com/changelog/2026-08-01/d"));
  });

  it("respects max_pages", async () => {
    const body = "- [entry](/changelog/2026-08-22/a)";
    const scrape = stubScrapeClient(new Map());
    scrape.scrape = (url: string) => {
      scrape.calls.push(url);
      return Promise.resolve({
        markdown: body,
        html: "",
        metadata: { title: null, sourceURL: url },
      });
    };

    const strategy = getStrategy("paginated_index");
    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [],
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
    });

    // Every page should be hit exactly once for max_pages = 5.
    assert.equal(scrape.calls.length, 5);
    assert.ok(scrape.calls.includes("https://twilio.com/changelog"));
    assert.ok(scrape.calls.includes("https://twilio.com/changelog?page=5"));
    assert.ok(out.newItems.length > 0);
  });
});
