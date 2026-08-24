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
