/**
 * Version normalization for the version-join pattern.
 *
 * Vendors use different formats for versions in different places:
 *   - Structured adapter reports: `2.32.4` (semver, dots)
 *   - URL slug:                   `v2-32-4` or `2-32-4` (dashes)
 *   - Heading:                    `v2.32.4` or `Release 2.32.4`
 *   - Inline regex capture:       `2.32.4` (matches the structured)
 *
 * To do the version-join, we need a canonical form that the same
 * string regardless of where it came from. The canonical form is:
 *   - Lowercase
 *   - Leading `v` stripped
 *   - Dots preserved (most semver/calver forms are dot-separated)
 *   - Trailing whitespace stripped
 *
 * This is a deliberately narrow normalization. It handles the
 * common cases (`v2.32.4`, `2-32-4`, `2.32.4`) without trying to
 * be a full version parser. For calver (`2024.09.15`) the form
 * is already canonical. For pre-release suffixes (`2.32.4-beta.1`)
 * the dot is preserved as part of the suffix; we don't try to
 * split suffix from version.
 *
 * If a future vendor uses a separator we don't handle (e.g.
 * `2_32_4`), add it here as an additional substitution.
 */
export function normalizeVersionForAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^v/, "");
}

/**
 * Check whether an extracted anchor (from URL slug, heading, etc.)
 * matches a structured adapter's reported version.
 *
 * The matching is normalization-based: both sides go through
 * `normalizeVersionForAnchor` and are compared as strings. This
 * handles `2-32-4` vs `2.32.4`, `v2.32.4` vs `2.32.4`, and case
 * differences.
 *
 * It does NOT handle semver ordering (e.g. `1.9.0` vs `1.10.0`).
 * For semver, the structured adapter's `latest` is authoritative
 * and the join is on string equality after normalization. If two
 * versions normalize to the same string but the structured adapter
 * distinguishes them, that's a vendor problem (e.g. mixing semver
 * and calver in the same source), not a join problem.
 *
 * @param anchor The value extracted from the entry (URL slug, heading, etc.)
 * @param version The version reported by the structured adapter
 * @returns true if the entry is the one for this version
 */
export function anchorMatchesVersion(
  anchor: string,
  version: string,
): boolean {
  return normalizeVersionForAnchor(anchor) === normalizeVersionForAnchor(version);
}
