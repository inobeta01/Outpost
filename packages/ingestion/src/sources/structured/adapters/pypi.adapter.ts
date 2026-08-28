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

import {
  AdapterError,
  type BackfillOptions,
  type BackfillResult,
  type SourceAdapter,
  type VersionObservation,
} from "../types.js";
import { computeBackfillPlan } from "../backfill-plan.js";
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

/** One file record inside a `releases[version]` array. */
interface PypiFile {
  readonly url?: string;
  readonly packagetype?: string;
  readonly upload_time?: string;
  readonly upload_time_iso_8601?: string;
  readonly yanked?: boolean;
}

/** The `/pypi/{package}/json` index body: every release + the latest. */
interface PypiIndexResponse {
  readonly info?: PypiInfo;
  readonly releases?: Readonly<Record<string, ReadonlyArray<PypiFile>>>;
}

/**
 * Detail-call cap. One `/pypi/{pkg}/{version}/json` request per
 * in-window version, bounded here — above it, remaining versions
 * fall back to index-only summaries and a
 * `pypi_detail_budget_exceeded` warning surfaces in the run report.
 * The cap is a safety net, not a normal path: the default
 * `max_artifacts` of 35 needs at most 36 detail calls.
 */
const DETAIL_CALL_CAP = 200;

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

  async backfill(source, ctx, deps, opts) {
    // 1. Index call — the full `releases` map in one request.
    const endpoint = pickPackageEndpoint(source);
    const indexUrl = renderUrl(endpoint);
    const indexRes = await deps.fetch(indexUrl);
    const indexBody = await indexRes.text();
    if (!indexRes.ok) {
      throw new AdapterError(
        "http_error",
        `pypi backfill index fetch failed: ${indexRes.status} for ${indexUrl}`,
      );
    }
    let indexParsed: PypiIndexResponse;
    try {
      indexParsed = JSON.parse(indexBody) as PypiIndexResponse;
    } catch (cause) {
      throw new AdapterError(
        "parse_error",
        "pypi index response is not valid JSON",
        cause,
      );
    }
    const latestVersion = indexParsed.info?.version;
    if (!latestVersion) {
      throw new AdapterError(
        "schema_mismatch",
        "pypi index response has no info.version",
      );
    }

    // 2. Build VersionObservation[] from the releases map, sorted
    // ascending by upload time (first file's upload_time per version
    // is canonical). Empty releases (older packages) → no events.
    const releases = indexParsed.releases ?? {};
    const versionKeys = Object.keys(releases);
    const observations: VersionObservation[] = versionKeys.map((v) => {
      const files = releases[v] ?? [];
      const first = files[0];
      return {
        version: v,
        publishedAt:
          first?.upload_time_iso_8601 ?? first?.upload_time ?? null,
        tarballUrl: first?.url ?? null,
        shasum: null,
        deprecated: false,
        typesPath: null,
      };
    });
    observations.sort((a, b) => {
      if (a.publishedAt === null && b.publishedAt === null) return 0;
      if (a.publishedAt === null) return 1;
      if (b.publishedAt === null) return -1;
      return Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
    });

    // 3. Three-rule plan.
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

    // 4. Detail fetches for the versions the plan events reference.
    // Per-version metadata lives at `/pypi/{pkg}/{version}/json`. The
    // index IS what the incremental poll fetches, so the latest
    // version's detail is fetched first — but the state-seam hash
    // comes from the index body itself (see below). Detail calls are
    // capped; versions beyond the cap use index-only summaries.
    const detailBase = indexUrl.replace(/\/json$/, "");
    const neededVersions: string[] = [latestVersion];
    for (const ev of planResult.events) {
      for (const v of [ev.fromVersion, ev.toVersion]) {
        if (!neededVersions.includes(v)) neededVersions.push(v);
      }
    }
    // Resume: a previous run that died mid-detail-fetch persisted
    // `{ nextVersion }` — skip versions strictly before it (their
    // artifacts will use index-only summaries; the re-run's new
    // artifacts supersede the old ones and P2 dedupes).
    let resumeVersion: string | null = null;
    if (opts.checkpoint) {
      try {
        const cp = JSON.parse(opts.checkpoint) as { nextVersion?: unknown };
        if (typeof cp.nextVersion === "string") resumeVersion = cp.nextVersion;
      } catch {
        resumeVersion = null;
      }
    }
    const details = new Map<string, unknown>();
    for (const v of neededVersions) {
      if (resumeVersion !== null && v !== resumeVersion) continue;
      resumeVersion = null;
      if (details.size >= DETAIL_CALL_CAP) break;
      const detailUrl = `${detailBase}/${v}/json`;
      const res = await deps.fetch(detailUrl);
      const body = await res.text();
      if (!res.ok) {
        throw new AdapterError(
          "http_error",
          `pypi backfill detail fetch failed: ${res.status} for ${detailUrl}`,
          undefined,
          // Checkpoint at the version we died on: a re-run that
          // passes the resume marker skips already-fetched details.
          JSON.stringify({ nextVersion: v }),
        );
      }
      try {
        details.set(v, JSON.parse(body) as unknown);
      } catch (cause) {
        throw new AdapterError(
          "parse_error",
          `pypi detail response for ${v} is not valid JSON`,
          cause,
        );
      }
    }
    const warnings: string[] = [];
    if (details.size < neededVersions.length) {
      warnings.push(
        `pypi_detail_budget_exceeded: ${neededVersions.length - details.size} of ` +
          `${neededVersions.length} in-window versions fall back to index-only ` +
          `summaries (${DETAIL_CALL_CAP}-call cap). Re-run with a narrower window ` +
          `if per-version diffs are required.`,
      );
    }

    // Index-only summary for versions without a detail manifest.
    const indexSummary = (v: string): unknown => ({
      version: v,
      detail_source: "index_summary",
      files: releases[v] ?? [],
    });
    const versionData = (v: string): unknown =>
      details.get(v) ?? indexSummary(v);

    // 5. One NormalizedArtifact per plan event. Pair: both endpoint
    // version records. Hop: every version in the collapsed range.
    // Yanked versions are surfaced in the records, not filtered —
    // the operator wants to know about them (slice-plan decision).
    const indexOf = new Map<string, number>();
    observations.forEach((o, i) => indexOf.set(o.version, i));
    const artifacts = planResult.events.map((ev) => {
      const fromIdx = indexOf.get(ev.fromVersion);
      const toIdx = indexOf.get(ev.toVersion);
      if (fromIdx === undefined || toIdx === undefined) {
        throw new AdapterError(
          "schema_mismatch",
          `backfill plan references unknown version for ${source.id}: ${ev.fromVersion}→${ev.toVersion}`,
        );
      }
      const rangeVersions = observations
        .slice(fromIdx, toIdx + 1)
        .map((o) => o.version);
      const dataArr = rangeVersions.map(versionData);
      return {
        source_id: source.id,
        source_type: "pypi" as const,
        version: ev.toVersion,
        content_hash: sha256Hex(JSON.stringify(canonicalizeJson(dataArr))),
        raw_bytes: JSON.stringify({ event: ev, versions: dataArr }),
        raw_content_type: "application/json",
        detection_method: "version_bump" as const,
        detected_at: ctx.now,
        fetch_metadata: {
          url: indexUrl,
          status: indexRes.status,
          auth: source.fetch.auth,
          contentType: "application/json",
        },
      };
    });

    // 6. State seam: hash the index body exactly the way an
    // incremental poll of `/pypi/{pkg}/json` does — same endpoint,
    // same parse, same canonicalization. (The slice plan sketched
    // hashing the latest version's *detail* manifest, but the
    // incremental path polls the index; hashing the index is the
    // only hash that actually round-trips.)
    const finalStateHash = sha256Hex(
      JSON.stringify(canonicalizeJson(indexParsed)),
    );

    return {
      artifacts,
      plan: {
        events: planResult.events,
        finalState: {
          lastSeenVersion: latestVersion,
          lastSeenHash: finalStateHash,
        },
        droppedObservations: planResult.droppedObservations,
      },
      observations,
      checkpoint: null,
      warnings,
    };
  },

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
