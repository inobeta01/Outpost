/**
 * Tests for the version-anchor normalization utility.
 *
 * Version-join pattern needs to match a version string from the
 * structured adapter (e.g. "2.32.4") against an anchor extracted
 * from a URL slug (e.g. "v2-32-4") or heading (e.g. "v2.32.4").
 *
 * The normalization handles:
 *   - Leading "v" prefix
 *   - Dashes vs dots
 *   - Case differences
 *   - Trailing whitespace
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  anchorMatchesVersion,
  normalizeVersionForAnchor,
} from "../../sources/structured/version-anchor.js";

describe("normalizeVersionForAnchor", () => {
  it("strips a leading 'v' prefix", () => {
    assert.equal(normalizeVersionForAnchor("v2.32.4"), "2.32.4");
    assert.equal(normalizeVersionForAnchor("V2.32.4"), "2.32.4");
  });

  it("preserves dots", () => {
    assert.equal(normalizeVersionForAnchor("2.32.4"), "2.32.4");
    assert.equal(normalizeVersionForAnchor("2024.09.15"), "2024.09.15");
  });

  it("lowercases", () => {
    assert.equal(normalizeVersionForAnchor("V2.32.4-BETA"), "2.32.4-beta");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeVersionForAnchor("  2.32.4  "), "2.32.4");
  });

  it("preserves dashes (so '2-32-4' stays as '2-32-4')", () => {
    // Dashes are NOT converted to dots automatically. The match
    // function compares both sides post-normalization, so a
    // version like "2.32.4" will NOT match an anchor "2-32-4" —
    // the spec author is expected to choose an anchor pattern
    // that captures the dotted form, OR a strategy that produces
    // the dotted form.
    assert.equal(normalizeVersionForAnchor("2-32-4"), "2-32-4");
  });

  it("preserves pre-release suffixes with their dot", () => {
    assert.equal(
      normalizeVersionForAnchor("v2.32.4-beta.1"),
      "2.32.4-beta.1",
    );
  });
});

describe("anchorMatchesVersion", () => {
  it("matches v2.32.4 anchor against 2.32.4 version", () => {
    assert.equal(anchorMatchesVersion("v2.32.4", "2.32.4"), true);
  });

  it("matches 2-32-4 anchor (URL slug) against 2-32-4 version (both dashed)", () => {
    // If the spec author configures the structured adapter to
    // report "2-32-4" (rare, but possible) AND the anchor captures
    // the same form, the match works. The version-join does NOT
    // bridge the dash/dot divide — that's the spec author's job
    // (e.g. configure the adapter to use one form consistently,
    // or pick an anchor that captures the same form).
    assert.equal(anchorMatchesVersion("2-32-4", "2-32-4"), true);
  });

  it("matches case-insensitively", () => {
    assert.equal(anchorMatchesVersion("V2.32.4", "2.32.4"), true);
    assert.equal(anchorMatchesVersion("v2.32.4", "2.32.4"), true);
  });

  it("trims whitespace on both sides", () => {
    assert.equal(anchorMatchesVersion("  v2.32.4  ", "  2.32.4  "), true);
  });

  it("returns false for different versions", () => {
    assert.equal(anchorMatchesVersion("2.32.3", "2.32.4"), false);
  });

  it("returns false for unrelated strings", () => {
    assert.equal(anchorMatchesVersion("hello", "2.32.4"), false);
  });

  it("matches pre-release versions on both sides", () => {
    assert.equal(
      anchorMatchesVersion("v2.32.4-beta.1", "2.32.4-beta.1"),
      true,
    );
  });

  it("matches calver dates (ISO-like format)", () => {
    assert.equal(anchorMatchesVersion("2024.09.15", "2024.09.15"), true);
  });
});
