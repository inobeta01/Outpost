/**
 * `single_page` extraction strategy (ADR §9.4 strategy 1).
 *
 * One Firecrawl scrape of the index URL. The page contains all
 * historical entries in a continuous document (organized by
 * version headers); we hand the cleaned markdown to P2.3 LLM
 * for entry-boundary segmentation, which is the only strategy
 * that needs an LLM call for entry splitting.
 *
 * Real example: React Router changelog
 * (https://reactrouter.com/changelog) — maintainers explicitly
 * chose a single continuous file over paginated GitHub Releases
 * because pagination truncated older notes.
 *
 * v1 caveats:
 *
 *   - `resolveItems` returns exactly one item: the index URL
 *     itself. The strategy is fully determined by the spec's
 *     `strategy_config.index_url`.
 *
 *   - The `anchor_source` typically resolves via `heading` (the
 *     `## vX.Y.Z` headers) or `inline_regex`. The fetch+anchor
 *     step finds the first matching anchor; per ADR §9.4, the
 *     LLM segments the rest of the page downstream.
 *
 *   - `fetchItem` always makes exactly one scrape call. There
 *     is no pagination, no set-diff, no early-stop — those
 *     belong to other strategies.
 */

import type {
  StrategyConfigSinglePage,
  UnstructuredSource,
} from "@outpost/shared";

import { hashText } from "../../structured/canonical.js";

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

function getConfig(source: UnstructuredSource): StrategyConfigSinglePage {
  const c = source.strategy_config;
  if (!c || !("index_url" in c)) {
    throw new StrategyExecutionError(
      "missing_strategy_config",
      `single_page strategy requires strategy_config.index_url; ` +
        `source ${source.id} has ${c ? JSON.stringify(c) : "no"} config`,
    );
  }
  return c as StrategyConfigSinglePage;
}

export const singlePageStrategy: ExtractionStrategyAdapter = {
  strategy: "single_page",

  async resolveItems(input: ResolveItemsInput): Promise<ResolveItemsOutput> {
    const config = getConfig(input.source);
    const item: ResolvedItem = {
      itemId: config.index_url,
      url: config.index_url,
      metadata: null,
    };
    // No set-diff (single page has no notion of "seen URLs" —
    // the entire page is re-scraped every poll). No early-stop
    // (the page is a single URL). The `anchors` field is empty
    // for this strategy; entry segmentation happens in P2.3.
    return { newItems: [item], anchors: [] };
  },

  async fetchItem(input: FetchItemInput): Promise<FetchItemOutput | null> {
    const result = await input.deps.scrape.scrape(input.item.url, { onlyMain: true });
    return {
      itemId: input.item.itemId,
      url: input.item.url,
      cleanedText: result.markdown,
      contentType: "text/markdown",
      contentHash: hashText(result.markdown),
      fetchTimestamp: new Date().toISOString(),
    };
  },
};

registerStrategy(singlePageStrategy);
