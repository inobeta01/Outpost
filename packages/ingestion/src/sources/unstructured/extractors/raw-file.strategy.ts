/**
 * `raw_file` extraction strategy (ADR §9.4 strategy 4).
 *
 * Direct HTTPS GET of a single static file. No scraping, no
 * link extraction, no pagination — just `fetch(file_url)` and
 * hash the body. The anchor is derived per the spec's
 * `anchor_source` / `anchor_pattern`.
 *
 * Real example: Twilio SDK's `CHANGES.md` on GitHub raw
 * (https://raw.githubusercontent.com/twilio/twilio-python/main/CHANGES.md).
 * The file is a flat markdown document; each entry starts with
 * `## [version] - date` and we use the `heading` anchor source.
 *
 * v1 caveats:
 *
 *   - The `fetch` call goes through the `ScrapeClient`'s scrape
 *     method only when the file is HTML-ish. For .md / .txt /
 *     .json / .yaml, raw `fetch` is fine — we don't need a
 *     headless browser. We use the strategy's `input.deps.fetch`
 *     directly here, NOT `input.deps.scrape.scrape`. That keeps
 *     the strategy cheap and avoids the Firecrawl cost on every
 *     poll.
 *
 *   - The "set-diff" model doesn't really apply: a raw file is a
 *     single item that changes as a whole. The strategy returns
 *     ONE item, and `anchor_source` typically derives from
 *     `heading` (the latest `## vX.Y.Z` line).
 *
 *   - Content-validity still applies — if GitHub serves us a
 *     404 HTML page or a Cloudflare challenge, we treat it as a
 *     bot-challenge abort.
 */

import type { StrategyConfigRawFile, UnstructuredSource } from "@outpost/shared";

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

function getConfig(source: UnstructuredSource): StrategyConfigRawFile {
  const c = source.strategy_config;
  if (!c || !("file_url" in c)) {
    throw new StrategyExecutionError(
      "missing_strategy_config",
      `raw_file strategy requires strategy_config.file_url; ` +
        `source ${source.id} has ${c ? JSON.stringify(c) : "no"} config`,
    );
  }
  return c as StrategyConfigRawFile;
}

export const rawFileStrategy: ExtractionStrategyAdapter = {
  strategy: "raw_file",

  async resolveItems(input: ResolveItemsInput): Promise<ResolveItemsOutput> {
    const config = getConfig(input.source);
    // Always one item: the file URL itself. No set-diff possible
    // — the file is a single blob, not a list of entries. The
    // host loop will rely on `content_hash` change detection
    // rather than anchor set-diff.
    const item: ResolvedItem = {
      itemId: config.file_url,
      url: config.file_url,
      metadata: null,
    };
    return { newItems: [item], anchors: [] };
  },

  async fetchItem(input: FetchItemInput): Promise<FetchItemOutput | null> {
    const response = await input.deps.fetch(input.item.url);
    if (!response.ok) {
      if (response.status === 429) {
        // Rate-limited — treat as transient. Returning null
        // lets the host loop decide to retry.
        return null;
      }
      // 4xx other than 429 is unrecoverable for this URL.
      throw new StrategyExecutionError(
        "fetch_failed",
        `raw_file GET ${input.item.url} returned status ${response.status}`,
      );
    }
    const body = await response.text();

    // Even raw fetches can hit Cloudflare — GitHub's CDN does
    // occasionally serve a challenge page when the request lacks
    // the right headers. Sanitize before hashing.
    const validity = validateContent({ cleanedText: body });
    if (!validity.ok) {
      throw new StrategyExecutionError(
        "bot_challenge_abort",
        `raw_file ${input.item.url} returned only bot-challenge chrome; aborting poll`,
      );
    }

    // Infer a content type from the URL extension. The strategy
    // never lies about it — raw_file is for human-readable
    // artifacts, not for binary blobs.
    let contentType = "text/plain";
    const lower = input.item.url.toLowerCase().split("?")[0] ?? input.item.url;
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) contentType = "text/markdown";
    else if (lower.endsWith(".html") || lower.endsWith(".htm")) contentType = "text/html";
    else if (lower.endsWith(".json")) contentType = "application/json";
    else if (lower.endsWith(".yaml") || lower.endsWith(".yml")) contentType = "application/yaml";
    else if (lower.endsWith(".txt")) contentType = "text/plain";

    return {
      itemId: input.item.itemId,
      url: input.item.url,
      cleanedText: validity.sanitized,
      contentType,
      contentHash: hashText(validity.sanitized),
      fetchTimestamp: new Date().toISOString(),
    };
  },
};

registerStrategy(rawFileStrategy);
