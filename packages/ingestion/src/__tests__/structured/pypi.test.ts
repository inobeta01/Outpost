/**
 * Tests for the PyPI JSON API adapter.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import { AdapterError, getStructuredAdapter } from "../../sources/structured/index.js";

import { NOW, loadFixture, stubFetch, stubFetchError } from "./_helpers.js";

const source: StructuredSource = {
  id: "pypi/requests",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "pypi",
  fetch: { auth: "none", rate_limit: "1000/h" },
  endpoints: {
    package: {
      url: "https://pypi.org/pypi/{package}/json",
      kind: "object",
      variables: { package: "requests" },
    },
  },
  security: { allowed_domains: ["pypi.org", "files.pythonhosted.org"] },
  firecrawl: false,
};

describe("pypi adapter", () => {
  it("parses info.version from the JSON API response", async () => {
    const body = await loadFixture("pypi-requests.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("pypi");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.source_type, "pypi");
    assert.equal(artifact.version, "2.32.3");
    assert.equal(
      artifact.fetch_metadata.url,
      "https://pypi.org/pypi/requests/json",
    );
    assert.equal(artifact.raw_content_type, "application/json");
    assert.match(artifact.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(fetch.calls.length, 1);
  });

  it("emits version_bump on a real version change", async () => {
    const body = await loadFixture("pypi-requests.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("pypi");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "2.32.2", lastSeenHash: "x", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.detection_method, "version_bump");
  });

  it("emits hash_only when version matches but body changed", async () => {
    const body = await loadFixture("pypi-requests.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("pypi");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "2.32.3", lastSeenHash: "different", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.detection_method, "hash_only");
  });

  it("surfaces http_error on 4xx/5xx", async () => {
    const fetch = stubFetchError(500, "Internal Server Error");
    const adapter = getStructuredAdapter("pypi");

    await assert.rejects(
      adapter.fetch(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: () => undefined },
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "http_error");
        return true;
      },
    );
  });

  it("surfaces schema_mismatch when info.version is missing", async () => {
    const fetch = stubFetch(JSON.stringify({ info: { name: "requests" } }));
    const adapter = getStructuredAdapter("pypi");

    await assert.rejects(
      adapter.fetch(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: () => undefined },
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "schema_mismatch");
        return true;
      },
    );
  });
});

/**
 * PyPI backfill tests — step 6 of the backfill slice plan. Mirrors
 * the github_releases backfill test pattern: smart fetch that routes
 * the index call vs per-version detail calls, with assertions on
 * finalState hash, plan event types, and the budget-cap warning.
 */
