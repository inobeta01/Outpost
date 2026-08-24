/**
 * Structured-source adapter contract.
 *
 * Every structured source (OpenAPI, npm, PyPI, GitHub releases, …) is
 * fetched and normalized by an adapter that conforms to this interface.
 * The dispatch in `source-registry.ts` keys off `source_type` from the
 * source spec, so adding a new structured source type is a two-step
 * change: extend the closed enum in `@outpost/shared` (schema + types),
 * then add a new adapter file that implements this interface and
 * `registerStructuredAdapter` it.
 *
 * Why this shape:
 *
 *   - `fetch` and `readEnv` are injected, not ambient. Tests stub them;
 *     the sandbox will wire them to its network policy and env-var
 *     allowlist. The adapter never touches `globalThis.fetch` or
 *     `process.env` directly — that would defeat the test harness
 *     and tie the adapter to a specific runtime.
 *
 *   - `lastSeenVersion` / `lastSeenHash` are passed in by P1.1 (the
 *     eventual host loop), not read from a DB by the adapter. This
 *     keeps the adapter stateless — a property the ADR §3 trust-boundary
 *     decision requires of every component inside the sandbox.
 *
 *   - Output is `NormalizedArtifact` — the shape that the host loop
 *     hands to P2. The `detection_method` field is the structured-lane
 *     answer to "is this a real change or a hash-only anomaly?" (ADR §5).
 *     The LLM never sees this; symbolic diff in P2.2 does.
 */

import type { StructuredSource, StructuredSourceType } from "@outpost/shared";

/**
 * Minimal `fetch`-compatible signature. The real `fetch` returns
 * `Response`; the adapter only needs `ok` + `status` + `text()`. We
 * type it this way so tests can pass a `Promise<{ok,status,text}>` stub
 * without faking a real `Response`.
 */
export interface FetchLike {
  (
    url: string,
    init?: { headers?: Readonly<Record<string, string>> },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    text(): Promise<string>;
  }>;
}

/**
 * Reads a single environment variable. The sandbox will resolve
 * `*_token_env` auth values via this — never `process.env` directly.
 * Throws if the variable is unset and `auth` requires it; the adapter
 * surfaces that as an `AdapterError` with code `"missing_auth"`.
 */
export type ReadEnvLike = (name: string) => string | undefined;

/**
 * Per-call context passed to every adapter invocation. Carries the
 * last-seen signals so the adapter can emit the right `detection_method`
 * without doing DB work itself.
 */
export interface AdapterContext {
  /**
   * The vendor-asserted version (or tag, or release id) the registry
   * saw on the previous successful poll, or `null` if this is the
   * first poll. The adapter uses this to decide between
   * `version_bump` and `hash_only` (ADR §5).
   */
  readonly lastSeenVersion: string | null;
  /**
   * SHA-256 of the canonicalized body from the previous successful
   * poll, or `null` if this is the first poll.
   */
  readonly lastSeenHash: string | null;
  /** ISO-8601 timestamp the host loop started this poll. */
  readonly now: string;
}

/**
 * The two detection methods a structured adapter can emit. Per ADR §5:
 * a version-bump means the vendor explicitly signaled change (Tier 1
 * trust); a hash-only bump means the content changed but the vendor's
 * version field didn't, which is itself an anomaly worth flagging.
 */
export type DetectionMethod = "version_bump" | "hash_only";

/**
 * Metadata about the fetch that produced this artifact. Carried in
 * the artifact envelope so P2 can do provenance replay.
 */
export interface FetchMetadata {
  /** The actual URL fetched, after template variable substitution. */
  readonly url: string;
  /** HTTP status code from the upstream. */
  readonly status: number;
  /** The auth mode used (mirrors `fetch.auth` on the source spec). */
  readonly auth: StructuredSource["fetch"]["auth"];
  /** Content-Type header from the response, if present. */
  readonly contentType: string | null;
}

/**
 * The output of a successful adapter invocation. This is the shape
 * the host loop hands to P2. P2.1 (content hash filter) compares
 * `version` + `content_hash` against its own state — the adapter's
 * own comparison (`lastSeenVersion` / `lastSeenHash`) is just for
 * setting `detection_method`.
 */
export interface NormalizedArtifact {
  /** Mirrors the source spec's `id`. */
  readonly source_id: string;
  /** Mirrors the source spec's `source_type`. */
  readonly source_type: StructuredSourceType;
  /**
   * Vendor-asserted version, or `null` if the source has no version
   * field (e.g. a raw `CHANGES.md` file with no header). For
   * structured sources in v1, this is always present.
   */
  readonly version: string | null;
  /**
   * SHA-256 of the canonicalized body. Canonicalization rules depend
   * on `source_type` (sorted-key JSON, normalized-whitespace YAML, etc.)
   * and are the adapter's responsibility.
   */
  readonly content_hash: string;
  /** The raw bytes, UTF-8 decoded. P2.2 may re-hash; this is the source of truth. */
  readonly raw_bytes: string;
  /** MIME-ish hint, e.g. "application/json", "text/yaml", "application/x-gzip". */
  readonly raw_content_type: string;
  /** Per ADR §5. */
  readonly detection_method: DetectionMethod;
  /** ISO-8601. */
  readonly detected_at: string;
  /** Per-fetch provenance. */
  readonly fetch_metadata: FetchMetadata;
}

/**
 * The adapter contract. One implementation per `StructuredSourceType`.
 */
export interface SourceAdapter {
  /** The source type this adapter handles. Used by the registry. */
  readonly source_type: StructuredSourceType;

  /**
   * Fetch the source once, normalize the response, and return the
   * `NormalizedArtifact` shape. Throws `AdapterError` on any failure
   * (network, auth, parse, schema mismatch); the host loop is the
   * only place that decides whether to retry, skip, or fail the run.
   */
  fetch(
    source: StructuredSource,
    ctx: AdapterContext,
    deps: { fetch: FetchLike; readEnv: ReadEnvLike },
  ): Promise<NormalizedArtifact>;
}

/** Stable error codes the host loop can branch on. */
export type AdapterErrorCode =
  | "missing_auth"
  | "http_error"
  | "parse_error"
  | "schema_mismatch"
  | "unsupported_endpoint_kind"
  | "security_violation";

/**
 * Typed error thrown by adapters. Carries a code, a human-readable
 * message, and optional cause for diagnostic chains.
 */
export class AdapterError extends Error {
  public readonly code: AdapterErrorCode;
  public override readonly cause?: unknown;
  constructor(code: AdapterErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.cause = cause;
  }
}
