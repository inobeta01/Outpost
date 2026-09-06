/**
 * Enrichment lookup — the version-join pattern.
 *
 * Given a structured source's `EnrichmentConfig` and a list of
 * known versions (from the structured adapter), this module finds
 * the matching enrichment entry for each version and returns it.
 *
 * The lookup works by:
 *   1. Constructing a virtual `UnstructuredSource` from the
 *      enrichment config (so we can reuse the existing strategy
 *      machinery without a separate code path).
 *   2. Calling the strategy's `resolveItems` to discover all
 *      available entries on the enrichment feed.
 *   3. For each known version, finding the entry whose anchor
 *      (URL slug, heading, etc.) matches the version, using
 *      the existing anchor mechanism + the version normalization
 *      utility.
 *   4. Calling the strategy's `fetchItem` for that entry, then
 *      returning the result.
 *
 * The 404 case (no matching entry for a version) returns
 * `EnrichmentLookupResult.notFound` — the host loop treats this
 * as a silent skip per the v1 decision.
 *
 * Transient failures (network blip, 5xx) throw — the host loop
 * catches, records in `pendingEnrichments`, and retries on the
 * next poll.
 *
 * See [[Version-Join Architecture — Unstructured Enrichment Driven
 * by Structured Lane]] for the design.
 */

import type {
  EnrichmentConfig,
  ExtractionStrategy,
  StructuredSource,
  UnstructuredSource,
} from "@outpost/shared";

import {
  getStrategy,
  type DerivedAnchor,
  type FetchItemOutput,
  type ResolvedItem,
  type ScrapeClient,
  StrategyExecutionError,
} from "../unstructured/index.js";

import { deriveAnchor } from "../unstructured/anchor/derive-anchor.js";
import { buildAnchorInput } from "../unstructured/anchor-input.js";

import type { FetchLike, ReadEnvLike } from "./types.js";

import { canonicalizeText, sha256Hex } from "./canonical.js";

import { anchorMatchesVersion, normalizeVersionForAnchor } from "./version-anchor.js";

/**
 * The result of looking up an enrichment entry for a version.
 *
 * `notFound` means: the enrichment feed was successfully resolved,
 * but no entry's anchor matched the requested version. Per the v1
 * decision, this is a silent skip — not an error.
 *
 * `found` carries the cleaned text + content hash + the entry URL
 * (for the artifact's fetch_provenance).
 */
export type EnrichmentLookupResult =
  | { readonly status: "not_found"; readonly version: string }
  | {
      readonly status: "found";
      readonly version: string;
      readonly entryUrl: string;
      readonly cleanedText: string;
      readonly contentType: string;
      readonly contentHash: string;
      readonly detectedAt: string;
    };

/**
 * Build a virtual `UnstructuredSource` from an `EnrichmentConfig`.
 *
 * The strategy machinery expects an `UnstructuredSource` shape. We
 * construct one from the enrichment block so we can reuse the
 * existing strategies without a parallel code path.
 *
 * The `id` is the parent source's id + a suffix, so it's unique
 * even if multiple enrichment feeds exist for the same source.
 */
function buildEnrichmentSource(
  parent: StructuredSource,
  config: EnrichmentConfig,
): UnstructuredSource {
  return {
    id: `${parent.id}#enrichment`,
    kind: "unstructured",
    owner: parent.owner,
    extraction_strategy: config.strategy,
    ...(config.strategy_config !== undefined
      ? { strategy_config: config.strategy_config }
      : {}),
    fetch: {
      auth: config.auth ?? "none",
      url: config.endpoint_url,
      type: "firecrawl",
      fetch_method: "scrape",
    },
    security: parent.security,
    anchor_source: config.anchor_source,
    ...(config.anchor_pattern !== undefined
      ? { anchor_pattern: config.anchor_pattern }
      : {}),
    ...(config.staleness_sentinel !== undefined
      ? { staleness_sentinel: config.staleness_sentinel }
      : {}),
    firecrawl: true,
  };
}

/**
 * Look up enrichment for a single version.
 *
 * @param parent The structured source (for id/owner/security)
 * @param config The enrichment config
 * @param version The version reported by the structured adapter
 * @param deps The fetch/readEnv/scrape deps
 * @returns The lookup result, or throws on transient/recoverable error
 */