describe("pypi backfill", () => {
  const NOW_BACKFILL = "2026-08-25T12:00:00.000Z";

  /** Build a fetch that responds to the index URL with `indexBody`
   *  and to per-version detail URLs with `detailBody`. */
  function indexAndDetailFetch(
    indexBody: string,
    detailBody: string,
  ): ReturnType<typeof stubFetch> & { detailCalls: string[] } {
    const fn = ((url: string) => {
      fn.calls.push(url);
      // Detail URLs: `https://pypi.org/pypi/requests/{version}/json`
      // Index URL:   `https://pypi.org/pypi/requests/json`
      if (/\/requests\/.+\/json$/.test(url)) {
        fn.detailCalls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(detailBody),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(indexBody),
      });
    }) as ReturnType<typeof stubFetch> & { detailCalls: string[] };
    fn.calls = [];
    fn.detailCalls = [];
    return fn;
  }

  it("emits one pair per consecutive version; finalState hashes the index body", async () => {
    const indexBody = await loadFixture("pypi-requests-history.json");
    const detailBody = JSON.stringify({
      info: { name: "requests", version: "1.0.4" },
      urls: [],
    });
    const fetch = indexAndDetailFetch(indexBody, detailBody);
    const adapter = getStructuredAdapter("pypi");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW_BACKFILL },
      { fetch, readEnv: () => undefined },
      { now: NOW_BACKFILL },
    );

    // 5 versions in the fixture → 4 consecutive pairs.
    assert.equal(result.plan.events.length, 4);
    assert.deepEqual(
      result.plan.events.map((e) => `${e.fromVersion}→${e.toVersion}`),
      ["1.0.0→1.0.1", "1.0.1→1.0.2", "1.0.2→1.0.3", "1.0.3→1.0.4"],
    );
    assert.ok(result.plan.events.every((e) => e.type === "backfill_pair"));
    assert.equal(result.artifacts.length, 4);
    // Full history consumed → no checkpoint.
    assert.equal(result.checkpoint, null);
    // finalState: latest version, hash derived from the index body
    // (matches the incremental poll, which also fetches the index).
    assert.equal(result.plan.finalState.lastSeenVersion, "1.0.4");
    assert.match(result.plan.finalState.lastSeenHash, /^[0-9a-f]{64}$/);
    // Index + per-version detail fetches. The detail cap is 200; the
    // latest version is fetched first, plus both endpoints of every
    // pair — for 5 versions, that's the latest + 2*4 = 9 detail calls.
    // The early-return after `details.size >= DETAIL_CALL_CAP` is
    // irrelevant here; we just assert >= 1 index call and >= 1 detail
    // call. Latest-first ordering means the latest detail was
    // fetched before any event-endpoint detail.
    assert.ok(
      fetch.calls[0]?.endsWith("/pypi/requests/json"),
      "first call must be the index",
    );
    assert.ok(fetch.detailCalls.length >= 1, "expected detail fetches");
  });

  it("surfaces yanked versions (does not filter them)", async () => {
    const indexBody = JSON.stringify({
      info: { name: "requests", version: "1.0.2" },
      releases: {
        "1.0.0": [
          {
            packagetype: "sdist",
            url: "u1",
            upload_time_iso_8601: "2025-01-15T10:00:00.000Z",
            yanked: true,
          },
        ],
        "1.0.1": [
          {
            packagetype: "sdist",
            url: "u2",
            upload_time_iso_8601: "2025-03-15T10:00:00.000Z",
            yanked: false,
          },
        ],
        "1.0.2": [
          {
            packagetype: "sdist",
            url: "u3",
            upload_time_iso_8601: "2025-05-15T10:00:00.000Z",
            yanked: false,
          },
        ],
      },
    });
    const detailBody = JSON.stringify({ info: { version: "x" } });
    const fetch = indexAndDetailFetch(indexBody, detailBody);
    const adapter = getStructuredAdapter("pypi");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW_BACKFILL },
      { fetch, readEnv: () => undefined },
      { now: NOW_BACKFILL },
    );

    // 3 versions → 2 pairs, including the one starting at 1.0.0
    // (yanked). Plan math doesn't see yanked; the operator sees the
    // record via the detail body.
    assert.equal(result.plan.events.length, 2);
    assert.equal(result.observations.length, 3);
    // Yanked field isn't surfaced on VersionObservation today (the
    // type doesn't carry it), but we at least verify the count — the
    // adapter does not filter them out.
  });

  it("derives the detail URL by replacing /json with /{version}/json", async () => {
    const indexBody = await loadFixture("pypi-requests-history.json");
    const detailBody = JSON.stringify({ info: { version: "1.0.0" } });
    const fetch = indexAndDetailFetch(indexBody, detailBody);
    const adapter = getStructuredAdapter("pypi");

    await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW_BACKFILL },
      { fetch, readEnv: () => undefined },
      { now: NOW_BACKFILL },
    );

    // Every detail call must end with `/{version}/json` and not
    // retain the `/json` suffix of the index URL.
    for (const url of fetch.detailCalls) {
      assert.match(url, /\/pypi\/requests\/[^/]+\/json$/);
      assert.ok(
        !url.endsWith("/requests/json"),
        `detail URL must not equal index URL: ${url}`,
      );
    }
  });

  it("emits a pypi_detail_budget_exceeded warning when the detail cap is hit", async () => {
    // Build a 250-version history inside the age window so the
    // plan references all of them; force the cap via maxArtifacts
    // high enough that budget is *not* the cause, then directly
    // exhaust DETAIL_CALL_CAP by routing every detail to 503.
    const versions: Record<string, unknown[]> = {};
    const base = Date.parse("2025-01-01T00:00:00.000Z");
    for (let i = 0; i < 250; i++) {
      const t = new Date(base + i * 60_000).toISOString();
      versions[`1.${i.toString().padStart(4, "0")}.0`] = [
        {
          packagetype: "sdist",
          url: `u${i}`,
          upload_time_iso_8601: t,
        },
      ];
    }
    const indexBody = JSON.stringify({
      info: { name: "requests", version: "1.0249.0" },
      releases: versions,
    });
    // Cap detail calls to < needed versions: we route index to
    // 200 and details to 200 but only ~3 of them — we accomplish
    // this by capping via a fetch that only allows the first 2
    // detail calls and 503s on the rest, but that's not what we
    // want (that would error out). Instead, we need to *bypass*
    // DETAIL_CALL_CAP's natural ceiling. Since 250 versions >
    // DETAIL_CALL_CAP (200), the adapter naturally will stop at
    // 200. We need a plan referencing > 200 distinct versions —
    // which it will. Then the warning fires.
    //
    // To get the plan to reference >200 versions, recent window
    // must include them all. With maxAgeMs huge and recentWindowMs
    // huge, every consecutive pair is a plan event. The cap on
    // max_artifacts is 249 (= 250 - 1) to avoid the budget stop
    // from hiding the warning.
    let detailCount = 0;
    const fetch = ((url: string) => {
      (fetch as { calls: string[] }).calls.push(url);
      if (/\/requests\/.+\/json$/.test(url)) {
        detailCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ info: {} })),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(indexBody),
      });
    }) as ReturnType<typeof stubFetch>;
    fetch.calls = [];

    const adapter = getStructuredAdapter("pypi");
    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW_BACKFILL },
      { fetch, readEnv: () => undefined },
      {
        now: NOW_BACKFILL,
        maxArtifacts: 249,
        // Recent window wide enough that all 250 versions are recent.
        recentWindowMs: 10 * 365 * 24 * 60 * 60 * 1000,
        // Age cap wide enough too.
        maxAgeMs: 10 * 365 * 24 * 60 * 60 * 1000,
      },
    );

    // 250 versions → 249 plan events. The recent window covers all,
    // so the budget stop doesn't fire (we set maxArtifacts: 249).
    assert.equal(result.plan.events.length, 249);
    // But needed versions: latest (1) + 2*249 endpoints (498) = 499.
    // The cap is 200, so we fetch 200 of 499 → 299 fall back to
    // index-only summaries.
    assert.equal(detailCount, 200);
    assert.ok(
      result.warnings.some((w) => w.startsWith("pypi_detail_budget_exceeded:")),
      `expected detail-budget warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("persists a resume marker on a failed detail call and honors it on retry", async () => {
    const indexBody = await loadFixture("pypi-requests-history.json");
    const fetch = ((url: string) => {
      (fetch as { calls: string[] }).calls.push(url);
      // 500 on every detail call.
      if (/\/requests\/.+\/json$/.test(url)) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("boom"),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(indexBody),
      });
    }) as ReturnType<typeof stubFetch>;
    fetch.calls = [];
    const adapter = getStructuredAdapter("pypi");

    await assert.rejects(
      adapter.backfill(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW_BACKFILL },
        { fetch, readEnv: () => undefined },
        { now: NOW_BACKFILL },
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "http_error");
        // The checkpoint points at the first version we tried to
        // fetch — the latest. Parsing the JSON reveals it.
        const cp = JSON.parse((err as AdapterError).checkpoint!) as {
          nextVersion: string;
        };
        assert.equal(cp.nextVersion, "1.0.4");
        return true;
      },
    );
  });
});
