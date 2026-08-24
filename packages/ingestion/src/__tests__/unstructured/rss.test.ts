/**
 * Tests for the `rss` extraction strategy.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import { getStrategy } from "../../sources/unstructured/strategy-registry.js";
import { noEnv, stubFetch } from "./_helpers.js";

const FEED_URL = "https://www.twilio.com/engineering/feed";

const source: UnstructuredSource = {
  id: "twilio.com/engineering/feed",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "rss",
  strategy_config: { rss_url: FEED_URL },
  fetch: {
    auth: "none",
    url: FEED_URL,
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["twilio.com"] },
  anchor_source: "feed_field",
  firecrawl: true,
};

const FEED_XML = [
  '<rss version="2.0">',
  "  <channel>",
  "    <title>Twilio Engineering</title>",
  "    <item>",
  '      <title>Hello world</title>',
  '      <link>https://twilio.com/blog/a</link>',
  '      <pubDate>Mon, 22 Aug 2026 12:00:00 GMT</pubDate>',
  '      <guid>https://twilio.com/blog/a</guid>',
  "    </item>",
  "    <item>",
  '      <title>Second post</title>',
  '      <link>https://twilio.com/blog/b</link>',
  '      <pubDate>Mon, 15 Aug 2026 12:00:00 GMT</pubDate>',
  '      <guid>https://twilio.com/blog/b</guid>',
  "    </item>",
  "    <item>",
  '      <title>Old post</title>',
  '      <link>https://twilio.com/blog/c</link>',
  '      <pubDate>Mon, 01 Jan 2020 00:00:00 GMT</pubDate>',
  '      <guid>https://twilio.com/blog/c</guid>',
  "    </item>",
  "  </channel>",
  "</rss>",
].join("\n");

describe("rss strategy", () => {
  it("parses items, dedupes by guid, and threads metadata", async () => {
    const fetch = stubFetch(FEED_XML);
    const strategy = getStrategy("rss");

    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [
        // Pretend the 2020 post was already seen.
        { type: "date", source: "feed_field", value: "https://twilio.com/blog/c" },
      ],
      deps: { fetch, readEnv: noEnv, scrape: {} as never },
    });

    const urls = out.newItems.map((i) => i.url);
    assert.ok(urls.includes("https://twilio.com/blog/a"));
    assert.ok(urls.includes("https://twilio.com/blog/b"));
    assert.ok(!urls.includes("https://twilio.com/blog/c"));

    // Metadata thread-through.
    const aItem = out.newItems.find((i) => i.url === "https://twilio.com/blog/a");
    assert.ok(aItem);
    assert.equal(aItem!.metadata?.guid, "https://twilio.com/blog/a");
    assert.equal(aItem!.metadata?.pubDate, "Mon, 22 Aug 2026 12:00:00 GMT");
  });

  it("parses atom feeds too", async () => {
    const atom = [
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      "  <title>Acme Blog</title>",
      "  <entry>",
      '    <id>tag:acme.com,2026:post-1</id>',
      '    <link href="https://acme.com/posts/1"/>',
      "    <published>2026-08-22T12:00:00Z</published>",
      "    <title>Hello</title>",
      "  </entry>",
      "</feed>",
    ].join("\n");
    const fetch = stubFetch(atom);
    const strategy = getStrategy("rss");
    const out = await strategy.resolveItems({
      source,
      lastSeenAnchors: [],
      deps: { fetch, readEnv: noEnv, scrape: {} as never },
    });
    assert.equal(out.newItems.length, 1);
    assert.equal(out.newItems[0]!.url, "https://acme.com/posts/1");
    assert.equal(out.newItems[0]!.metadata?.guid, "tag:acme.com,2026:post-1");
    assert.equal(out.newItems[0]!.metadata?.pubDate, "2026-08-22T12:00:00Z");
  });

  it("fetchItem returns a JSON-encoded payload with the linked URL", async () => {
    const strategy = getStrategy("rss");
    const out = await strategy.fetchItem({
      item: {
        itemId: "https://twilio.com/blog/a",
        url: "https://twilio.com/blog/a",
        metadata: { pubDate: "Mon, 22 Aug 2026 12:00:00 GMT", guid: "https://twilio.com/blog/a" },
      },
      source,
      deps: { fetch: stubFetch(""), readEnv: noEnv, scrape: {} as never },
    });
    assert.ok(out);
    assert.equal(out!.url, "https://twilio.com/blog/a");
    assert.equal(out!.contentType, "application/rss+xml-item");
    assert.ok(out!.cleanedText.includes("twilio.com/blog/a"));
    assert.ok(out!.contentHash.length > 0);
  });

  it("aborts on bot-challenge feed response", async () => {
    const fetch = stubFetch("hCaptcha challenge\nPlease verify you are human");
    const strategy = getStrategy("rss");
    await assert.rejects(
      strategy.resolveItems({
        source,
        lastSeenAnchors: [],
        deps: { fetch, readEnv: noEnv, scrape: {} as never },
      }),
      /returned only bot-challenge chrome/,
    );
  });
});
