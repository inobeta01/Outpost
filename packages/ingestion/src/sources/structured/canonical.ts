/**
 * Canonicalization + hashing helpers shared by every structured adapter.
 *
 * The content_hash on a `NormalizedArtifact` is always SHA-256 of
 * a canonicalized form of the response body, never of the raw bytes.
 * The reason: two semantically identical responses that differ in
 * whitespace, key order, or trailing newline should produce the same
 * hash, or every minor upstream change is a false-positive "change"
 * signal that P2.1 has to filter.
 *
 * Two strategies:
 *   - `canonicalizeJson` — for endpoints that return JSON (npm
 *     registry, PyPI JSON API, GitHub Releases). Sorts object keys
 *     recursively at every depth; no whitespace.
 *   - `canonicalizeText` — for non-JSON text (YAML, plain text).
 *     Normalizes line endings to LF, strips trailing whitespace
 *     per line, and trims a single trailing newline.
 *
 * Both return a string the adapter can pass straight to `sha256Hex`.
 */

import { createHash } from "node:crypto";

/**
 * Recursively walk a JSON value, returning a new value with all
 * object keys sorted lexicographically. Arrays preserve order
 * (semantic for the structured endpoints we hit). Numbers, strings,
 * booleans, and `null` pass through unchanged.
 *
 * This is a defensive deep-clone — it never mutates the input.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeJson(v));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalizeJson(obj[k]);
  }
  return out;
}

/**
 * Normalize a free-form text body to a stable form for hashing.
 * - CRLF and CR line endings → LF
 * - Trailing whitespace per line trimmed
 * - Exactly one trailing newline (or zero, if the input had none)
 */
export function canonicalizeText(input: string): string {
  const lf = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  // Collapse trailing blank lines to a single one.
  return trimmed.replace(/\n*$/, "\n");
}

/**
 * SHA-256 of a string, hex-encoded. Use UTF-8 encoding for the
 * input — canonicalizeJson output is ASCII; canonicalizeText
 * output is whatever the source had (most YAML/changelog files
 * are ASCII or valid UTF-8).
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Convenience: canonicalize JSON and hash in one call. Adapters
 * that fetch JSON endpoints (npm, PyPI, GitHub Releases) call this.
 */
export function hashJson(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalizeJson(value)));
}

/**
 * Convenience: canonicalize text and hash. Adapters that fetch
 * non-JSON endpoints (OpenAPI YAML, raw files) call this.
 */
export function hashText(value: string): string {
  return sha256Hex(canonicalizeText(value));
}
