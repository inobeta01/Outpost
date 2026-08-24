/**
 * `index_then_detail` extraction strategy (ADR §9.4 strategy 2).
 *
 * Two scrape calls per poll cycle:
 *
 *   1. Scrape the index page (`index_url`). The cleaned markdown
 *      contains hyperlinks to individual entries — match them
 *      with `entry_link_pattern` (a regex on the `href`).
 *
 *   2. For each new entry URL (set-diffed against the previous
 *      poll's seen URLs), scrape the detail page. Hash and
 *      return the cleaned detail markdown.
 *
 * Real example: Stripe Changelog. The index is one continuous
 * page; each entry links to its own URL at `/changelog/<codename>/
 * <date>/<slug>`. The `entry_link_pattern` matches the hrefs; the
 * `anchor_pattern` extracts the date from the URL slug.
 *
 * v1 caveats:
 *
 *   - `resolveItems` reads entry URLs out of the cleaned
 *     markdown's `[text](href)` syntax. It does NOT call out to
 *     Firecrawl's `extract` API or run an LLM. If the vendor
 *     changes their HTML such that Firecrawl renders the index
 *     without explicit `[]()` links, this strategy won't see
 *     them. That's an acceptable failure mode — the spec author
 *     is expected to verify against a real scrape.
 *
 *   - `fetchItem` scrapes the detail URL with `onlyMain: true` to
 *     skip the nav/footer. Stripe's detail pages do NOT honor
 *     `onlyMain` reliably — header/footer gets included on some
 *     pages. We accept the noise; P2.1's hash is over the
 *     *cleaned* text, so footer differences across pages don't
 *     cause false content-changes within a single entry URL.
 */

import type {
  StrategyConfigIndexThenDetail,
  UnstructuredSource,
} from "@outpost/shared";

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

function getConfig(source: UnstructuredSource): StrategyConfigIndexThenDetail {
  const c = source.strategy_config;
  if (!c || !("index_url" in c) || !("entry_link_pattern" in c)) {
    throw new StrategyExecutionError(
      "missing_strategy_config",
      `index_then_detail strategy requires strategy_config.index_url ` +
        `and strategy_config.entry_link_pattern; source ${source.id} ` +
        `has ${c ? JSON.stringify(c) : "no"} config`,
    );
  }
  return c as StrategyConfigIndexThenDetail;
}

/**
 * Extract `[text](href)`-style markdown links from a body, return
 * the unique hrefs that match `pattern`.
 *
 * We do a simple regex scan rather than running a real markdown
 * parser. This is intentionally narrow: the strategies see
 * Firecrawl's cleaned markdown, which is predictable enough that
 * a regex works.
 */
function extractHrefsMatching(body: string, pattern: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const text = match[1] ?? "";
    const href = match[2] ?? "";
    // Skip image syntax (`![alt](url)`).
    if (text.startsWith("!")) continue;
    if (!pattern.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/**
 * Resolve a possibly-relative href against an index URL. Falls
 * back to `null` when the URL constructor can't reconcile them.
 */
function resolveAgainstIndex(href: string, indexUrl: string): string | null {
  try {
    return new URL(href, indexUrl).toString();
  } catch {
    return null;
  }
}

export const indexThenDetailStrategy: ExtractionStrategyAdapter = {
  strategy: "index_then_detail",

  async resolveItems(input: ResolveItemsInput): Promise<ResolveItemsOutput> {
    const config = getConfig(input.source);

    // Rebuild the set of seen entry URLs from the last poll's
    // anchors. Anchors whose `value` parses as an http(s) URL are
    // treated as the raw URL; everything else (slugs, dates, null
    // from `none`-mechanism anchors) is ignored because we can't
    // dedupe a href list by slug.
    const seenUrls = new Set<string>();
    for (const anchor of input.lastSeenAnchors) {
      if (anchor.value === null) continue;
      try {
        const parsed = new URL(anchor.value);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          seenUrls.add(anchor.value);
        }
      } catch {
        // Not a URL — likely a slug. Fall through; skip.
      }
    }

    // Scrape the index page.
    const result = await input.deps.scrape.scrape(config.index_url, { onlyMain: true });
    const body = result.markdown;

    // Sanitize the index body before pattern-matching — bot-
    // challenge chrome that rendered as a link would pollute our
    // href list.
    const validity = validateContent({ cleanedText: body });
    if (!validity.ok) {
      throw new StrategyExecutionError(
        "bot_challenge_abort",
        `index page ${config.index_url} returned only bot-challenge chrome; aborting poll`,
      );
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(config.entry_link_pattern);
    } catch (err) {
      throw new StrategyExecutionError(
        "parse_failed",
        `invalid entry_link_pattern regex for source ${input.source.id}: ${config.entry_link_pattern}`,
        err,
      );
    }

    const hrefs = extractHrefsMatching(validity.sanitized, pattern);
    const newItems: ResolvedItem[] = [];
    for (const href of hrefs) {
      const absolute = resolveAgainstIndex(href, config.index_url);
      if (!absolute) continue;
      if (seenUrls.has(absolute)) continue;
      newItems.push({
        itemId: absolute,
        url: absolute,
        metadata: null,
      });
    }

    // No anchor list returned — `index_then_detail` doesn't
    // paginate. The host loop persists the new URLs into
    // `lastSeenAnchors` after the fetch step succeeds.
    return { newItems, anchors: [] };
  },

  async fetchItem(input: FetchItemInput): Promise<FetchItemOutput | null> {
    const result = await input.deps.scrape.scrape(input.item.url, { onlyMain: true });

    // Sanitize detail pages too — Stripe's CDN occasionally
    // serves a Cloudflare interstitial for high-traffic entries.
    const validity = validateContent({ cleanedText: result.markdown });
    if (!validity.ok) {
      // Per ADR §9.5: a bot-challenge on a detail page is a
      // recoverable error for that one item — return null so the
      // host loop skips this entry but continues with others.
      return null;
    }

    return {
      itemId: input.item.itemId,
      url: input.item.url,
      cleanedText: validity.sanitized,
      contentType: "text/markdown",
      contentHash: hashText(validity.sanitized),
      fetchTimestamp: new Date().toISOString(),
    };
  },
};

registerStrategy(indexThenDetailStrategy);
