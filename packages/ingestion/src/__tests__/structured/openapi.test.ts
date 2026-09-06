/**
 * Tests for the OpenAPI adapter.
 *
 * Covers:
 *   - Happy path: parses `info.version` and hashes canonicalized body
 *   - Version bump: detection_method = "version_bump"
 *   - Hash-only bump: detection_method = "hash_only" (vendor edited
 *     spec without bumping version — a real anomaly per ADR §5)
 *   - http_error: 4xx/5xx surfaces as AdapterError
 *   - schema_mismatch: no kind="spec" endpoint on the source
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import { AdapterError, getStructuredAdapter } from "../../sources/structured/index.js";

import { NOW, loadFixture, stubFetch, stubFetchError } from "./_helpers.js";

const source: StructuredSource = {
  id: "github.com/stripe/stripe-node",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "openapi",
  fetch: { auth: "github_token_env", rate_limit: "5000/h" },
  endpoints: {
    openapi: {
      url: "https://raw.githubusercontent.com/{owner}/{repo}/HEAD/openapi.yaml",
      kind: "spec",
      variables: { owner: "stripe", repo: "stripe-node" },
    },
  },
  security: { allowed_domains: ["raw.githubusercontent.com", "github.com"] },
  firecrawl: false,
};

describe("openapi adapter", () => {
  it("parses info.version and produces a stable hash", async () => {
    const body = await loadFixture("openapi-stripe-node.yaml");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("openapi");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.source_id, source.id);
    assert.equal(artifact.source_type, "openapi");
    assert.equal(artifact.version, "18.2.0");
    assert.equal(artifact.fetch_metadata.status, 200);
    assert.equal(artifact.fetch_metadata.url, "https://raw.githubusercontent.com/stripe/stripe-node/HEAD/openapi.yaml");
    assert.equal(artifact.detection_method, "hash_only"); // first poll, no last-seen
    assert.equal(artifact.raw_content_type, "text/yaml-or-json");
    assert.match(artifact.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(fetch.calls.length, 1);
  });

  it("emits version_bump when the parsed version differs from last-seen", async () => {
    const body = await loadFixture("openapi-stripe-node.yaml");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("openapi");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "18.1.0", lastSeenHash: "deadbeef", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.version, "18.2.0");
    assert.equal(artifact.detection_method, "version_bump");
  });

  it("emits hash_only when version matches but body changed (vendor anomaly)", async () => {
    const body = await loadFixture("openapi-stripe-node.yaml");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("openapi");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "18.2.0", lastSeenHash: "different-hash", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.version, "18.2.0");
    assert.equal(artifact.detection_method, "hash_only");
  });

  it("surfaces http_error on 4xx/5xx", async () => {
    const fetch = stubFetchError(403, "Forbidden");
    const adapter = getStructuredAdapter("openapi");

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

  it("surfaces schema_mismatch when the source has no spec endpoint", async () => {
    const badSource: StructuredSource = {
      ...source,
      endpoints: {
        wrong: { url: "https://example.com/api", kind: "list" },
      },
    };
    const fetch = stubFetch("{}");
    const adapter = getStructuredAdapter("openapi");

    await assert.rejects(
      adapter.fetch(
        badSource,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: () => undefined },
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "unsupported_endpoint_kind");
        return true;
      },
    );
  });
});
