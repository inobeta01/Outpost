/**
 * Anchor derivation types (ADR §10).
 *
 * An "anchor" is the version or date identifier for a single
 * changelog/release entry. Per ADR §10.1, anchor derivation is
 * deterministic parsing, NOT an LLM task — the LLM never decides
 * "what version is this". By the time a chunk of text reaches
 * P2.3's extraction prompt, its anchor is already resolved.
 *
 * Two anchor types:
 *   - `version` — explicit version string (e.g. "1.18.0"). Higher
 *     confidence; participates in `get_changes(from, to)` range
 *     queries.
 *   - `date` — only a date is available (e.g. "2026-08-20"). Lower
 *     confidence; orderable by time but not precisely range-queryable.
 *
 * The `source` field carries WHICH mechanism produced the value
 * (per ADR §10.4 — feeds forward into P2.4's per-mechanism
 * confidence weighting). The exact same string resolved by
 * `url_slug` vs. `inline_regex` carries different trust.
 */

import type {
  AnchorSource as AnchorMechanism,
  ExtractionStrategy,
  UnstructuredSource,
} from "@outpost/shared";

export type { AnchorMechanism, ExtractionStrategy };

/** The two anchor types per ADR §10.3. */
export type AnchorType = "version" | "date";

/**
 * The result of running one anchor-source impl. `value` is `null`
 * only when the source was `none` — every other source either
 * returns a value or throws.
 */
export interface DerivedAnchor {
  readonly type: AnchorType;
  /** Which mechanism produced this value. ADR §10.4. */
  readonly source: AnchorMechanism;
  readonly value: string | null;
}

/**
 * Input to every anchor-source impl. Each impl uses a subset of
 * the fields — the type is the union so the dispatcher can pass
 * the same object everywhere without per-source slicing.
 */
export interface AnchorDeriveInput {
  /** The full URL of the item (e.g. a detail-page link, RSS item). */
  readonly itemUrl: string;
  /** The cleaned text body of the item, if the item has been fetched. */
  readonly itemBody: string | null;
  /**
   * The spec's `anchor_pattern` — a regex with at least one
   * capture group. `url_slug`, `heading`, and `inline_regex`
   * all consume it; `feed_field` ignores it (Tier 1, structured
   * XML metadata).
   */
  readonly anchorPattern: string | null;
  /**
   * For `feed_field` only: the structured metadata from an RSS
   * `<item>`. `pubDate` and `guid` are the two trusted fields.
   * `null` for non-RSS strategies.
   */
  readonly feedFields: { readonly pubDate: string | null; readonly guid: string | null } | null;
}

/**
 * The spec-derived shape the dispatcher needs. The strategy
 * pulls these from the `UnstructuredSource` at runtime.
 */
export interface AnchorSpec {
  /** The spec's `anchor_source` field. */
  readonly mechanism: AnchorMechanism;
  /** The spec's `anchor_pattern` field (when applicable). */
  readonly pattern: string | null;
  /** The spec's `extraction_strategy` — for context in error messages. */
  readonly strategy: ExtractionStrategy;
  /**
   * The full source spec, for source_id in error messages and
   * future per-spec context (e.g. strategy_config-derived anchors).
   */
  readonly source: UnstructuredSource;
}
