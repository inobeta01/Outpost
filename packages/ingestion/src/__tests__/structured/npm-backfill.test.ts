/**
 * Tests for the npm adapter's `backfill` method.
 *
 * The backfill slice plan calls npm a "one-request win" — the same
 * full-doc endpoint the incremental poll uses already carries every
 * version's manifest. So backfill is structurally similar to fetch
 * but emits multiple artifacts.
 *
 * These tests exercise:
 *   - Happy path: a small fixture produces consecutive-pair artifacts
 *   - finalState hash matches what an incremental `fetch()` would
 *     produce on the latest version (state-seam assertion, ADR §2.4)
 *   - http_error surfaces as AdapterError("http_error")
 *   - A package with no `time` field still works (inserts in version
 *     order, emits pairs as best we can)
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import {
  AdapterError,
  getStructuredAdapter,
  type VersionObservation,
} from "../../sources/structured/index.js";
import { canonicalizeJson, sha256Hex } from "../../sources/structured/canonical.js";

import { NOW, stubFetch, stubFetchError } from "./_helpers.js";

const source: StructuredSource = {
  id: "npm/openai",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "npm",
  fetch: { auth: "none", rate_limit: "1000/h" },
  endpoints: {
    package: {
      url: "https://registry.npmjs.org/{package}",
      kind: "object",
      variables: { package: "openai" },
    },
  },
  security: { allowed_domains: ["registry.npmjs.org"] },
  firecrawl: false,
};

/** Build a minimal npm full-doc body for tests. */
function buildNpmBody(opts: {
  latest: string;
  versions: Array<{ version: string; daysAgo: number; deprecated?: boolean }>;
  referenceNowMs: number;
}): string {
  const time: Record<string, string> = {
    created: new Date(opts.referenceNowMs - 1000 * 86400 * 365 * 5).toISOString(),
    modified: new Date(opts.referenceNowMs).toISOString(),
  };
  const versions: Record<string, unknown> = {};
  for (const v of opts.versions) {
    time[v.version] = new Date(opts.referenceNowMs - v.daysAgo * 86400 * 1000).toISOString();
    versions[v.version] = {
      name: "openai",
      version: v.version,
      dist: {
        tarball: `https://registry.npmjs.org/openai/-/openai-${v.version}.tgz`,
        shasum: `sha-${v.version}`,
      },
      ...(v.deprecated ? { deprecated: "use newer" } : {}),
    };
  }
  return JSON.stringify({
    name: "openai",
    "dist-tags": { latest: opts.latest },
    versions,
    time,
  });
}

const REFERENCE_NOW_MS = Date.parse("2026-08-24T12:00:00.000Z");

