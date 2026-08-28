/**
 * Tests for the GitHub Releases adapter.
 *
 * Notes:
 *   - Version signal is the release `id` (numeric, monotonic), not
 *     `tag_name`. Tests use the id from the fixture.
 *   - Drafts and prereleases are filtered out — tests use a clean
 *     published-only fixture.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import { AdapterError, getStructuredAdapter } from "../../sources/structured/index.js";

import { NOW, envWith, loadFixture, stubFetch, stubFetchError } from "./_helpers.js";

const source: StructuredSource = {
  id: "github.com/anthropics/anthropic-sdk-typescript",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "github_releases",
  fetch: { auth: "github_token_env", rate_limit: "5000/h" },
  endpoints: {
    releases: {
      url: "https://api.github.com/repos/{owner}/{repo}/releases",
      kind: "list",
      variables: { owner: "anthropics", repo: "anthropic-sdk-typescript" },
    },
  },
  security: { allowed_domains: ["api.github.com"] },
  firecrawl: false,
};

describe("github_releases adapter", () => {
  it("parses the first release's id as the version signal", async () => {
    const body = await loadFixture("github-releases-anthropic-sdk.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("github_releases");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.source_type, "github_releases");
    // The first release in our fixture has id 12345.
    assert.equal(artifact.version, "12345");
    assert.equal(
      artifact.fetch_metadata.url,
      "https://api.github.com/repos/anthropics/anthropic-sdk-typescript/releases",
    );
    assert.match(artifact.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(fetch.calls.length, 1);
  });

  it("emits version_bump when the release id differs from last-seen", async () => {
    const body = await loadFixture("github-releases-anthropic-sdk.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("github_releases");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "12000", lastSeenHash: "x", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.version, "12345");
    assert.equal(artifact.detection_method, "version_bump");
  });

  it("filters drafts and prereleases", async () => {
    // Fixture has 1 draft + 1 prerelease at the top of the array.
    // The first published release (id 99999) should win.
    const body = await loadFixture("github-releases-with-drafts.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("github_releases");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.version, "99999");
  });

  it("surfaces http_error on rate-limit 403", async () => {
    const fetch = stubFetchError(403, "API rate limit exceeded");
    const adapter = getStructuredAdapter("github_releases");

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

  it("surfaces schema_mismatch when no published releases exist", async () => {
    const fetch = stubFetch(
      JSON.stringify([
        { id: 1, tag_name: "v0.0.1", draft: true },
        { id: 2, tag_name: "v0.0.2", prerelease: true },
      ]),
    );
    const adapter = getStructuredAdapter("github_releases");

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
 * A `fetch` stub that serves per-page bodies keyed by page number.
 * Tracks every requested URL so tests can assert pagination order.
 */
function pageFetch(
  pages: ReadonlyArray<string>,
  opts: { failFrom?: number } = {},
) {
  const calls: string[] = [];
  const fn = ((url: string) => {
    calls.push(url);
    const m = /[?&]page=(\d+)$/.exec(url);
    const page = m ? Number(m[1]) : 1;
    if (opts.failFrom !== undefined && page >= opts.failFrom) {
      return Promise.resolve({
        ok: false,
        status: 403,
        text: () => Promise.resolve("API rate limit exceeded"),
      });
    }
    const body = pages[page - 1];
    if (body === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    });
  }) as unknown as ReturnType<typeof stubFetch>;
  fn.calls = calls;
  return fn;
}

