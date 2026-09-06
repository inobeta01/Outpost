/**
 * Anchor derivation — the public entry point (ADR §10.2).
 *
 * The spec locks ONE `anchor_source` at onboarding time. This
 * module is the runtime dispatcher that calls the right
 * anchor-source impl based on that lock. It does NOT fall back
 * across sources at runtime — that's a config-time decision
 * (ADR §10.2: "config-time choice locked per vendor at onboarding,
 * not a runtime fallback chain re-evaluated on every poll").
 *
 * The `ANCHOR_PRECEDENCE` constant is exported for documentation
 * and audit purposes — the spec author is expected to choose the
 * highest-precedence mechanism that actually works for their
 * vendor. If `url_slug` is available, don't configure
 * `inline_regex`; pick the cheapest, most-upstream option.
 *
 * Precedence (highest to lowest):
 *   1. `url_slug`     — derived from the URL itself, zero fetch
 *   2. `heading`      — derived from a markdown/HTML heading
 *   3. `inline_regex` — derived from prose with a regex
 *   4. `feed_field`   — derived from structured RSS metadata
 *   5. `none`         — no anchor (date_anchored fallback per §10.3)
 */

import type { AnchorMechanism } from "./types.js";
import type { AnchorDeriveInput, AnchorSpec, DerivedAnchor } from "./types.js";

import { deriveFeedField } from "./feed-field.js";
import { deriveHeading } from "./heading.js";
import { deriveInlineRegex } from "./inline-regex.js";
import { deriveUrlSlug } from "./url-slug.js";

/**
 * Per ADR §10.2 — documented precedence. The dispatcher itself
 * does NOT use this list; it dispatches on the spec's locked
 * `anchor_source`. This constant exists so the schema docs and
 * audit tooling can reference the canonical order.
 */
export const ANCHOR_PRECEDENCE: ReadonlyArray<AnchorMechanism> = [
  "url_slug",
  "heading",
  "inline_regex",
  "feed_field",
  "none",
];

/**
 * Derive the anchor for a single item. Pure function — no I/O,
 * no logging, no DB. Throws on programmer error (bad pattern,
 * missing required field for the configured source). Returns
 * `null` only when the configured source is `none` or when the
 * impl cannot find a match (which the strategy should treat as
 * "skip this entry", not "fail the run").
 */
export function deriveAnchor(
  spec: AnchorSpec,
  input: AnchorDeriveInput,
): DerivedAnchor | null {
  switch (spec.mechanism) {
    case "url_slug": {
      if (!input.anchorPattern) {
        throw new Error(
          `source ${spec.source.id}: anchor_source=url_slug requires anchor_pattern`,
        );
      }
      return deriveUrlSlug({ itemUrl: input.itemUrl, pattern: input.anchorPattern });
    }
    case "heading": {
      if (!input.anchorPattern) {
        throw new Error(
          `source ${spec.source.id}: anchor_source=heading requires anchor_pattern`,
        );
      }
      if (input.itemBody === null) {
        // Heading source requires a body. Strategy should
        // have fetched by the time this is called; if not,
        // it's a programming error.
        throw new Error(
          `source ${spec.source.id}: anchor_source=heading requires itemBody; ` +
            `strategy must call deriveAnchor after fetch_item`,
        );
      }
      return deriveHeading({ body: input.itemBody, pattern: input.anchorPattern });
    }
    case "inline_regex": {
      if (!input.anchorPattern) {
        throw new Error(
          `source ${spec.source.id}: anchor_source=inline_regex requires anchor_pattern`,
        );
      }
      if (input.itemBody === null) {
        throw new Error(
          `source ${spec.source.id}: anchor_source=inline_regex requires itemBody`,
        );
      }
      return deriveInlineRegex({ body: input.itemBody, pattern: input.anchorPattern });
    }
    case "feed_field": {
      if (!input.feedFields) {
        throw new Error(
          `source ${spec.source.id}: anchor_source=feed_field requires feedFields ` +
            `(only the rss strategy provides these)`,
        );
      }
      return deriveFeedField({
        pubDate: input.feedFields.pubDate,
        guid: input.feedFields.guid,
      });
    }
    case "none": {
      return null;
    }
  }
}

// Re-export types from the local types file so the barrel can
// import from a single path.
export type {
  AnchorMechanism,
  AnchorSpec,
  AnchorDeriveInput,
  AnchorType,
  DerivedAnchor,
} from "./types.js";
