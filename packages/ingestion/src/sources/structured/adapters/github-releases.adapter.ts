/**
 * GitHub Releases adapter.
 *
 * Fetches `https://api.github.com/repos/{owner}/{repo}/releases`,
 * takes the first release's `tag_name` (and `id` as a secondary
 * signal), and returns a `NormalizedArtifact` per ADR §5.
 *
 * v1 caveats:
 *
 *   - Auth via `github_token_env` is the only mode that works for
 *     unauthenticated requests at scale. Unauthenticated requests
 *     cap at 60/h; the host loop's `readEnv` injects the token as
 *     an `Authorization: Bearer` header. This adapter doesn't read
 *     env vars; the host loop owns the secret.
 *
 *   - We take the first array element as "latest". GitHub returns
 *     releases sorted by creation date descending, so [0] is
 *     always the most recent. If the upstream changes that ordering,
 *     this breaks — note in PR review.
 *
 *   - The detection_method logic uses the release `id` (a monotonic
 *     integer GitHub assigns at creation) as the version signal,
 *     not `tag_name`, because vendors sometimes reuse tag names
 *     across releases (rare but real — ADR §5 row 3: "Commit SHA if
 *     tag reused"). The `tag_name` is still surfaced via
 *     `raw_bytes` for human-readable audit.
 */

import type { Endpoint, StructuredSource } from "@outpost/shared";

import { AdapterError, type SourceAdapter } from "../types.js";
import { canonicalizeJson, sha256Hex } from "../canonical.js";
import { registerStructuredAdapter } from "../source-registry.js";

function pickReleasesEndpoint(source: StructuredSource): Endpoint {
  // For GitHub Releases, the endpoint is the one whose URL matches
  // api.github.com/repos/.../releases (kind: "list").
  const lists = Object.values(source.endpoints).filter(
    (e) => e.kind === "list",
  );
  if (lists.length === 0) {
    throw new AdapterError(
      "unsupported_endpoint_kind",
      `github_releases source ${source.id} has no kind="list" endpoint; ` +
        `github_releases sources must declare a releases-list endpoint`,
    );
  }
  return lists[0]!;
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

interface GithubRelease {
  readonly id?: number;
  readonly tag_name?: string;
  readonly name?: string | null;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly published_at?: string;
}

function parseReleasesResponse(body: string): {
  parsed: GithubRelease[];
  version: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new AdapterError(
      "parse_error",
      "github releases response is not valid JSON",
      cause,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new AdapterError(
      "schema_mismatch",
      "github releases response is not an array",
    );
  }
  const releases = parsed as GithubRelease[];
  // Filter out drafts and prereleases — they're not "real" releases
  // for registry purposes. A future Slice 2.1 might surface them
  // behind a config flag.
  const published = releases.filter(
    (r) => r.draft !== true && r.prerelease !== true,
  );
  const latest = published[0];
  if (!latest) {
    throw new AdapterError(
      "schema_mismatch",
      "github releases response has no published (non-draft, non-prerelease) releases",
    );
  }
  // Use the numeric `id` as the version signal because it's monotonic
  // and tag-reuse-safe. The `tag_name` is human-readable and goes
  // into raw_bytes for audit.
  const id = latest.id;
  if (typeof id !== "number") {
    throw new AdapterError(
      "schema_mismatch",
      "github release has no numeric id",
    );
  }
  return { parsed: published, version: String(id) };
}

export const githubReleasesAdapter: SourceAdapter = {
  source_type: "github_releases",

  async backfill(source) {
    // Step 5 of the backfill slice plan lands the full paginated,
    // token-aware implementation. For now this signals to the host
    // that the adapter is registered for backfill but not yet
    // implemented — we throw the same `backfill_unsupported` code
    // as `openapi` so the host treats it as a skip, not a failure.
    throw new AdapterError(
      "backfill_unsupported",
      `github_releases backfill for ${source.id} lands in step 5 of the backfill slice plan`,
    );
  },

  async fetch(source, ctx, deps) {
    const endpoint = pickReleasesEndpoint(source);
    const url = renderUrl(endpoint);
    const res = await deps.fetch(url);
    const body = await res.text();
    if (!res.ok) {
      // 403 with rate-limit hint is a common GitHub response — surface
      // it as http_error with the body so the host loop can decide
      // whether to back off.
      throw new AdapterError(
        "http_error",
        `github releases fetch failed: ${res.status} for ${url}`,
      );
    }
    const { parsed, version } = parseReleasesResponse(body);
    const contentHash = sha256Hex(JSON.stringify(canonicalizeJson(parsed)));
    return {
      source_id: source.id,
      source_type: "github_releases",
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

registerStructuredAdapter(githubReleasesAdapter);
