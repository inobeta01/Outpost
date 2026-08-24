/**
 * `url_slug` anchor source (ADR §10.2).
 *
 * Extracts the version/date from the item's own URL — *before*
 * the detail page is even fetched. This is the cheapest possible
 * anchor source (zero extra fetch) and the highest-trust path
 * for sources that embed version/date in their URL structure
 * (Stripe's `/changelog/dahlia/2026-07-29/...` is the canonical
 * example).
 *
 * The pattern comes from the source spec's `anchor_pattern`. It
 * must have at least one capture group; the first group is the
 * value we surface. The pattern is matched against the URL path
 * (not the full URL including scheme/host) so the spec can
 * describe just the path-level shape.
 *
 * Returns a `version` anchor if the captured value looks like a
 * version (starts with a digit), otherwise `date`. The
 * discriminator is intentionally simple — the downstream
 * confidence score is a better place to do nuanced classification
 * than the parser.
 */

import type { AnchorMechanism, AnchorType, DerivedAnchor } from "./types.js";

function classify(captured: string): AnchorType {
  // Heuristic: leading digit + dot suggests a semver. Anything
  // else (e.g. "2026-07-29", "aug", "dahlia") is a date-or-slug.
  return /^\d+\.\d+/.test(captured) ? "version" : "date";
}

export function deriveUrlSlug(input: {
  itemUrl: string;
  pattern: string;
}): DerivedAnchor | null {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern);
  } catch {
    return null;
  }
  const path = (() => {
    try {
      return new URL(input.itemUrl).pathname;
    } catch {
      // Not a parseable URL — try the raw input as a path.
      return input.itemUrl;
    }
  })();
  const match = path.match(re);
  if (!match?.[1]) return null;
  return {
    type: classify(match[1]),
    source: "url_slug" satisfies AnchorMechanism,
    value: match[1],
  };
}