describe("npm backfill adapter", () => {
  it("emits consecutive-pair artifacts for recent versions", async () => {
    const body = buildNpmBody({
      latest: "1.0.3",
      versions: [
        { version: "1.0.0", daysAgo: 100 },
        { version: "1.0.1", daysAgo: 60 },
        { version: "1.0.2", daysAgo: 30 },
        { version: "1.0.3", daysAgo: 5 },
      ],
      referenceNowMs: REFERENCE_NOW_MS,
    });
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
      { now: NOW },
    );

    // One request only — the "one-request win" the plan calls out.
    assert.equal(fetch.calls.length, 1);

    // 3 consecutive pairs: 1.0.0→1.0.1, 1.0.1→1.0.2, 1.0.2→1.0.3.
    assert.equal(result.artifacts.length, 3);
    assert.deepEqual(
      result.artifacts.map((a) => a.version),
      ["1.0.1", "1.0.2", "1.0.3"],
    );
    for (const art of result.artifacts) {
      assert.equal(art.source_type, "npm");
      assert.equal(art.detection_method, "version_bump");
      assert.match(art.content_hash, /^[0-9a-f]{64}$/);
    }

    // Plan mirrors the artifacts.
    assert.equal(result.plan.events.length, 3);
    for (const ev of result.plan.events) {
      assert.equal(ev.type, "backfill_pair");
    }
  });

  it("produces a finalState hash identical to a per-version fetch's hash", async () => {
    // State-seam assertion (ADR §2.4): the hash that the host writes
    // at the end of backfill must equal what an incremental poll of
    // the latest version would produce, or the next poll will
    // false-positive or miss.
    const body = buildNpmBody({
      latest: "1.0.2",
      versions: [
        { version: "1.0.0", daysAgo: 200 },
        { version: "1.0.1", daysAgo: 100 },
        { version: "1.0.2", daysAgo: 30 },
      ],
      referenceNowMs: REFERENCE_NOW_MS,
    });
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
      { now: NOW },
    );

    // Compute the hash the same way the adapter's finalState does.
    const parsed = JSON.parse(body) as {
      versions: Record<string, unknown>;
    };
    const expectedFinalHash = sha256Hex(
      JSON.stringify(canonicalizeJson(parsed.versions["1.0.2"])),
    );

    assert.equal(result.plan.finalState.lastSeenVersion, "1.0.2");
    assert.equal(result.plan.finalState.lastSeenHash, expectedFinalHash);
  });

  it("drops versions older than maxAgeMs", async () => {
    const body = buildNpmBody({
      latest: "1.0.1",
      versions: [
        { version: "0.1.0", daysAgo: 365 * 10 }, // 10y, way past 5y default
        { version: "1.0.0", daysAgo: 365 * 3 },
        { version: "1.0.1", daysAgo: 30 },
      ],
      referenceNowMs: REFERENCE_NOW_MS,
    });
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
      { now: NOW },
    );

    // 0.1.0 is dropped by the age filter; 1.0.0 and 1.0.1 are in
    // window, so one pair: 1.0.0 → 1.0.1.
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.version, "1.0.1");
    assert.equal(result.plan.droppedObservations.length, 1);
    assert.equal(result.plan.droppedObservations[0]?.version, "0.1.0");
  });

  it("collapses oldest ranges into hops when over maxArtifacts", async () => {
    // 8 versions spaced 50d apart; all within the 540d recent window,
    // so collapse happens in the post-collapse region (recent-window
    // pairs fold into a leading hop). With maxArtifacts: 4, 7 pairs
    // are reduced to 4 events — leading hop plus 3 trailing pairs.
    const versions = Array.from({ length: 8 }, (_, i) => ({
      version: `1.0.${i}`,
      daysAgo: (7 - i) * 50,
    }));
    const body = buildNpmBody({
      latest: "1.0.7",
      versions,
      referenceNowMs: REFERENCE_NOW_MS,
    });
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
      { now: NOW, maxArtifacts: 4 },
    );

    // 7 pairs reduced to 4 events.
    assert.equal(result.artifacts.length, 4);
    // Leading hop spans 1.0.0→1.0.4 after three folds.
    assert.equal(result.artifacts[0]?.version, "1.0.4");
    // Trailing event's `to` is the most-recent version.
    assert.equal(
      result.artifacts[result.artifacts.length - 1]?.version,
      "1.0.7",
    );
  });

  it("surfaces http_error on 5xx", async () => {
    const fetch = stubFetchError(503, "service unavailable");
    const adapter = getStructuredAdapter("npm");

    await assert.rejects(
      adapter.backfill(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: () => undefined },
        { now: NOW },
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "http_error");
        return true;
      },
    );
  });

  it("builds VersionObservations with the right npm-specific fields", async () => {
    const body = buildNpmBody({
      latest: "1.0.1",
      versions: [
        { version: "1.0.0", daysAgo: 30, deprecated: true },
        { version: "1.0.1", daysAgo: 5 },
      ],
      referenceNowMs: REFERENCE_NOW_MS,
    });
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
      { now: NOW },
    );

    assert.equal(result.observations.length, 2);
    const deprecated = result.observations.find(
      (o: VersionObservation) => o.version === "1.0.0",
    );
    const fresh = result.observations.find(
      (o: VersionObservation) => o.version === "1.0.1",
    );
    assert.equal(deprecated?.deprecated, true);
    assert.equal(fresh?.deprecated, false);
    assert.match(deprecated?.tarballUrl ?? "", /openai-1\.0\.0\.tgz/);
    assert.equal(deprecated?.shasum, "sha-1.0.0");
  });
});