export async function lookupEnrichment(
  parent: StructuredSource,
  config: EnrichmentConfig,
  version: string,
  deps: { fetch: FetchLike; readEnv: ReadEnvLike; scrape: ScrapeClient },
): Promise<EnrichmentLookupResult> {
  if (version === null || version === "") {
    // Defensive: a structured source with a null/empty version can't
    // be enriched. The version-join requires a non-empty version
    // string to match against the entry's anchor.
    return { status: "not_found", version: version ?? "" };
  }

  const enrichmentSource = buildEnrichmentSource(parent, config);
  const strategy = getStrategy(config.strategy);

  // Step 1: resolve all items on the enrichment feed. We pass an
  // empty `lastSeenAnchors` to get the full list (the version-join
  // does its own matching by version, not the strategy's set-diff).
  // This is a known divergence from the unstructured incremental
  // path — for the version-join we always scan the full feed, even
  // if the strategy normally does set-diff. The reason: we need to
  // find the entry for this specific version, and we don't know
  // its anchor ahead of time.
  const resolveResult = await strategy.resolveItems({
    source: enrichmentSource,
    lastSeenAnchors: [],
    deps,
  });

  // Step 2: for each resolved item, check if its anchor matches
  // the requested version. Use the existing anchor mechanism to
  // extract the anchor from the item (no fetch yet — we want the
  // URL-slug or feed-field anchor, not the body anchor).
  const matchedItem = await findItemForVersion(
    strategy,
    enrichmentSource,
    resolveResult.newItems,
    version,
    config,
    deps,
  );

  if (matchedItem === null) {
    return { status: "not_found", version };
  }

  // Step 3: fetch the matched item.
  const payload = await strategy.fetchItem({
    item: matchedItem,
    source: enrichmentSource,
    deps,
  });
  if (payload === null) {
    // Strategy returned null — recoverable per the contract. We
    // treat this as transient and let the host loop decide.
    throw new StrategyExecutionError(
      "fetch_failed",
      `enrichment fetch_item returned null for ${parent.id} version ${version}`,
    );
  }

  return {
    status: "found",
    version,
    entryUrl: payload.url,
    cleanedText: payload.cleanedText,
    contentType: payload.contentType,
    contentHash: payload.contentHash,
    detectedAt: payload.fetchTimestamp,
  };
}

/**
 * For each resolved item, derive the anchor (without fetching the
 * body, when possible — URL slugs and feed fields are extracted
 * from the URL/feed metadata, not the body). Find the one whose
 * anchor matches the requested version.
 *
 * For `heading` and `inline_regex` mechanisms, the anchor needs
 * the body, which means we'd have to fetch every item just to find
 * the matching one. That's expensive. For v1, we accept this
 * cost: the version-join is most useful with `url_slug` and
 * `feed_field` mechanisms, which don't need the body.
 *
 * For `heading` and `inline_regex`, the function fetches each
 * item, derives the anchor, and matches. The cost is bounded by
 * the strategy's `resolveItems` output (which is the full list
 * for the version-join's purposes).
 */
async function findItemForVersion(
  strategy: ReturnType<typeof getStrategy>,
  source: UnstructuredSource,
  items: ReadonlyArray<ResolvedItem>,
  version: string,
  config: EnrichmentConfig,
  deps: { fetch: FetchLike; readEnv: ReadEnvLike; scrape: ScrapeClient },
): Promise<ResolvedItem | null> {
  // Cheap path: url_slug and feed_field don't need the body.
  // We can derive the anchor from the URL or feed metadata alone.
  if (config.anchor_source === "url_slug" || config.anchor_source === "feed_field") {
    for (const item of items) {
      const anchor = await deriveAnchorCheap(source, item, config);
      if (anchor !== null && anchorMatchesVersion(anchor, version)) {
        return item;
      }
    }
    return null;
  }

  // Expensive path: heading and inline_regex need the body. Fetch
  // each item, derive the anchor, match.
  for (const item of items) {
    let payload: FetchItemOutput | null;
    try {
      payload = await strategy.fetchItem({ item, source, deps });
    } catch {
      // Per-item fetch failures are skipped, not fatal — the
      // strategy contract says recoverable failures return null,
      // unrecoverable throw. We treat both as "this item didn't
      // match" for matching purposes; the version-join host
      // doesn't care why a particular entry didn't yield a body.
      continue;
    }
    if (payload === null) continue;
    const anchor = deriveAnchorFull(source, item, payload, config);
    if (anchor !== null && anchorMatchesVersion(anchor, version)) {
      return item;
    }
  }
  return null;
}

/**
 * Derive the anchor without fetching the body. Used for
 * `url_slug` (URL only) and `feed_field` (feed metadata).
 */
async function deriveAnchorCheap(
  source: UnstructuredSource,
  item: ResolvedItem,
  config: EnrichmentConfig,
): Promise<string | null> {
  if (config.anchor_source === "url_slug") {
    if (!config.anchor_pattern) return null;
    const anchor = deriveAnchor(
      {
        mechanism: "url_slug",
        pattern: config.anchor_pattern,
        strategy: config.strategy as ExtractionStrategy,
        source,
      },
      { itemUrl: item.url, itemBody: null, anchorPattern: config.anchor_pattern, feedFields: item.metadata },
    );
    return anchor?.value ?? null;
  }
  if (config.anchor_source === "feed_field") {
    const anchor = deriveAnchor(
      {
        mechanism: "feed_field",
        pattern: null,
        strategy: config.strategy as ExtractionStrategy,
        source,
      },
      { itemUrl: item.url, itemBody: null, anchorPattern: null, feedFields: item.metadata },
    );
    return anchor?.value ?? null;
  }
  return null;
}

/**
 * Derive the anchor with the body. Used for `heading` and
 * `inline_regex`. Caller must have already fetched the item.
 */
function deriveAnchorFull(
  source: UnstructuredSource,
  item: ResolvedItem,
  payload: FetchItemOutput,
  config: EnrichmentConfig,
): string | null {
  if (config.anchor_source === "heading" || config.anchor_source === "inline_regex") {
    if (!config.anchor_pattern) return null;
    const anchor = deriveAnchor(
      {
        mechanism: config.anchor_source,
        pattern: config.anchor_pattern,
        strategy: config.strategy as ExtractionStrategy,
        source,
      },
      buildAnchorInput(source, item, payload),
    );
    return anchor?.value ?? null;
  }
  return null;
}

/**
 * Re-export the normalization utility for convenience in host code.
 */
export { normalizeVersionForAnchor };
