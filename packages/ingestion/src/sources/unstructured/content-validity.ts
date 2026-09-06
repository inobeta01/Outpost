/**
 * Content-validity sanitization (ADR §9.5).
 *
 * Firecrawl responses occasionally include prepended bot-challenge
 * UI artifacts (hCaptcha language pickers, "Please verify you are
 * human" chrome, Cloudflare challenge pages). If we hash the
 * raw response, those artifacts create false-positive "content
 * changed!" signals in P2.1, even when the actual page content
 * below them is identical between polls.
 *
 * This module runs *before* content hash computation. The rules:
 *
 *   1. If the cleaned text is ONLY challenge chrome (no real
 *      content visible) — abort the poll cycle. Surface a
 *      `fetch_warning_bot_challenge` telemetry signal. Do NOT
 *      update the content hash. (Handled at the strategy-call
 *      site; this module just returns `ok: false`.)
 *
 *   2. If challenge chrome is present alongside real content —
 *      strip the chrome blocks and return the sanitized text.
 *      The strategy proceeds to hash and route the result.
 *
 *   3. Clean text passes through unchanged.
 *
 * The blacklist is intentionally small and pattern-based, not
 * an ML detector. False negatives are preferable to false
 * positives here — over-aggressive stripping would erase real
 * changelog content.
 */

const CHALLENGE_PATTERNS: ReadonlyArray<RegExp> = [
  /hCaptcha/i,
  /cf-challenge/i,
  /enable JavaScript to continue/i,
  /please verify you are human/i,
  /checking your browser before accessing/i,
  /attention required! \| cloudflare/i,
];

/** Blacklisted lines, in order, used for stable test assertions. */
export const BOT_CHALLENGE_PATTERNS: ReadonlyArray<string> = CHALLENGE_PATTERNS.map(
  (r) => r.source,
);

/** Strip a single line and trim trailing whitespace. */
function stripChallengeLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // Preserve blank lines between content blocks; collapse
      // runs of consecutive blanks to a single blank.
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    const isChallenge = CHALLENGE_PATTERNS.some((re) => re.test(trimmed));
    if (!isChallenge) {
      kept.push(line);
    }
  }
  // Trim a leading/trailing blank line so the result doesn't
  // grow on every sanitization pass.
  while (kept.length > 0 && kept[0] === "") kept.shift();
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/** True if any challenge pattern matches anywhere in the text. */
function hasChallengeContent(text: string): boolean {
  return CHALLENGE_PATTERNS.some((re) => re.test(text));
}

/** True if the text is *only* challenge chrome and whitespace. */
function isChallengeOnly(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return false; // empty input is not "challenge only"
  return lines.every((line) => CHALLENGE_PATTERNS.some((re) => re.test(line)));
}

export interface ContentValidityInput {
  /** The cleaned text from the fetch step, before hashing. */
  readonly cleanedText: string;
}

export type ContentValidityResult =
  | { readonly ok: true; readonly sanitized: string; readonly stripped: boolean }
  | { readonly ok: false; readonly reason: "challenge_only" };

/**
 * Run content-validity sanitization. Returns either an `ok` result
 * with the (possibly stripped) text, or a `not ok` result when the
 * entire response was challenge chrome — in which case the caller
 * should abort the poll cycle without updating the content hash.
 */
export function validateContent(input: ContentValidityInput): ContentValidityResult {
  const text = input.cleanedText;
  if (!hasChallengeContent(text)) {
    // Fast path: clean text, no work to do.
    return { ok: true, sanitized: text, stripped: false };
  }
  if (isChallengeOnly(text)) {
    return { ok: false, reason: "challenge_only" };
  }
  // Mixed content — strip the chrome and return the sanitized text.
  return { ok: true, sanitized: stripChallengeLines(text), stripped: true };
}
