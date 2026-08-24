/**
 * Strategy registry — dispatch map keyed by `extraction_strategy`.
 *
 * Analogous to `structured/source-registry.ts` but for the
 * unstructured lane. Each strategy implements the 3-step
 * contract from ADR §9.3:
 *
 *   1. resolve_items(config, state)  → list of items to fetch
 *   2. fetch_item(item, deps)        → cleaned text + content hash
 *   3. derive_anchor(item, payload)  → deterministic anchor
 *
 * Slice 3 wires the registry primitives. Slice 4 will register
 * the 5 strategies. The closed enum + this registry are kept in
 * lockstep — adding a new strategy is impossible without updating
 * the enum in `@outpost/shared`.
 */

import type {
  AnchorSource as AnchorMechanism,
  ExtractionStrategy,
  UnstructuredSource,
} from "@outpost/shared";

import type { DerivedAnchor } from "./anchor/derive-anchor.js";
import type { FetchLike, ReadEnvLike } from "../structured/types.js";

/**
 * Minimal Firecrawl-style scrape contract. The real Firecrawl
 * SDK returns `{ markdown, html, metadata, json }` — we only
 * need the markdown (or, for `rss`, the raw XML which is fetched
 * via `fetch`, not the scrape client). Strategies depend on this
 * interface, not on the Firecrawl SDK, so tests can stub it
 * with a recorded markdown blob.
 *
 * Per ADR §2: only `scrape` is allowed in the automated pipeline
 * (crawl/map are out of scope). v1 only calls `scrape`.
 */
export interface ScrapeClient {
  scrape(url: string, init?: { onlyMain?: boolean }): Promise<{
    readonly markdown: string;
    readonly html: string;
    readonly metadata: { readonly title: string | null; readonly sourceURL: string };
  }>;
}

/**
 * An item resolved by the strategy's `resolve_items` step. The
 * strategy's responsibility: produce a list of these given the
 * spec and the previous poll's state.
 */
export interface ResolvedItem {
  /** Stable per-item ID. URL, RSS guid, or a hash of the URL. */
  readonly itemId: string;
  /** The URL to fetch (or, for `rss`, the link extracted from the feed). */
  readonly url: string;
  /**
   * Per-item metadata. Used by `rss` to carry forward `<pubDate>` and
   * `<guid>`; null for strategies that don't need it.
   */
  readonly metadata: { readonly pubDate: string | null; readonly guid: string | null } | null;
}

/** Output of `resolve_items`. */
export interface ResolveItemsOutput {
  /** The new items to fetch (set-diffed against the previous poll's state). */
  readonly newItems: ReadonlyArray<ResolvedItem>;
  /**
   * For `paginated_index` early-stop signaling: anchor values seen
   * during this resolution. The host loop persists this in the
   * per-source state so the next poll's resolve_items can detect
   * that "we've already seen this anchor" and stop paging.
   */
  readonly anchors: ReadonlyArray<DerivedAnchor>;
}

export interface ResolveItemsInput {
  readonly source: UnstructuredSource;
  /** Anchor values from the previous successful poll (for early-stop). */
  readonly lastSeenAnchors: ReadonlyArray<DerivedAnchor>;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
    readonly scrape: ScrapeClient;
  };
}

/** What `fetch_item` returns — the payload `derive_anchor` reads. */
export interface FetchItemOutput {
  readonly itemId: string;
  readonly url: string;
  /** The cleaned text body, after Firecrawl / raw-fetch / RSS-XML-parse. */
  readonly cleanedText: string;
  /** MIME-ish hint: "text/markdown", "application/rss+xml", "text/html". */
  readonly contentType: string;
  /**
   * Hash of the *cleaned* text (NOT raw HTML). Computed by the
   * caller of fetch_item, not by the strategy itself — different
   * strategies hash different shapes. Stored in the artifact for
   * the structured lane's hash-only detection parity.
   */
  readonly contentHash: string;
  /** ISO-8601. */
  readonly fetchTimestamp: string;
}

