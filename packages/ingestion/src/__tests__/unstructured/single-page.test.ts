/**
 * Tests for the `single_page` extraction strategy.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import { getStrategy } from "../../sources/unstructured/strategy-registry.js";
import { noEnv, stubScrapeClient } from "./_helpers.js";

const source: UnstructuredSource = {
  id: "reactrouter.com/changelog",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "single_page",
  strategy_config: { index_url: "https://reactrouter.com/changelog" },
  fetch: {
    auth: "none",
    url: "https://reactrouter.com/changelog",
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["reactrouter.com"] },
  anchor_source: "heading",
  anchor_pattern: "v?(\\d+\\.\\d+\\.\\d+)",
  firecrawl: true,
};

describe("single_page strategy", () => {
  it("resolves exactly one item: the index URL itself", async () => {
    const strategy = getStrategy("single_page");
    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [],
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape: stubScrapeClient(new Map()) },
    });
    assert.equal(out.newItems.length, 1);
    assert.equal(out.newItems[0]!.url, "https://reactrouter.com/changelog");
    assert.equal(out.newItems[0]!.itemId, "https://reactrouter.com/changelog");
    assert.equal(out.anchors.length, 0);
  });

  it("fetchItem scrapes the URL and returns a hash + cleaned text", async () => {
    const strategy = getStrategy("single_page");
    const body = [
      "# React Router Changelog",
      "",
      "## v8.3.0",
      "",
      "Added new feature.",
      "",
      "## v8.2.0",
      "",
      "Fixed bug.",
    ].join("\n");

    const scrape = stubScrapeClient(new Map([["https://reactrouter.com/changelog", body]]));
    const item = { itemId: "https://reactrouter.com/changelog", url: "https://reactrouter.com/changelog", metadata: null };
    const out = await strategy.fetchItem({
      item,
      source,
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
    });
    assert.ok(out);
    assert.equal(out!.url, "https://reactrouter.com/changelog");
    assert.equal(out!.contentType, "text/markdown");
    assert.equal(out!.cleanedText, body);
    assert.ok(out!.contentHash.length > 0);
    assert.equal(scrape.calls.length, 1);
    assert.equal(scrape.calls[0], "https://reactrouter.com/changelog");
  });

  it("throws when the spec is missing index_url", async () => {
    const strategy = getStrategy("single_page");
    const broken: UnstructuredSource = { ...source, strategy_config: undefined };
    await assert.rejects(
      strategy.resolveItems({
        source: broken,
        lastSeenAnchors: [],
        deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape: stubScrapeClient(new Map()) },
      }),
      /requires strategy_config\.index_url/,
    );
  });
});
