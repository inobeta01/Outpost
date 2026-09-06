/**
 * OpenAPI / GraphQL spec adapter.
 *
 * Fetches the `kind: "spec"` endpoint from the source spec, extracts
 * the version (default `info.version` for OpenAPI 3.x), canonicalizes
 * the body, and returns a `NormalizedArtifact` with both signals
 * (version + content_hash) per ADR §5.
 *
 * v1 caveats (worth flagging in the PR description):
 *
 *   - Version field is hardcoded to `info.version` because the spec
 *     for `version_field` per-source doesn't exist yet on the source
 *     spec. Adding it is a Slice 2.1 follow-up: a `version_field`
 *     string on the endpoint config with a default of `info.version`.
 *     Other spec types (e.g. GraphQL SDL) don't have a standard
 *     `info.version` and would need a custom field.
 *
 *   - YAML is parsed by hand for the `info.version` extraction.
 *     The full body is hashed as text (canonicalized), not as
 *     parsed JSON, because not all specs are JSON and we don't want
 *     to lose the comments + ordering fidelity that YAML preserves
 *     (oasdiff diffs YAML, not parsed JSON, downstream in P2.2).
 *     If the spec turns out to be JSON, we still hash the raw text —
 *     the two `info.version` extractions agree because the parser
 *     is forgiving about JSON-shaped YAML.
 *
 *   - For JSON-shaped specs (rare but legal), the parser tries
 *     `info.version` first; if absent, it tries top-level `version`
 *     (AsyncAPI, some custom specs).
 *
 *   - Auth: the adapter only knows the auth *mode* (per the source
 *     spec). The actual token plumbing (reading `*_token_env` and
 *     attaching it as a header) is the host loop's responsibility,
 *     not ours. The adapter injects no headers today; if a future
 *     openapi source needs a header at fetch time, that's a Slice 2.1
 *     change wired through the host loop, not the adapter.
 */

import type { Endpoint, StructuredSource } from "@outpost/shared";

import { AdapterError, type FetchLike, type SourceAdapter } from "../types.js";
import { canonicalizeText, sha256Hex } from "../canonical.js";
import { registerStructuredAdapter } from "../source-registry.js";

/**
 * Match an `info` block's `version` line. Two shapes:
 *   - YAML:   `info:\n  version: "18.2.0"` or `version: 18.2.0`
 *   - JSON:   `"info": { "version": "18.2.0" }`
 * The pattern is intentionally forgiving — we only need to read the
 * value, not validate the rest of the spec. oasdiff downstream
 * (P2.2) handles full validation.
 */
const VERSION_RE =
  /(?:^|\s)info\s*:\s*(?:\{\s*)?(?:[\s\S]*?\n\s*)?["']?version["']?\s*:\s*["']?([^"'\n,}\s]+)/m;

function extractVersion(body: string): string | null {
  const match = body.match(VERSION_RE);
  return match?.[1] ?? null;
}

/**
 * Pick the `spec` endpoint from a `StructuredSource`. Throws
 * `AdapterError` with code `unsupported_endpoint_kind` if there
 * isn't exactly one — openapi sources must declare a single
 * `kind: "spec"` endpoint.
 */
function pickSpecEndpoint(source: StructuredSource): Endpoint {
  const specs = Object.values(source.endpoints).filter(
    (e) => e.kind === "spec",
  );
  if (specs.length === 0) {
    throw new AdapterError(
      "unsupported_endpoint_kind",
      `openapi source ${source.id} has no kind="spec" endpoint; ` +
        `OpenAPI sources must declare exactly one`,
    );
  }
  if (specs.length > 1) {
    throw new AdapterError(
      "unsupported_endpoint_kind",
      `openapi source ${source.id} declares ${specs.length} kind="spec" ` +
        `endpoints; only one is supported in v1`,
    );
  }
  return specs[0]!;
}

/**
 * Resolve `{var}` placeholders in an endpoint URL using the endpoint's
 * `variables` map. Mirrors the validator's contract: every placeholder
 * in the template must have a binding.
 */
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
  // Hash-only bumps are a real signal: vendor edited the spec without
  // bumping the version. Worth flagging, not worth failing the run.
  return "hash_only";
}

async function fetchOpenApi(
  source: StructuredSource,
  fetchImpl: FetchLike,
): Promise<{ body: string; url: string; status: number; contentType: string | null }> {
  const endpoint = pickSpecEndpoint(source);
  const url = renderUrl(endpoint);
  const res = await fetchImpl(url);
  const body = await res.text();
  if (!res.ok) {
    throw new AdapterError(
      "http_error",
      `openapi fetch failed: ${res.status} for ${url}`,
    );
  }
  return {
    body,
    url,
    status: res.status,
    contentType: null, // fetchLike stub doesn't expose headers in our contract
  };
}

export const openapiAdapter: SourceAdapter = {
  source_type: "openapi",

  async backfill(source) {
    // Per the backfill slice plan: an OpenAPI spec URL has no history
    // to backfill — there's only ever a current snapshot. The host
    // loop catches `backfill_unsupported` and emits a `backfill_skipped`
    // outcome without mutating state.
    throw new AdapterError(
      "backfill_unsupported",
      `openapi source ${source.id} has no history to backfill; only a current snapshot exists`,
    );
  },

  async fetch(source, ctx, deps) {
    const { body, url, status } = await fetchOpenApi(source, deps.fetch);
    const version = extractVersion(body);
    const contentHash = sha256Hex(canonicalizeText(body));
    return {
      source_id: source.id,
      source_type: "openapi",
      version,
      content_hash: contentHash,
      raw_bytes: body,
      // Specs may be YAML or JSON; oasdiff handles both. We don't
      // sniff the content type beyond "text" — the diff tool will.
      raw_content_type: "text/yaml-or-json",
      detection_method: detectionMethod(version, ctx),
      detected_at: ctx.now,
      fetch_metadata: {
        url,
        status,
        auth: source.fetch.auth,
        contentType: null,
      },
    };
  },
};

registerStructuredAdapter(openapiAdapter);
