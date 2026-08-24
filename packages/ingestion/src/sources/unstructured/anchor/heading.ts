/**
 * `heading` anchor source (ADR §10.2).
 *
 * Scans the body text for the nearest heading (markdown `#`/`##`/`###`
 * or HTML `<h1>`/`<h2>`/`<h3>`) that matches the spec's
 * `anchor_pattern`. Returns the capture group as the value.
 *
 * Used by: `single_page`, `paginated_index`, `raw_file`, and the
 * detail-side of `index_then_detail` (when the URL doesn't carry
 * the version).
 *
 * Markdown heading rules:
 *   - 1-3 leading `#` characters
 *   - followed by a space
 *   - then the heading text up to end-of-line
 *
 * HTML heading rules:
 *   - `<h1>`, `<h2>`, or `<h3>` (with optional attributes)
 *   - capture group of the inner text
 *
 * The function returns the FIRST matching heading (by document
 * order) — for `single_page`/`raw_file` this is the most recent
 * version. For `paginated_index`, the strategy is responsible for
 * the per-entry boundary detection; this module only finds the
 * first match.
 */

import type { AnchorMechanism, AnchorType, DerivedAnchor } from "./types.js";

const MARKDOWN_HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/gm;
const HTML_HEADING_RE = /<h([1-3])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;

function classify(captured: string): AnchorType {
  return /^\d+\.\d+/.test(captured) ? "version" : "date";
}

/** Strip HTML tags from a captured heading body. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

export function deriveHeading(input: {
  body: string;
  pattern: string;
}): DerivedAnchor | null {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern);
  } catch {
    return null;
  }

  // Walk headings in document order; return the first one that
  // matches the anchor_pattern.
  const all: Array<{ text: string; index: number }> = [];
  let m: RegExpExecArray | null;
  MARKDOWN_HEADING_RE.lastIndex = 0;
  while ((m = MARKDOWN_HEADING_RE.exec(input.body)) !== null) {
    all.push({ text: m[2]!, index: m.index });
  }
  HTML_HEADING_RE.lastIndex = 0;
  while ((m = HTML_HEADING_RE.exec(input.body)) !== null) {
    all.push({ text: stripHtml(m[2]!), index: m.index });
  }
  all.sort((a, b) => a.index - b.index);

  for (const { text } of all) {
    const match = text.match(re);
    if (match?.[1]) {
      return {
        type: classify(match[1]),
        source: "heading" satisfies AnchorMechanism,
        value: match[1],
      };
    }
  }
  return null;
}
