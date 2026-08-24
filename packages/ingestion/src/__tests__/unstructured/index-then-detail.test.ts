/**
 * Tests for the `index_then_detail` extraction strategy (Stripe).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import { getStrategy } from "../../sources/unstructured/strategy-registry.js";
import { noEnv, stubScrapeClient } from "./_helpers.js";

const source: UnstructuredSource = {
  id: "stripe.com/changelog",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "index_then_detail",
  strategy_config: {
    index_url: "https://stripe.com/changelog",
    entry_link_pattern: "^/changelog/[a-z]+/[0-9]{4}-[0-9]{2}-[0-9]{2}/",
  },
  fetch: {
    auth: "none",
    url: "https://stripe.com/changelog",
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["stripe.com"] },
  anchor_source: "url_slug",
  anchor_pattern: "/changelog/[a-z]+/([0-9]{4}-[0-9]{2}-[0-9]{2})/",
  firecrawl: true,
};

const INDEX_URL = "https://stripe.com/changelog";

describe("index_then_detail strategy", () => {
  it("extracts entry URLs from the index markdown and dedupes against lastSeenAnchors", async () => {
    const indexBody = [
      "# Stripe Changelog",
      "",
      "- [New event types](/changelog/dahlia/2026-08-20/event-types)",
      "- [Webhook updates](/changelog/cobra/2026-08-15/webhook-improvements)",
      "- [Old stuff](/changelog/old/2020-01-01/some-old-thing)",
    ].join("\n");

    const scrape = stubScrapeClient(new Map([[INDEX_URL, indexBody]]));
    const strategy = getStrategy("index_then_detail");

    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [
        // Pretend the old entry was already seen.
        {
          type: "date",
          source: "url_slug",
          value: "https://stripe.com/changelog/old/2020-01-01/some-old-thing",
        },
      ],
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
    });

    assert.equal(out.newItems.length, 2);
    const urls = out.newItems.map((i) => i.url);
    assert.ok(urls.includes("https://stripe.com/changelog/dahlia/2026-08-20/event-types"));
    assert.ok(urls.includes("https://stripe.com/changelog/cobra/2026-08-15/webhook-improvements"));
    assert.ok(!urls.some((u) => u.includes("2020-01-01")), "previously seen URL deduped");
  });

  it("fetchItem scrapes detail and sanitizes content", async () => {
    const strategy = getStrategy("index_then_detail");
    const detailBody = [
      "# Webhook updates",
      "",
      "We added 5 new event types.",
    ].join("\n");
    const scrape = stubScrapeClient(
      new Map([["https://stripe.com/changelog/cobra/2026-08-15/webhook-improvements", detailBody]]),
    );

    const out = await strategy.fetchItem({
      item: {
        itemId: "https://stripe.com/changelog/cobra/2026-08-15/webhook-improvements",
        url: "https://stripe.com/changelog/cobra/2026-08-15/webhook-improvements",
        metadata: null,
      },
      source,
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
    });

    assert.ok(out);
    assert.equal(out!.url, "https://stripe.com/changelog/cobra/2026-08-15/webhook-improvements");
    assert.equal(out!.contentType, "text/markdown");
    assert.ok(out!.contentHash.length > 0);
  });

  it("aborts when the index page is only bot-challenge chrome", async () => {
    const strategy = getStrategy("index_then_detail");
    const scrape = stubScrapeClient(new Map([[INDEX_URL, "hCaptcha challenge\nPlease verify you are human"]]));

    await assert.rejects(
      strategy.resolveItems({
        source,
        lastSeenAnchors: [],
        deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
      }),
      /returned only bot-challenge chrome/,
    );
  });

  it("returns null from fetchItem when detail page is bot-challenge", async () => {
    const strategy = getStrategy("index_then_detail");
    const scrape = stubScrapeClient(
      new Map([["https://stripe.com/changelog/x/y/z", "Please verify you are human\ncf-challenge page"]]),
    );

    const out = await strategy.fetchItem({
      item: { itemId: "x", url: "https://stripe.com/changelog/x/y/z", metadata: null },
      source,
      deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
    });

    assert.equal(out, null);
  });

  it("throws on invalid entry_link_pattern", async () => {
    const strategy = getStrategy("index_then_detail");
    const broken: UnstructuredSource = {
      ...source,
      strategy_config: { index_url: INDEX_URL, entry_link_pattern: "([" }, // unclosed bracket
    };
    const scrape = stubScrapeClient(new Map([[INDEX_URL, "any body"]]));
    await assert.rejects(
      strategy.resolveItems({
        source: broken,
        lastSeenAnchors: [],
        deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: noEnv, scrape },
      }),
      /invalid entry_link_pattern/,
    );
  });
});
