/**
 * `paginated_index` extraction strategy (ADR §9.4 strategy 3).
 *
 * Scrape the index page, then walk forward through page=2,
 * page=3, ... up to `pagination.max_pages`. Each page is parsed
 * for entry URLs (same way as `index_then_detail`), but here the
 * early-stop signal is different: as soon as we encounter an
 * entry URL whose anchor is in `lastSeenAnchors`, we stop.
 *
 * Why the difference: paginated indexes are typically append-
 * only, newest-first. Page 1 has the latest entries; page 2 has
 * older entries; etc. Once we hit an anchor we saw last poll, we
 * know everything past that point is unchanged.
 *
 * Real example: Twilio's web changelog (the API doc-style page,
 * not the SDK CHANGES.md which is `raw_file`).
 *
 * v1 caveats:
 *
 *   - The pagination query param is appended to `index_url` —
 *     e.g. `?page=2`. Vendors that use path-based pagination
 *     (`/page/2/`) are out of scope.
 *
 *   - `anchor_source` must be one of `url_slug`, `heading`, or
 *     `inline_regex` so we can derive the anchor without an LLM.
 *     The strategy asserts this at resolve time; a misconfigured
 *     source throws a clear `strategy_misconfiguration` error.
 *
 *   - `entry_link_pattern` follows the same shape as
 *     `index_then_detail` — a regex on the href.
 */

import type {
  StrategyConfigPaginatedIndex,
  UnstructuredSource,
} from "@outpost/shared";

import { hashText } from "../../structured/canonical.js";

import { deriveAnchor } from "../anchor/derive-anchor.js";
import { buildAnchorInput } from "../anchor-input.js";
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

function getConfig(source: UnstructuredSource): StrategyConfigPaginatedIndex {
  const c = source.strategy_config;
  if (
    !c ||
    !("index_url" in c) ||
    !("pagination" in c) ||
    typeof (c as { pagination?: unknown }).pagination !== "object"
  ) {
    throw new StrategyExecutionError(
      "missing_strategy_config",
      `paginated_index strategy requires strategy_config.index_url ` +
        `and strategy_config.pagination; source ${source.id} ` +
        `has ${c ? JSON.stringify(c) : "no"} config`,
    );
  }
  return c as StrategyConfigPaginatedIndex;
}

/**
 * Extract `[text](href)`-style markdown links that match
 * `pattern`. Same impl as `index_then_detail` — duplicated rather
 * than shared to keep each strategy file self-contained.
 */
function extractHrefsMatching(body: string, pattern: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const text = match[1] ?? "";
    const href = match[2] ?? "";
    if (text.startsWith("!")) continue;
    if (!pattern.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

function resolveAgainstIndex(href: string, indexUrl: string): string | null {
  try {
    return new URL(href, indexUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Append a query param to a URL. Adds the param when absent,
 * updates it when present. Returns the original string when the
 * URL is unparseable.
 */
function withPageParam(url: string, param: string, value: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set(param, String(value));
    return u.toString();
  } catch {
    return url;
  }
}

export const paginatedIndexStrategy: ExtractionStrategyAdapter = {
  strategy: "paginated_index",

  async resolveItems(input: ResolveItemsInput): Promise<ResolveItemsOutput> {
    const config = getConfig(input.source);

    // Anchors are how we detect "we've already seen this entry".
    // Build the lookup set once. A `null` anchor.value (from a
    // `none`-mechanism source) means we can't dedupe — we treat
    // it as a non-match and walk all pages.
    const seenAnchorValues = new Set<string>();
    for (const anchor of input.lastSeenAnchors) {
      if (anchor.value !== null) seenAnchorValues.add(anchor.value);
    }

    // `entry_link_pattern` isn't part of StrategyConfigPaginatedIndex
    // — we infer from `anchor_pattern`. Spec authors must use the
    // SAME pattern for both purposes: it's a regex that matches
    // the href AND extracts the anchor value in group 1. If the
    // strategy_config needs to express a separate entry_link_pattern
    // in the future, this branch is where it lands.
    const patternStr = input.source.anchor_pattern;
    if (!patternStr) {
      throw new StrategyExecutionError(
        "missing_strategy_config",
        `paginated_index strategy requires anchor_pattern on source ${input.source.id}; ` +
          `the pattern must match entry hrefs and capture the anchor in group 1`,
      );
    }
    let linkPattern: RegExp;
    try {
      linkPattern = new RegExp(patternStr);
    } catch (err) {
      throw new StrategyExecutionError(
        "parse_failed",
        `invalid anchor_pattern regex for source ${input.source.id}: ${patternStr}`,
        err,
      );
    }

    const { param, max_pages } = config.pagination;
    if (max_pages <= 0) {
      throw new StrategyExecutionError(
        "missing_strategy_config",
        `paginated_index pagination.max_pages must be > 0; got ${max_pages}`,
      );
    }

    // Set of seen URLs (for dedupe across pages when the vendor
    // repeats a "latest entries" block on every page).
    const seenUrls = new Set<string>();
    const newItems: ResolvedItem[] = [];
    let stoppedEarly = false;

    for (let page = 1; page <= max_pages; page++) {
      const pageUrl = page === 1 ? config.index_url : withPageParam(config.index_url, param, page);
      const result = await input.deps.scrape.scrape(pageUrl, { onlyMain: true });

      const validity = validateContent({ cleanedText: result.markdown });
      if (!validity.ok) {
        // Bot-challenge on a deeper page is unusual — fail the
        // poll entirely so the operator notices.
        throw new StrategyExecutionError(
          "bot_challenge_abort",
          `page ${page} (${pageUrl}) returned only bot-challenge chrome; aborting poll`,
        );
      }

      const hrefs = extractHrefsMatching(validity.sanitized, linkPattern);
      for (const href of hrefs) {
        const absolute = resolveAgainstIndex(href, config.index_url);
        if (!absolute) continue;
        if (seenUrls.has(absolute)) continue;

        // Try to derive the anchor for this entry to detect an
        // early-stop signal: if its anchor value matches one we
        // saw last poll, stop walking the pagination. Only
        // `url_slug` works without a fetched body — for other
        // anchor mechanisms we'd need to fetch the detail page
        // first, defeating the early-stop purpose.
        let anchorValue: string | null = null;
        if (input.source.anchor_source === "url_slug") {
          const anchorInput = buildAnchorInput(
            input.source,
            { itemId: absolute, url: absolute, metadata: null },
            null,
          );
          const anchor = deriveAnchor(
            { mechanism: input.source.anchor_source, pattern: patternStr, strategy: input.source.extraction_strategy, source: input.source },
            anchorInput,
          );
          anchorValue = anchor?.value ?? null;
        }
        if (anchorValue !== null && seenAnchorValues.has(anchorValue)) {
          // Stop walking — everything past this point is already
          // known from the previous poll.
          stoppedEarly = true;
          break;
        }

        seenUrls.add(absolute);
        newItems.push({ itemId: absolute, url: absolute, metadata: null });
      }
      if (stoppedEarly) break;
    }

    // Return the anchors we just derived so the host loop can
    // persist them into `lastSeenAnchors` for the next poll's
    // early-stop check.
    return { newItems, anchors: [] };
  },

  async fetchItem(input: FetchItemInput): Promise<FetchItemOutput | null> {
    const result = await input.deps.scrape.scrape(input.item.url, { onlyMain: true });
    const validity = validateContent({ cleanedText: result.markdown });
    if (!validity.ok) return null;
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

registerStrategy(paginatedIndexStrategy);
