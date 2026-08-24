/**
 * Tests for the npm registry adapter.
 *
 * Covers:
 *   - Happy path: parses dist-tags.latest, hashes canonicalized body
 *   - Abbreviated single-version response (/{package}/latest shape)
 *   - Version bump vs hash-only detection
 *   - http_error, parse_error, schema_mismatch paths
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import { AdapterError, getStructuredAdapter } from "../../sources/structured/index.js";

import { NOW, loadFixture, stubFetch, stubFetchError } from "./_helpers.js";

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
    tarball: {
      url: "https://registry.npmjs.org/{package}/-/{tarball}",
      kind: "raw",
      variables: { package: "openai", tarball: "openai-4.0.0.tgz" },
    },
  },
  security: { allowed_domains: ["registry.npmjs.org"] },
  firecrawl: false,
};

describe("npm adapter", () => {
  it("parses dist-tags.latest from the full package doc", async () => {
    const body = await loadFixture("npm-openai-package.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.source_type, "npm");
    assert.equal(artifact.version, "4.56.0");
    assert.equal(artifact.fetch_metadata.url, "https://registry.npmjs.org/openai");
    assert.equal(artifact.raw_content_type, "application/json");
    assert.match(artifact.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(fetch.calls.length, 1);
  });

  it("falls back to top-level version for abbreviated responses", async () => {
    const body = await loadFixture("npm-openai-abbreviated.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: null, lastSeenHash: null, now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.version, "4.56.0");
  });

  it("emits version_bump when the latest version differs from last-seen", async () => {
    const body = await loadFixture("npm-openai-package.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "4.55.0", lastSeenHash: "x", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.detection_method, "version_bump");
  });

  it("emits hash_only when version matches but content_hash differs", async () => {
    const body = await loadFixture("npm-openai-package.json");
    const fetch = stubFetch(body);
    const adapter = getStructuredAdapter("npm");

    const artifact = await adapter.fetch(
      source,
      { lastSeenVersion: "4.56.0", lastSeenHash: "different", now: NOW },
      { fetch, readEnv: () => undefined },
    );

    assert.equal(artifact.detection_method, "hash_only");
  });

  it("surfaces http_error on 404", async () => {
    const fetch = stubFetchError(404, "Not found");
    const adapter = getStructuredAdapter("npm");

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

  it("surfaces parse_error on malformed JSON", async () => {
    const fetch = stubFetch("not json {", 200);
    const adapter = getStructuredAdapter("npm");

    await assert.rejects(
      adapter.fetch(
        source,
        { lastSeenVersion: null, lastSeenHash: null, now: NOW },
        { fetch, readEnv: () => undefined },
      ),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal((err as AdapterError).code, "parse_error");
        return true;
      },
    );
  });

  it("surfaces schema_mismatch when response has no version", async () => {
    const fetch = stubFetch(JSON.stringify({ name: "openai" }));
    const adapter = getStructuredAdapter("npm");

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