export interface FetchItemInput {
  readonly item: ResolvedItem;
  readonly source: UnstructuredSource;
  readonly deps: {
    readonly fetch: FetchLike;
    readonly readEnv: ReadEnvLike;
    readonly scrape: ScrapeClient;
  };
}

/**
 * Telemetry signal that may be emitted by a strategy during
 * execution. Carried alongside the strategy's primary output;
 * the host loop is responsible for routing these to the
 * registry's operational dashboards.
 */
export type ExtractionTelemetry =
  | {
      readonly level: "warning";
      readonly event: "fetch_warning_bot_challenge";
      readonly sourceId: string;
      readonly itemId: string | null;
    }
  | {
      readonly level: "warning";
      readonly event: "strategy_misconfiguration";
      readonly sourceId: string;
      readonly message: string;
    }
  | {
      readonly level: "warning";
      readonly event: "stale_anchors";
      readonly sourceId: string;
      readonly dropped: number;
    };

/** The 3-step contract that every strategy implements. */
export interface ExtractionStrategyAdapter {
  readonly strategy: ExtractionStrategy;

  /** Step 1: which items should we fetch this poll cycle? */
  resolveItems(input: ResolveItemsInput): Promise<ResolveItemsOutput>;

  /**
   * Step 2: fetch and clean one item. Returns `null` if the
   * fetch failed in a way the strategy considers recoverable
   * (e.g. transient network error) — the host loop decides
   * whether to retry. Throws on unrecoverable errors
   * (4xx other than 429, parse failures the strategy can't
   * clean, etc.).
   */
  fetchItem(input: FetchItemInput): Promise<FetchItemOutput | null>;
}

const registry = new Map<ExtractionStrategy, ExtractionStrategyAdapter>();

/**
 * Register a strategy. Throws if a different strategy is already
 * registered for the same `extraction_strategy` value.
 */
export function registerStrategy(
  adapter: ExtractionStrategyAdapter,
): () => void {
  const existing = registry.get(adapter.strategy);
  if (existing && existing !== adapter) {
    throw new StrategyExecutionError(
      "duplicate_strategy",
      `duplicate registration for extraction_strategy=${adapter.strategy}`,
    );
  }
  registry.set(adapter.strategy, adapter);
  return () => {
    if (registry.get(adapter.strategy) === adapter) {
      registry.delete(adapter.strategy);
    }
  };
}

/**
 * Look up the strategy for an `extraction_strategy` value. Throws
 * if no strategy is registered — a programming error, not a
 * runtime condition.
 */
export function getStrategy(strategy: ExtractionStrategy): ExtractionStrategyAdapter {
  const adapter = registry.get(strategy);
  if (!adapter) {
    throw new StrategyExecutionError(
      "unknown_strategy",
      `no strategy registered for extraction_strategy=${strategy}; ` +
        `add a strategy under packages/ingestion/src/sources/unstructured/extractors/ ` +
        `and import the barrel from packages/ingestion/src/sources/unstructured/index.js`,
    );
  }
  return adapter;
}

/** List the strategies currently registered. */
export function listRegisteredStrategies(): ReadonlyArray<ExtractionStrategy> {
  return Array.from(registry.keys());
}

/** Stable error codes the host loop can branch on. */
export type StrategyExecutionErrorCode =
  | "duplicate_strategy"
  | "unknown_strategy"
  | "fetch_failed"
  | "parse_failed"
  | "missing_strategy_config"
  | "bot_challenge_abort";

/**
 * Typed error thrown by strategies. Carries a code, a human-readable
 * message, and optional cause for diagnostic chains.
 */
export class StrategyExecutionError extends Error {
  public readonly code: StrategyExecutionErrorCode;
  public override readonly cause?: unknown;
  constructor(code: StrategyExecutionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StrategyExecutionError";
    this.code = code;
    this.cause = cause;
  }
}

// Re-export for ergonomics — strategies will need to know the
// AnchorMechanism type without re-importing it from shared.
export type { AnchorMechanism };
