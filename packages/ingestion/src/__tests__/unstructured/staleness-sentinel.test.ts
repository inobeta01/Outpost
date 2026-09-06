/**
 * Tests for staleness-sentinel (ADR §9.6).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkStaleness } from "../../sources/unstructured/staleness-sentinel.js";

const NOW = "2026-08-24T12:00:00.000Z";

describe("staleness-sentinel", () => {
  it("is active on the first poll (no last-change timestamp)", () => {
    const result = checkStaleness({
      sourceId: "stripe.com/changelog",
      lastContentHashChangeAt: null,
      now: NOW,
    });
    assert.equal(result.state, "active");
  });

  it("is active when the gap is within the default 90-day threshold", () => {
    const result = checkStaleness({
      sourceId: "x.com/y",
      lastContentHashChangeAt: "2026-08-01T00:00:00.000Z", // 23 days ago
      now: NOW,
    });
    assert.equal(result.state, "active");
  });

  it("is stale when the gap exceeds 90 days", () => {
    const result = checkStaleness({
      sourceId: "abandoned.com/page",
      lastContentHashChangeAt: "2026-04-01T00:00:00.000Z", // ~145 days ago
      now: NOW,
    });
    assert.equal(result.state, "stale");
    if (result.state === "stale") {
      assert.equal(result.sourceId, "abandoned.com/page");
      assert.equal(result.telemetryEvent, "SOURCE_STALENESS_THRESHOLD_EXCEEDED");
      assert.ok(result.daysInactive > 90);
      assert.equal(result.thresholdDays, 90);
    }
  });

  it("respects a custom max_inactivity_days from the spec", () => {
    const result = checkStaleness({
      sourceId: "x.com/y",
      lastContentHashChangeAt: "2026-07-15T00:00:00.000Z", // 40 days ago
      now: NOW,
      maxInactivityDays: 30,
    });
    assert.equal(result.state, "stale");
    if (result.state === "stale") {
      assert.equal(result.thresholdDays, 30);
    }
  });

  it("treats malformed timestamps as active (no spurious alerts)", () => {
    const result = checkStaleness({
      sourceId: "x.com/y",
      lastContentHashChangeAt: "not a date",
      now: NOW,
    });
    assert.equal(result.state, "active");
  });
});
