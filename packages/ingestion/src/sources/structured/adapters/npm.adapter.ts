/**
 * npm registry adapter.
 *
 * Fetches the package metadata for the named package, extracts
 * `version` and `dist.tarball`/`dist.shasum`, and returns a
 * `NormalizedArtifact` with both signals (version + content_hash)
 * per ADR §5.
 *
 * Per ADR §7a, the right endpoint for incremental polling is
 * `https://registry.npmjs.org/{package}/latest` — a single version's
 * full manifest, not the full version list. The full version list
 * (`/{package}`) is needed only for backfill, which is a v1.1 add
 * (out of scope here). The npm example source in `sources/structured/npm.json`
 * declares the full-list endpoint as `kind: "object"`, so we use that
 * for the response and pull `dist-tags.latest` for the current version.
 *
 * v1 caveats:
 *
 *   - Only the metadata endpoint is fetched. The tarball itself
 *     (declared as `kind: "raw"` in the example) is *not* fetched
 *     here — that's a future "type-diff" feature for P2.2, gated
 *     behind a config flag (out of scope for Slice 2).
 *
 *   - Auth is rarely needed for the public registry, but `npm_token_env`
 *     is supported for private packages. The host loop injects the
 *     token via headers; this adapter doesn't read env vars.
 */

import type { Endpoint, StructuredSource } from "@outpost/shared";

import { AdapterError, type SourceAdapter } from "../types.js";
import { canonicalizeJson, sha256Hex } from "../canonical.js";
import { registerStructuredAdapter } from "../source-registry.js";

function pickPackageEndpoint(source: StructuredSource): Endpoint {
  // For npm, the package endpoint is the one whose URL matches
  // `registry.npmjs.org/{package}` (not the tarball one). Picking
  // by URL pattern keeps the adapter agnostic to endpoint names
  // like "package" vs "metadata".
  const packages = Object.values(source.endpoints).filter(
    (e) => e.kind === "object",
  );
  if (packages.length === 0) {
    throw new AdapterError(
      "unsupported_endpoint_kind",
      `npm source ${source.id} has no kind="object" endpoint; ` +
        `npm sources must declare a package-metadata endpoint`,
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

interface NpmPackageResponse {
  readonly "dist-tags"?: { readonly latest?: string };
  readonly versions?: Record<
    string,
    {
      readonly dist?: {
        readonly tarball?: string;
        readonly shasum?: string;
      };
    }
  >;
  readonly name?: string;
  readonly version?: string;
}

function parseNpmResponse(body: string): NpmPackageResponse {
  try {
    return JSON.parse(body) as NpmPackageResponse;
  } catch (cause) {
    throw new AdapterError(
      "parse_error",
      "npm registry response is not valid JSON",
      cause,
    );
  }
}

function resolveLatest(parsed: NpmPackageResponse): {
  version: string;
  tarball: string | null;
  shasum: string | null;
} {
  // Two acceptable shapes:
  //   1. Full package doc: { "dist-tags": { "latest": "x.y.z" }, "versions": { "x.y.z": {...} } }
  //   2. Abbreviated single-version: { "name": "x", "version": "x.y.z", "dist": {...} }
  // We try (1) first because that's what /{package} returns; if absent,
  // fall back to (2) for /{package}/latest compatibility (a v1.1 add).
  const tagLatest = parsed["dist-tags"]?.latest;
  if (tagLatest && parsed.versions?.[tagLatest]) {
    const v = parsed.versions[tagLatest];
    return {
      version: tagLatest,
      tarball: v.dist?.tarball ?? null,
      shasum: v.dist?.shasum ?? null,
    };
  }
  if (parsed.version) {
    return {
      version: parsed.version,
      tarball: parsed.versions?.[parsed.version]?.dist?.tarball ?? null,
      shasum: parsed.versions?.[parsed.version]?.dist?.shasum ?? null,
    };
  }
  throw new AdapterError(
    "schema_mismatch",
    "npm registry response has no dist-tags.latest and no top-level version",
  );
}

export const npmAdapter: SourceAdapter = {
  source_type: "npm",

  async fetch(source, ctx, deps) {
    const endpoint = pickPackageEndpoint(source);
    const url = renderUrl(endpoint);
    const res = await deps.fetch(url);
    const body = await res.text();
    if (!res.ok) {
      throw new AdapterError(
        "http_error",
        `npm fetch failed: ${res.status} for ${url}`,
      );
    }
    const parsed = parseNpmResponse(body);
    const { version } = resolveLatest(parsed);
    // Hash the canonicalized full response, not just the version field.
    // Two semantically-identical responses (different key order, etc.)
    // must produce the same hash; canonicalizeJson handles that.
    const contentHash = sha256Hex(JSON.stringify(canonicalizeJson(parsed)));
    return {
      source_id: source.id,
      source_type: "npm",
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

registerStructuredAdapter(npmAdapter);