function release(id: number, daysAgo: number, extra: Record<string, unknown> = {}) {
  const publishedAt = new Date(
    Date.parse(NOW) - daysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
  return { id, tag_name: `v1.0.${id}`, published_at: publishedAt, ...extra };
}

const PAGE_QUERY = /per_page=100&page=(\d+)/;

describe("github_releases backfill", () => {
  const backfillOpts = (over: Record<string, unknown> = {}) => ({
    now: NOW,
    ...over,
  });

  it("single page: emits one artifact per consecutive pair, latest-id finalState", async () => {
    const body = JSON.stringify([
      release(103, 0),
      release(102, 10),
      release(101, 20),
    ]);
    const fetch = pageFetch([body]);
    const adapter = getStructuredAdapter("github_releases");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: envWith("tok") },
      backfillOpts(),
    );

    assert.equal(result.plan.events.length, 2);
    assert.deepEqual(
      result.plan.events.map((e) => [e.fromVersion, e.toVersion]),
      [["101", "102"], ["102", "103"]],
    );
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.artifacts[0]?.version, "102");
    assert.equal(result.artifacts[0]?.detection_method, "version_bump");
    // State seam: highest-id release is the finalState version.
    assert.equal(result.plan.finalState.lastSeenVersion, "103");
    assert.match(result.plan.finalState.lastSeenHash, /^[0-9a-f]{64}$/);
    // Full history consumed → no checkpoint.
    assert.equal(result.checkpoint, null);
    // Only one request, page 1.
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0]!, PAGE_QUERY);
  });

  it("walks multiple pages until a short page, pacing between requests", async () => {
    // Page 1: exactly 100 items (full page → keep going).
    // Page 2: 3 items (short → stop).
    // maxArtifacts raised above the collected count so the budget
    // stop doesn't fire — this test isolates the pagination walk.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      release(1000 + (99 - i), 200 - i),
    );
    const page2 = JSON.stringify([release(899, 402), release(898, 403), release(897, 404)]);
    const fetch = pageFetch([JSON.stringify(page1), page2]);
    const adapter = getStructuredAdapter("github_releases");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: envWith("tok") },
      backfillOpts({ maxArtifacts: 200 }),
    );

    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[0]!, /page=1$/);
    assert.match(fetch.calls[1]!, /page=2$/);
    // Newest release is id 1099 (most recent in page 1).
    assert.equal(result.plan.finalState.lastSeenVersion, "1099");
    // 103 collected versions → 102 consecutive pairs, no collapse.
    assert.equal(result.plan.events.length, 102);
    assert.equal(result.checkpoint, null);
    assert.ok(result.plan.events.every((e) => e.type === "backfill_pair"));
  });

  it("budget stop persists a checkpoint pointing at the next page", async () => {
    // Page 1: 100 items → budget (maxArtifacts 4 → stops after 5
    // collected) with a full page remaining → checkpoint page 2.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      release(2000 + (99 - i), 100 - i),
    );
    const fetch = pageFetch([JSON.stringify(page1)]);
    const adapter = getStructuredAdapter("github_releases");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: envWith("tok") },
      backfillOpts({ maxArtifacts: 4 }),
    );

    assert.equal(result.checkpoint, JSON.stringify({ nextPage: 2 }));
    // Only page 1 fetched — page 2 never requested after budget stop.
    assert.equal(fetch.calls.length, 1);
    // Events capped at the budget.
    assert.ok(result.plan.events.length <= 4);
  });

  it("requires GITHUB_TOKEN when auth is github_token_env", async () => {
    const fetch = pageFetch([JSON.stringify([release(1, 1)])]);
    const adapter = getStructuredAdapter("github_releases");

    await assert.rejects(
      adapter.backfill(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: () => undefined },
        backfillOpts(),
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "missing_auth");
        return true;
      },
    );
    // No requests were made without a token.
    assert.equal(fetch.calls.length, 0);
  });

  it("403 mid-pagination fails with a checkpoint for resume", async () => {
    // Page 1 is full (100 items) so pagination continues to page 2,
    // which 403s. The error must carry the page-2 resume marker.
    const page1 = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => release(3030 + (99 - i), 50 - i)),
    );
    const fetch = pageFetch([page1], { failFrom: 2 });
    const adapter = getStructuredAdapter("github_releases");

    await assert.rejects(
      adapter.backfill(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: envWith("tok") },
        // Raise the budget above the page-1 count so the budget stop
        // doesn't fire before the 403 is exercised.
        backfillOpts({ maxArtifacts: 200 }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "http_error");
        // The error carries the resume marker for the host to persist.
        assert.equal(
          (err as AdapterError).checkpoint,
          JSON.stringify({ nextPage: 2 }),
        );
        return true;
      },
    );
  });

  it("resumes from a persisted checkpoint instead of restarting", async () => {
    const page2 = JSON.stringify([release(402, 0), release(401, 1)]);
    const fetch = pageFetch([JSON.stringify([]), page2]);
    const adapter = getStructuredAdapter("github_releases");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: envWith("tok") },
      backfillOpts({ checkpoint: JSON.stringify({ nextPage: 2 }) }),
    );

    // First request is page 2, not page 1.
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0]!, /page=2$/);
    assert.equal(result.plan.events.length, 1);
    assert.deepEqual(
      result.plan.events[0],
      { type: "backfill_pair", fromVersion: "401", toVersion: "402" },
    );
  });

  it("filters drafts and prereleases from the plan", async () => {
    const body = JSON.stringify([
      release(504, 0),
      release(503, 1, { draft: true }),
      release(502, 2, { prerelease: true }),
      release(501, 3),
    ]);
    const fetch = pageFetch([body]);
    const adapter = getStructuredAdapter("github_releases");

    const result = await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: envWith("tok") },
      backfillOpts(),
    );

    assert.deepEqual(
      result.plan.events.map((e) => [e.fromVersion, e.toVersion]),
      [["501", "504"]],
    );
  });

  it("sends the Authorization header on every page request", async () => {
    const body = JSON.stringify([release(601, 0), release(600, 1)]);
    let seenHeaders: Array<Record<string, string> | undefined> = [];
    const fetch = pageFetch([body]);
    const origFn = fetch as unknown as (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>;
    const wrapped = ((url: string, init?: { headers?: Record<string, string> }) => {
      seenHeaders.push(init?.headers);
      return origFn(url, init);
    }) as unknown as typeof fetch;
    const adapter = getStructuredAdapter("github_releases");

    await adapter.backfill(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch: wrapped, readEnv: envWith("tok") },
      backfillOpts(),
    );
    assert.equal(seenHeaders.length, 1);
    assert.equal(seenHeaders[0]?.Authorization, "Bearer tok");
  });
});
