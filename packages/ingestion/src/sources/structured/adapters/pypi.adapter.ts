/**
 * PyPI JSON API adapter.
 *
 * Fetches the package metadata from `https://pypi.org/pypi/{package}/json`,
 * extracts `info.version` and the first `urls[].url` (wheel preferred),
 * and returns a `NormalizedArtifact` with both signals per ADR §5.
 *
 * v1 caveats:
 *
 *   - Like the npm adapter, we only fetch the metadata. The wheel
 *     itself isn't pulled — type/AST diff in P2.2 is a v1.1 add.
 *   - Auth via `pypi_token_env` is supported at the host loop level;
 *     the adapter doesn't read env vars directly.
 */

import type { Endpoint, StructuredSource } from "@outpost/shared";

import { AdapterError, type SourceAdapter } from "../types.js";
import { canonicalizeJson, sha256Hex } from "../canonical.js";
import { registerStructuredAdapter } from "../source-registry.js";

function pickPackageEndpoint(source: StructuredSource): Endpoint {
  const packages = Object.values(source.endpoints).filter(
    (e) => e.kind === "object",
  );
  if (packages.length === 0) {
    throw new AdapterError(
      "unsupported_endpoint_kind",
      `pypi source ${source.id} has no kind="object" endpoint; ` +
        `pypi sources must declare a package-metadata endpoint`,
    );
  }
  return packages[0]!;
}

function renderUrl(endpoint: Endpoint): string {
  if (!endpoint.variables) return endpoint.url;
  return endpoint.url.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = endpoint.variables![name];
    if (v === undefined) {
      throw new AdapterError(
        "schema_mismatch",
        `endpoint url ${endpoint.url} references {${name}} but no binding was declared`,
      );
    }
    return v;
  });
}

function detectionMethod(
  version: string | null,
  ctx: { lastSeenVersion: string | null; lastSeenHash: string | null },
): "version_bump" | "hash_only" {
  if (version !== null && ctx.lastSeenVersion !== null && version !== ctx.lastSeenVersion) {
    return "version_bump";
  }
  return "hash_only";
}

interface PypiUrl {
  readonly url?: string;
  readonly packagetype?: string;
}

interface PypiInfo {
  readonly name?: string;
  readonly version?: string;
}

interface PypiResponse {
  readonly info?: PypiInfo;
  readonly urls?: ReadonlyArray<PypiUrl>;
}

function parsePypiResponse(body: string): {
  parsed: PypiResponse;
  version: string;
  wheelUrl: string | null;
} {
  let parsed: PypiResponse;
  try {
    parsed = JSON.parse(body) as PypiResponse;
  } catch (cause) {
    throw new AdapterError(
      "parse_error",
      "pypi response is not valid JSON",
      cause,
    );
  }
  const version = parsed.info?.version;
  if (!version) {
    throw new AdapterError(
      "schema_mismatch",
      "pypi response has no info.version",
    );
  }
  // Prefer the wheel over the sdist — wheels are pre-built and smaller.
  const wheel = parsed.urls?.find((u) => u.packagetype === "bdist_wheel");
  const wheelUrl = wheel?.url ?? parsed.urls?.[0]?.url ?? null;
  return { parsed, version, wheelUrl };
}

export const pypiAdapter: SourceAdapter = {
  source_type: "pypi",

  async fetch(source, ctx, deps) {
    const endpoint = pickPackageEndpoint(source);
    const url = renderUrl(endpoint);
    const res = await deps.fetch(url);
    const body = await res.text();
    if (!res.ok) {
      throw new AdapterError(
        "http_error",
        `pypi fetch failed: ${res.status} for ${url}`,
      );
    }
    const { parsed, version } = parsePypiResponse(body);
    const contentHash = sha256Hex(JSON.stringify(canonicalizeJson(parsed)));
    return {
      source_id: source.id,
      source_type: "pypi",
      version,
      content_hash: contentHash,
      raw_bytes: body,
      raw_content_type: "application/json",
      detection_method: detectionMethod(version, ctx),
      detected_at: ctx.now,
      fetch_metadata: {
        url,
        status: res.status,
        auth: source.fetch.auth,
        contentType: "application/json",
      },
    };
  },
};

registerStructuredAdapter(pypiAdapter);
