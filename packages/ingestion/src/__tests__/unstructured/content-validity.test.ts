/**
 * Tests for content-validity sanitization (ADR §9.5).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { validateContent } from "../../sources/unstructured/content-validity.js";

describe("content-validity", () => {
  it("passes clean text through unchanged", () => {
    const text = "## 2026-08-20\n\nAdded new API endpoint.";
    const result = validateContent({ cleanedText: text });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sanitized, text);
      assert.equal(result.stripped, false);
    }
  });

  it("rejects when the entire response is challenge chrome", () => {
    const text = "hCaptcha challenge\ncf-challenge widget\nPlease verify you are human";
    const result = validateContent({ cleanedText: text });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "challenge_only");
    }
  });

  it("strips challenge chrome but keeps real content when both are present", () => {
    const text = [
      "hCaptcha challenge widget",
      "cf-challenge page detected",
      "",
      "## 2026-08-20",
      "",
      "Added support for new event types in the API.",
    ].join("\n");
    const result = validateContent({ cleanedText: text });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.stripped, true);
      assert.ok(!result.sanitized.includes("hCaptcha"), "chrome should be stripped");
      assert.ok(!result.sanitized.includes("cf-challenge"), "chrome should be stripped");
      assert.ok(result.sanitized.includes("2026-08-20"), "real content preserved");
      assert.ok(result.sanitized.includes("Added support"), "real content preserved");
    }
  });

  it("treats empty input as clean (not challenge-only)", () => {
    const result = validateContent({ cleanedText: "" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sanitized, "");
    }
  });

  it("treats whitespace-only input as clean", () => {
    const result = validateContent({ cleanedText: "   \n\n  \n" });
    assert.equal(result.ok, true);
  });

  it("strips mixed-case variants of the blacklist patterns", () => {
    const text = "HCAPTCHA detected\n## 2026-08-20\nActual content here";
    const result = validateContent({ cleanedText: text });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(!result.sanitized.includes("HCAPTCHA"));
      assert.ok(result.sanitized.includes("Actual content"));
    }
  });
});
