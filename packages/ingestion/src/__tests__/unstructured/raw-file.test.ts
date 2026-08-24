/**
 * Tests for the `raw_file` extraction strategy (e.g. CHANGES.md on raw.githubusercontent.com).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import { getStrategy } from "../../sources/unstructured/strategy-registry.js";
import { noEnv, stubFetch } from "./_helpers.js";

const FILE_URL = "https://raw.githubusercontent.com/twilio/twilio-python/main/CHANGES.md";

const source: UnstructuredSource = {
  id: "github.com/twilio/twilio-python/CHANGES.md",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "raw_file",
  strategy_config: { file_url: FILE_URL },
  fetch: {
    auth: "none",
    url: FILE_URL,
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["raw.githubusercontent.com"] },
  anchor_source: "heading",
  anchor_pattern: "\\[(\\d+\\.\\d+\\.\\d+)\\]",
  firecrawl: true,
};

describe("raw_file strategy", () => {
  it("resolves exactly one item: the file URL itself", async () => {
    const strategy = getStrategy("raw_file");
    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [],
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape: {} as never },
    });
    assert.equal(out.newItems.length, 1);
    assert.equal(out.newItems[0]!.url, FILE_URL);
  });

  it("fetchItem hashes the raw file body and infers markdown content type", async () => {
    const body = "# CHANGES\n\n## [9.0.0] - 2026-08-01\n\nBreaking: dropped old API.\n";
    const fetch = stubFetch(body);
    const strategy = getStrategy("raw_file");

    const out = await strategy.fetchItem({
      item: { itemId: FILE_URL, url: FILE_URL, metadata: null },
      source,
      deps: { fetch, readEnv: noEnv, scrape: {} as never },
    });

    assert.ok(out);
    assert.equal(out!.url, FILE_URL);
    assert.equal(out!.contentType, "text/markdown");
    assert.equal(out!.cleanedText, body);
    assert.ok(out!.contentHash.length > 0);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0], FILE_URL);
  });

  it("returns null on 429 (rate-limited transient)", async () => {
    const fetch = stubFetch("", 429, false);
    const strategy = getStrategy("raw_file");
    const out = await strategy.fetchItem({
      item: { itemId: FILE_URL, url: FILE_URL, metadata: null },
      source,
      deps: { fetch, readEnv: noEnv, scrape: {} as never },
    });
    assert.equal(out, null);
  });

  it("throws on 404 (unrecoverable)", async () => {
    const fetch = stubFetch("", 404, false);
    const strategy = getStrategy("raw_file");
    await assert.rejects(
      strategy.fetchItem({
        item: { itemId: FILE_URL, url: FILE_URL, metadata: null },
        source,
        deps: { fetch, readEnv: noEnv, scrape: {} as never },
      }),
      /status 404/,
    );
  });

  it("aborts when the response is bot-challenge chrome", async () => {
    const fetch = stubFetch("Please verify you are human\ncf-challenge page");
    const strategy = getStrategy("raw_file");
    await assert.rejects(
      strategy.fetchItem({
        item: { itemId: FILE_URL, url: FILE_URL, metadata: null },
        source,
        deps: { fetch, readEnv: noEnv, scrape: {} as never },
      }),
      /returned only bot-challenge chrome/,
    );
  });
});
