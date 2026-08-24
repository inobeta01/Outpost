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

import { NOW, loadFixture, stubFetch, stubFetchError } from "./_helpers.js";

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
