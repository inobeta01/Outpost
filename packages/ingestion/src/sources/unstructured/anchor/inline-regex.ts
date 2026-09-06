/**
 * `inline_regex` anchor source (ADR §10.2).
 *
 * Runs the spec's `anchor_pattern` against the body text directly,
 * not against any structural element. This is the fallback tier —
 * used when no heading or URL slug carries the version and the
 * version mention is embedded somewhere in the entry's prose
 * ("as of v2.4.1, ...").
 *
 * Lower confidence than heading/URL because it requires the LLM
 * to *not* have re-worded the version out of the prose. But it's
 * still better than `none` — we get a deterministic match when
 * the regex is precise.
 *
 * The pattern is matched with the `m` flag (multiline) so `^` and
 * `$` work per-line, which is the common shape for inline anchors
 * (e.g. `^Version (\d+\.\d+\.\d+)`).
 */

import type { AnchorMechanism, AnchorType, DerivedAnchor } from "./types.js";

function classify(captured: string): AnchorType {
  return /^\d+\.\d+/.test(captured) ? "version" : "date";
}

export function deriveInlineRegex(input: {
  body: string;
  pattern: string;
}): DerivedAnchor | null {
  let re: RegExp;
  try {
    // Multiline mode so ^ and $ work per-line. The spec author
    // is expected to anchor their pattern appropriately.
    re = new RegExp(input.pattern, "m");
  } catch {
    return null;
  }
  const match = input.body.match(re);
  if (!match?.[1]) return null;
  return {
    type: classify(match[1]),
    source: "inline_regex" satisfies AnchorMechanism,
    value: match[1],
  };
}
