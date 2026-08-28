/**
 * Tests for `computeBackfillPlan` — the pure-function three-rule
 * emission model. No IO; no mocking needed.
 *
 * The rules (per the backfill slice plan):
 *   1. max_age       — drop versions older than (latest − maxAge)
 *   2. recent_window — emit consecutive pairs for recent versions
 *   3. max_artifacts — collapse oldest ranges into hops to fit
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { computeBackfillPlan, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ARTIFACTS, DEFAULT_RECENT_WINDOW_MS } from "../../sources/structured/backfill-plan.js";
import type { VersionObservation } from "../../sources/structured/types.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * ONE_DAY_MS).toISOString();
}

function makeObservations(
  versions: Array<{ version: string; daysAgo: number }>,
  now: Date,
): VersionObservation[] {
  return versions.map((v) => ({
    version: v.version,
    publishedAt: isoDaysAgo(now, v.daysAgo),
    tarballUrl: null,
    shasum: null,
    deprecated: false,
    typesPath: null,
  }));
}

describe("computeBackfillPlan", () => {
  it("returns empty plan for empty observations", () => {
    const plan = computeBackfillPlan([], { now: new Date("2026-08-24T00:00:00.000Z") });
    assert.deepEqual(plan.events, []);
    assert.deepEqual(plan.droppedObservations, []);
  });

  it("returns empty plan when only one version exists (nothing to diff)", () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const plan = computeBackfillPlan(
      makeObservations([{ version: "1.0.0", daysAgo: 10 }], now),
      { now },
    );
    assert.deepEqual(plan.events, []);
  });

  it("emits one pair for two recent versions", () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const plan = computeBackfillPlan(
      makeObservations(
        [
          { version: "1.0.0", daysAgo: 30 },
          { version: "1.0.1", daysAgo: 10 },
        ],
        now,
      ),
      { now },
    );
    assert.equal(plan.events.length, 1);
    assert.equal(plan.events[0]?.type, "backfill_pair");
    assert.equal(plan.events[0]?.fromVersion, "1.0.0");
    assert.equal(plan.events[0]?.toVersion, "1.0.1");
  });

  it("emits consecutive pairs within the recent window", () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    // recent_window defaults to 18m ≈ 547 days. All four versions
    // are within 100 days, so all three consecutive pairs emit.
    const plan = computeBackfillPlan(
      makeObservations(
        [
          { version: "1.0.0", daysAgo: 100 },
          { version: "1.0.1", daysAgo: 60 },
          { version: "1.0.2", daysAgo: 30 },
          { version: "1.0.3", daysAgo: 5 },
        ],
        now,
      ),
      { now },
    );
    assert.equal(plan.events.length, 3);
    for (const ev of plan.events) {
      assert.equal(ev.type, "backfill_pair");
    }
    assert.deepEqual(
      plan.events.map((e) => [e.fromVersion, e.toVersion]),
      [
        ["1.0.0", "1.0.1"],
        ["1.0.1", "1.0.2"],
        ["1.0.2", "1.0.3"],
      ],
    );
  });

  it("drops versions older than max_age", () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const plan = computeBackfillPlan(
      makeObservations(
        [
          { version: "0.1.0", daysAgo: 365 * 10 }, // 10y ago, way past 5y
          { version: "1.0.0", daysAgo: 365 * 3 }, // 3y ago
          { version: "1.0.1", daysAgo: 30 },
        ],
        now,
      ),
      { now, maxAgeMs: 5 * 365 * ONE_DAY_MS },
    );
    // 0.1.0 is dropped; 1.0.0 and 1.0.1 are in window, so one pair.
    assert.equal(plan.events.length, 1);
    assert.equal(plan.events[0]?.fromVersion, "1.0.0");
    assert.equal(plan.events[0]?.toVersion, "1.0.1");
    assert.equal(plan.droppedObservations.length, 1);
    assert.equal(plan.droppedObservations[0]?.version, "0.1.0");
  });

  it("collapses older versions into hops when over max_artifacts", () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    // 8 versions, 100 days apart. daysAgo 700, 600, 500 are older
    // than the 18m recent window; 400, 300, 200, 100, 0 are recent.
    // All within 5y max_age. 7 consecutive pairs are tentatively
    // emitted. We override max_artifacts to 4 to force a collapse.
    const versions = Array.from({ length: 8 }, (_, i) => ({
      version: `1.0.${i}`,
      daysAgo: (7 - i) * 100,
    }));
    const plan = computeBackfillPlan(
      makeObservations(versions, now),
      { now, maxArtifacts: 4 },
    );
    // 7 pairs exceeded 4 by 3. Older-region merges happen first
    // (collapse pairs 0-1 and 1-2 into a single hop). The recent
    // window alone (4 pairs) still exceeds the budget, so a final
    // post-collapse merge folds the leading recent pair into the
    // hop. Result: hop 1.0.0→1.0.4 plus three recent pairs.
    assert.equal(plan.events.length, 4);
    assert.equal(plan.events[0]?.type, "backfill_hop");
    assert.equal(plan.events[0]?.fromVersion, "1.0.0");
    assert.equal(plan.events[0]?.toVersion, "1.0.4");
    assert.ok((plan.events[0]?.versionCount ?? 0) >= 2);
    for (let i = 1; i < plan.events.length; i++) {
      assert.equal(plan.events[i]?.type, "backfill_pair");
    }
    // Last pair spans the most-recent version as its `to`.
    assert.equal(plan.events[plan.events.length - 1]?.toVersion, "1.0.7");
  });

  it("defaults are reasonable for production use", () => {
    // Just verify the constants are sensible — a regression here
    // would be silent and bad.
    assert.equal(DEFAULT_MAX_AGE_MS, 5 * 365 * ONE_DAY_MS);
    assert.ok(DEFAULT_RECENT_WINDOW_MS > 365 * ONE_DAY_MS); // > 1y
    assert.ok(DEFAULT_RECENT_WINDOW_MS < DEFAULT_MAX_AGE_MS);
    assert.equal(DEFAULT_MAX_ARTIFACTS, 35);
  });
});
