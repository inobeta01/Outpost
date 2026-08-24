/**
 * `feed_field` anchor source (ADR §10.2, §9.4 strategy 5).
 *
 * Reads the structured metadata from an RSS/Atom feed `<item>` —
 * specifically `<pubDate>` and `<guid>`. These are vendor-asserted
 * (Tier 1 trust per ADR §5) — no regex parsing required.
 *
 * Priority: `pubDate` first (always present on well-formed feeds,
 * and gives a sortable time), `guid` second (always unique per
 * item, but opaque). If neither is available the strategy should
 * be using a different anchor source — this function returns
 * `null` in that case.
 *
 * The `anchor_pattern` from the spec is IGNORED here — feed fields
 * are structured, not pattern-matched. If a spec configures
 * `anchor_source: "feed_field"` AND provides an `anchor_pattern`,
 * the pattern is silently ignored. The schema validation permits
 * this for ergonomics (one less required-vs-optional branch).
 *
 * For RFC 822 date format (the standard for RSS pubDate), we
 * return the raw value — no normalization. The downstream
 * `detected_at` and ChangeEvent time-stamping use the host
 * loop's `now`; the pubDate here is the *anchor value*, not
 * the *event time*. Both are useful; conflating them is what
 * the trust-tier system is designed to prevent.
 */

import type { AnchorMechanism, AnchorType, DerivedAnchor } from "./types.js";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

function classify(value: string): AnchorType {
  // GUIDs aren't versions or dates in the human sense — we tag
  // them as "date" so they participate in time-ordering by the
  // feed's chronology. The downstream consumer sees a `guid:`
  // and knows it's a stable opaque ID, not a calendar date.
  if (isIsoDate(value) || GUID_RE.test(value) || /^\d{4}/.test(value)) {
    return "date";
  }
  // RFC 822 pubDate (e.g. "Mon, 20 Aug 2026 15:30:00 GMT") also
  // starts with a day name, not a digit — but the year is in
  // there. We treat anything else as `date` by default; explicit
  // version_anchored only comes from explicit version sources
  // (url_slug, heading, inline_regex with a version-shaped pattern).
  return "date";
}

export function deriveFeedField(input: {
  pubDate: string | null;
  guid: string | null;
}): DerivedAnchor | null {
  // Prefer pubDate — it's human-meaningful and time-sortable.
  if (input.pubDate) {
    return {
      type: classify(input.pubDate),
      source: "feed_field" satisfies AnchorMechanism,
      value: input.pubDate,
    };
  }
  if (input.guid) {
    return {
      type: classify(input.guid),
      source: "feed_field" satisfies AnchorMechanism,
      value: input.guid,
    };
  }
  return null;
}
