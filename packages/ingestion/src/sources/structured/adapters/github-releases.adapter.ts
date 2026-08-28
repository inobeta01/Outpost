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

import {
  AdapterError,
  type BackfillOptions,
  type BackfillResult,
  type SourceAdapter,
  type VersionObservation,
} from "../types.js";
import { computeBackfillPlan, DEFAULT_MAX_ARTIFACTS } from "../backfill-plan.js";
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
  readonly html_url?: string;
}

/** Per-page size. GitHub caps at 100 — the max, to minimize requests. */
const PER_PAGE = 100;
/** Polite pacing between paginated requests (ADR §2.6). */
const PAGE_DELAY_MS = 100;

function isPublished(r: GithubRelease): boolean {
  return r.draft !== true && r.prerelease !== true;
}

/**
 * Parse one page of the releases list. Unlike `parseReleasesResponse`
 * this does not require a "latest" to exist — mid-pagination pages
 * may legitimately contain zero published releases.
 */
function parseReleasesPage(body: string): GithubRelease[] {
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
  return (parsed as GithubRelease[]).filter(isPublished);
}

/**
 * Turn a published release record into a `VersionObservation`. The
 * version signal is `String(id)` — the same monotonic, tag-reuse-safe
 * signal the incremental poll uses. Ordering uses `published_at`.
 */
function releaseObservation(r: GithubRelease): VersionObservation {
  return {
    version: String(r.id),
    publishedAt: r.published_at ?? null,
    tarballUrl: r.html_url ?? null,
    shasum: null,
    deprecated: false,
    typesPath: null,
  };
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

  async backfill(source, ctx, deps, opts) {
    const endpoint = pickReleasesEndpoint(source);
    const baseUrl = renderUrl(endpoint);

    // Auth. `github_token_env` is the only mode that scales past the
    // 60/h unauthenticated limit, which a full-history walk blows
    // through immediately. The host loop owns the secret via readEnv.
    const headers: Record<string, string> = {};
    if (source.fetch.auth === "github_token_env") {
      const token = deps.readEnv("GITHUB_TOKEN");
      if (token === undefined || token === "") {
        throw new AdapterError(
          "missing_auth",
          `github_releases backfill for ${source.id} requires a token: set GITHUB_TOKEN (auth mode ${source.fetch.auth})`,
        );
      }
      headers["Authorization"] = `Bearer ${token}`;
    }

    // Resume from a persisted checkpoint (a previous run that failed
    // mid-pagination or stopped on the artifact budget).
    let startPage = 1;
    if (opts.checkpoint) {
      try {
        const cp = JSON.parse(opts.checkpoint) as { nextPage?: unknown };
        if (typeof cp.nextPage === "number" && Number.isInteger(cp.nextPage) && cp.nextPage >= 1) {
          startPage = cp.nextPage;
        }
      } catch {
        startPage = 1;
      }
    }

    const maxArtifacts = opts.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const fetchPage = async (page: number): Promise<string> => {
      const sep = baseUrl.includes("?") ? "&" : "?";
      const url = `${baseUrl}${sep}per_page=${PER_PAGE}&page=${page}`;
      const res = await deps.fetch(url, { headers });
      const body = await res.text();
      if (!res.ok) {
        // Checkpoint at this page so a re-run resumes here instead
        // of walking the whole history again.
        throw new AdapterError(
          "http_error",
          `github releases backfill page fetch failed: ${res.status} for ${url}`,
          undefined,
          JSON.stringify({ nextPage: page }),
        );
      }
      return body;
    };

    // Paginate. GitHub returns releases newest-first; termination is
    // a short page (< PER_PAGE raw items) or the artifact budget
    // (which needs maxArtifacts + 1 versions to emit maxArtifacts
    // consecutive events). The FetchLike contract exposes no response
    // headers, so Link-header walking isn't possible — short-page
    // detection covers the same guarantee.
    const collected: GithubRelease[] = [];
    let checkpoint: string | null = null;
    let page = startPage;
    for (;;) {
      if (page !== startPage) await sleep(PAGE_DELAY_MS);
      const body = await fetchPage(page);
      const published = parseReleasesPage(body);
      collected.push(...published);
      // Raw page length (pre-filter) decides pagination — a page of
      // 100 drafts is still a full page.
      let rawLength = published.length;
      try {
        rawLength = (JSON.parse(body) as unknown[]).length;
      } catch {
        // parseReleasesPage already threw for invalid JSON.
      }
      if (rawLength < PER_PAGE) break;
      if (collected.length > maxArtifacts) {
        checkpoint = JSON.stringify({ nextPage: page + 1 });
        break;
      }
      page++;
    }

    if (collected.length === 0) {
      throw new AdapterError(
        "schema_mismatch",
        `github releases backfill for ${source.id} found no published (non-draft, non-prerelease) releases`,
      );
    }

    // Sort ascending by published_at (id as the tiebreak/fallback) —
    // the order computeBackfillPlan expects. Version signal stays
    // String(id) per the incremental convention.
    const ascending = [...collected].sort((a, b) => {
      if (a.published_at && b.published_at) {
        const d = Date.parse(a.published_at) - Date.parse(b.published_at);
        if (d !== 0) return d;
      } else if (a.published_at) return 1;
      else if (b.published_at) return -1;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    const observations = ascending.map(releaseObservation);

    const planResult = computeBackfillPlan(observations, {
      now: new Date(opts.now),
      ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(opts.recentWindowMs !== undefined
        ? { recentWindowMs: opts.recentWindowMs }
        : {}),
      ...(opts.maxArtifacts !== undefined
        ? { maxArtifacts: opts.maxArtifacts }
        : {}),
    });

    // Release records by version id, plus their position in the
    // ascending chain so hop ranges can be sliced out.
    const byVersion = new Map<string, GithubRelease>();
    const indexOf = new Map<string, number>();
    ascending.forEach((r, i) => {
      byVersion.set(String(r.id), r);
      indexOf.set(String(r.id), i);
    });

    const artifacts = planResult.events.map((ev) => {
      const fromIdx = indexOf.get(ev.fromVersion);
      const toIdx = indexOf.get(ev.toVersion);
      if (fromIdx === undefined || toIdx === undefined) {
        throw new AdapterError(
          "schema_mismatch",
          `backfill plan references unknown release id for ${source.id}: ${ev.fromVersion}→${ev.toVersion}`,
        );
      }
      // Pair: the two endpoint records. Hop: every release in the
      // collapsed range, ascending.
      const relevant = ascending.slice(fromIdx, toIdx + 1);
      const body = JSON.stringify(relevant);
      return {
        source_id: source.id,
        source_type: "github_releases" as const,
        version: ev.toVersion,
        content_hash: sha256Hex(JSON.stringify(canonicalizeJson(relevant))),
        raw_bytes: body,
        raw_content_type: "application/json",
        detection_method: "version_bump" as const,
        detected_at: ctx.now,
        fetch_metadata: {
          url: baseUrl,
          status: 200,
          auth: source.fetch.auth,
          contentType: "application/json",
        },
      };
    });

    // State seam: hash the canonicalized latest (highest-id) release
    // record — the per-release manifest — the same granularity the
    // npm adapter's backfill uses for its finalState hash.
    const latest = ascending.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b));
    const finalStateHash = sha256Hex(JSON.stringify(canonicalizeJson(latest)));

    return {
      artifacts,
      plan: {
        events: planResult.events,
        finalState: {
          lastSeenVersion: String(latest.id),
          lastSeenHash: finalStateHash,
        },
        droppedObservations: planResult.droppedObservations,
      },
      observations,
      checkpoint,
    };
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
