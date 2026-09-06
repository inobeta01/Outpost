/**
 * `rss` extraction strategy (ADR §9.4 strategy 5).
 *
 * RSS / Atom feed parsing. Single fetch of the feed URL, parse
 * `<item>` (RSS) or `<entry>` (Atom) elements. Each one becomes a
 * `ResolvedItem` whose `metadata` carries the feed-level
 * `pubDate` and `guid` so `feed_field` anchor derivation can use
 * them downstream.
 *
 * Real example: Twilio Engineering blog RSS
 * (https://www.twilio.com/engineering/feed).
 *
 * v1 caveats:
 *
 *   - We use a hand-rolled regex-based parser, NOT a full XML
 *     parser. Real-world RSS feeds are messy (HTML entities,
 *     CDATA, namespaced Atom). For v1 this is fine because:
 *       a) we only need `<title>`, `<link>`, `<pubDate>` /
 *          `<published>`, `<guid>` / `<id>` — never the body.
 *       b) malformed items are skipped, not fatal.
 *     If a vendor's feed needs a real parser, that's a v2
 *     concern (probably via `fast-xml-parser`).
 *
 *   - The set-diff uses `metadata.guid` first, falling back to
 *     `metadata.pubDate`. We persist both into the anchor list
 *     so the next poll's `lastSeenAnchors` lookup works.
 *
 *   - Per ADR §10.4, RSS sources with `anchor_source: feed_field`
 *     are Tier 1 — the pubDate comes straight from vendor-
 *     asserted XML metadata, not derived from prose.
 */

import type { StrategyConfigRss, UnstructuredSource } from "@outpost/shared";

import { hashText } from "../../structured/canonical.js";

import { validateContent } from "../content-validity.js";

import {
  type ExtractionStrategyAdapter,
  type FetchItemInput,
  type FetchItemOutput,
  type ResolveItemsInput,
  type ResolveItemsOutput,
  type ResolvedItem,
  registerStrategy,
  StrategyExecutionError,
} from "../strategy-registry.js";

function getConfig(source: UnstructuredSource): StrategyConfigRss {
  const c = source.strategy_config;
  if (!c || !("rss_url" in c)) {
    throw new StrategyExecutionError(
      "missing_strategy_config",
      `rss strategy requires strategy_config.rss_url; ` +
        `source ${source.id} has ${c ? JSON.stringify(c) : "no"} config`,
    );
  }
  return c as StrategyConfigRss;
}

/** A single parsed feed entry — internal representation. */
interface ParsedFeedItem {
  readonly link: string;
  readonly pubDate: string | null;
  readonly guid: string | null;
}

/**
 * Extract `<item>` (RSS 2.0) and `<entry>` (Atom) elements from
 * raw feed XML. Per-item fields are pulled with `getTag` below;
 * we don't try to handle XML namespaces beyond the common case.
 */
function parseFeedItems(xml: string): ParsedFeedItem[] {
  const out: ParsedFeedItem[] = [];

  // RSS 2.0: <item> ... </item>
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(xml)) !== null) {
    const inner = itemMatch[1] ?? "";
    const link = getTag(inner, "link") ?? getAtomHref(inner) ?? "";
    if (!link) continue;
    out.push({
      link,
      pubDate: getTag(inner, "pubDate"),
      guid: getTag(inner, "guid"),
    });
  }

  // Atom: <entry> ... </entry>
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRe.exec(xml)) !== null) {
    const inner = entryMatch[1] ?? "";
    const link = getTag(inner, "link") ?? getAtomHref(inner) ?? "";
    if (!link) continue;
    out.push({
      link,
      pubDate: getTag(inner, "published") ?? getTag(inner, "updated"),
      guid: getTag(inner, "id"),
    });
  }

  return out;
}

/**
 * Pull the inner text of the first occurrence of a tag, ignoring
 * attributes. Returns `null` if the tag isn't present.
 */
function getTag(inner: string, tag: string): string | null {
  // Match <tag ...>contents</tag>; allow self-closing fallback.
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(inner);
  if (!m) return null;
  const raw = m[1] ?? "";
  // Strip CDATA wrappers and leading/trailing whitespace.
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw.trim());
  return ((cdata?.[1] ?? raw) as string).trim() || null;
}

/**
 * Atom feeds carry the canonical URL in `<link href="..."/>`,
 * not as inner text. Return that href when present.
 */
function getAtomHref(inner: string): string | null {
  const m = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(inner);
  return m?.[1] ?? null;
}

export const rssStrategy: ExtractionStrategyAdapter = {
  strategy: "rss",

  async resolveItems(input: ResolveItemsInput): Promise<ResolveItemsOutput> {
    const config = getConfig(input.source);

    // Set-diff: build the set of seen `guid`s and `pubDate`s from
    // the last poll. Anchor values for RSS are the guid when
    // present, else the pubDate. Anchor `value` is a string —
    // for the feed_field source it's the pubDate string verbatim
    // (we don't try to parse it into a normalized form here).
    const seenKeys = new Set<string>();
    for (const anchor of input.lastSeenAnchors) {
      if (anchor.value !== null) seenKeys.add(anchor.value);
    }

    const response = await input.deps.fetch(config.rss_url);
    if (!response.ok) {
      throw new StrategyExecutionError(
        "fetch_failed",
        `rss feed GET ${config.rss_url} returned status ${response.status}`,
      );
    }
    const xml = await response.text();

    const validity = validateContent({ cleanedText: xml });
    if (!validity.ok) {
      throw new StrategyExecutionError(
        "bot_challenge_abort",
        `rss feed ${config.rss_url} returned only bot-challenge chrome; aborting poll`,
      );
    }

    const items = parseFeedItems(validity.sanitized);
    const newItems: ResolvedItem[] = [];
    for (const item of items) {
      const dedupeKey = item.guid ?? item.pubDate ?? item.link;
      if (dedupeKey && seenKeys.has(dedupeKey)) continue;
      newItems.push({
        itemId: dedupeKey ?? item.link,
        url: item.link,
        metadata: { pubDate: item.pubDate, guid: item.guid },
      });
    }

    // We don't return anchors here — the host loop persists
    // `metadata.guid` / `metadata.pubDate` as anchors for the
    // next poll after fetch succeeds.
    return { newItems, anchors: [] };
  },

  async fetchItem(input: FetchItemInput): Promise<FetchItemOutput | null> {
    // For RSS, `fetchItem` is a no-op: the actual feed was
    // already fetched in `resolveItems`. We return the metadata
    // we collected as the "body" so downstream P2.3 has the title
    // + link + pubDate to work with. The hash is over those
    // structured fields, ensuring per-item content-changes
    // surface correctly.
    const md = input.item.metadata;
    const body = JSON.stringify({
      link: input.item.url,
      pubDate: md?.pubDate ?? null,
      guid: md?.guid ?? null,
    });
    return {
      itemId: input.item.itemId,
      url: input.item.url,
      cleanedText: body,
      contentType: "application/rss+xml-item",
      contentHash: hashText(body),
      fetchTimestamp: new Date().toISOString(),
    };
  },
};

registerStrategy(rssStrategy);
