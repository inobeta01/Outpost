/**
 * @outpost/source-spec — Artifact envelope types
 *
 * The unified shape of what P1 (the ingestion layer, less-trusted)
 * hands to P2 (the processing/registry core, trusted). Lives in
 * `@outpost/shared` so P2 can import it without crossing INTO
 * `@outpost/ingestion` — that direction is the trust violation
 * (P2 must remain the source of truth, not depend on P1).
 *
 * Per ADR §3 ("P1 is stateless, never decides what stays"): the
 * envelope carries OBSERVATIONS, not DECISIONS. P2.1 (content hash
 * filter) is the only thing that decides "is this actually new".
 *
 * Per ADR §5 ("vendor-asserted version + content_hash"): both
 * signals are required. `version` may be null when the vendor has
 * no version field (e.g. a raw CHANGES.md blob); `content_hash` is
 * always present because it's over the canonicalized body that the
 * adapter/strategy produced.
 *
 * Per ADR §5 ("detection_method"): structured adapters emit
 * `version_bump` vs `hash_only` based on whether `version`
 * actually changed; unstructured strategies emit `new_entry` per
 * ResolvedItem, with hash + anchor for downstream P2.3.
 *
 * The envelope is deliberately NOT a wrapper over
 * `NormalizedArtifact`. P1 emits it directly so P2 doesn't have to
 * import from `@outpost/ingestion`.
 */

import type {
  ExtractionStrategy,
  FetchAuth,
  StructuredSourceType,
} from "./schema.js";

/**
 * Why this artifact surfaced. Per ADR §5:
 *
 *   - `version_bump`     — vendor-asserted version changed
 *   - `hash_only`        — content hash changed but vendor version didn't (anomaly)
 *   - `new_entry`        — unstructured lane: a fresh entry's first poll
 *   - `entry_update`     — unstructured lane: an entry's content hash changed
 *   - `first_poll`       — first successful poll for this source ever
 *
 * Structured-lane strategies emit one of `version_bump`, `hash_only`,
 * `first_poll`. Unstructured-lane strategies emit one of `new_entry`,
 * `entry_update`, `first_poll`.
 */
export type DetectionMethod =
  | "version_bump"
  | "hash_only"
  | "new_entry"
  | "entry_update"
  | "first_poll";

/**
 * How the artifact was gathered. Per ADR §3.2: distinct from
 * `detection_method` because it describes *how the data was fetched*,
 * not *what kind of change this represents*. Both fields are needed
 * downstream — a `first_poll` artifact can be a backfill event,
 * a `version_bump` artifact can be incremental.
 *
 *   - `incremental` — the normal polling path (latest-only endpoint,
 *     one artifact per poll).
 *   - `backfill`   — first-time-onboarding history capture. The
 *     adapter enumerated multiple versions and emitted one artifact
 *     per consecutive pair (or per collapsed range hop); see
 *     `backfill_event` for which.
 */
export type FetchMode = "incremental" | "backfill";

/**
 * Discriminator on backfill artifacts. Per the backfill slice plan
 * (vault: "Backfill Slice — Structured Lane Plan"):
 *
 *   - `backfill_pair` — one consecutive-version artifact; the recent
 *     window's full granularity. Carries `{ from, to, confidence: "high" }`
 *     in `backfill_range`.
 *   - `backfill_hop`  — one collapsed-range artifact; older versions
 *     grouped to fit the `max_artifacts` budget. Carries `{ from, to,
 *     version_count, confidence: "low" }` in `backfill_range`.
 *
 * Only present when `fetch_mode === "backfill"`. The unstructured
 * lane does not emit backfill artifacts in v1.
 */
export type BackfillEventType = "backfill_pair" | "backfill_hop";

/**
 * Range metadata for a backfill artifact. Only present when
 * `fetch_mode === "backfill"`. `version_count` is only set on
 * `backfill_hop` artifacts (the number of intermediate versions
 * collapsed into the single hop).
 */
export interface BackfillRange {
  readonly from: string;
  readonly to: string;
  readonly version_count?: number;
  readonly confidence: "high" | "low";
}

/**
 * A typed anchor. Carries the deterministic version/date identifier
 * for an unstructured entry alongside the mechanism that produced
 * it (ADR §10.4 — feeds forward into P2.4's per-mechanism
 * confidence weighting).
 *
 * Structured-lane artifacts don't carry an anchor (their version
 * field already encodes the equivalent).
 */
export interface DerivedAnchorEnvelope {
  /** Which mechanism produced this anchor. */
  readonly mechanism: "url_slug" | "heading" | "inline_regex" | "feed_field" | "none";
  /**
   * The extracted value (version string, ISO date, or feed guid).
   * `null` only when `mechanism === "none"` — every other mechanism
   * produces a value before it gets here.
   */
  readonly value: string | null;
  /** Per ADR §10.3 — `version` vs `date`. */
  readonly type: "version" | "date";
}

/**
 * Fetch provenance. Carries the URL that was fetched, the auth
 * mode, and (for the structured lane) the HTTP status. Unstructured
 * lane entries don't have an HTTP status — Firecrawl wraps the
 * response — so `httpStatus` is `null` for those.
 */
export interface FetchProvenance {
  /** The URL that was actually fetched (after template variable substitution). */
  readonly url: string;
  /**
   * The auth mode used. For structured lane: mirrors `fetch.auth`.
   * For unstructured lane: `firecrawl_scrape` (Firecrawl-driven),
   * `direct_https` (raw_file's plain GET), or a `FetchAuth` value
   * when the unstructured source has a bearer token configured.
   */
  readonly auth: FetchAuth | "firecrawl_scrape" | "direct_https";
  /** HTTP status (structured lane), or null when the lane wraps the request (unstructured). */
  readonly httpStatus: number | null;
  /** ISO-8601 timestamp of when this fetch actually happened. */
  readonly fetchedAt: string;
}

/**
 * The unified artifact envelope. One shape that covers both lanes.
 *
 * Field semantics differ slightly between lanes:
 *
 *   - `source_type`: structured types for the structured lane;
 *     `null` for unstructured (the source's `extraction_strategy`
 *     plays that role there, surfaced in `unstructured_strategy`).
 *
 *   - `version`: structured lane uses it directly; unstructured
 *     lane derives it from `anchor.value` when the anchor type is
 *     `version`, else leaves it `null`.
 *
 *   - `anchor`: structured lane is `null`; unstructured lane is
 *     the per-entry anchor.
 *
 *   - `body`: structured lane is the canonicalized raw bytes
 *     (sorted-key JSON, normalized-whitespace YAML, etc.);
 *     unstructured lane is the cleaned markdown (or the JSON-
 *     encoded RSS-item payload, per ADR §9.4).
 *
 *   - `metadata`: structured lane carries the auth + endpoint
 *     provenance; unstructured lane carries the per-item metadata
 *     (RSS guid/pubDate, etc.). Both shapes are extensible — we
 *     carry the fields P2.1-P2.4 need without forcing a rigid
 *     schema on either side.
 */
export interface Artifact {
  /** Mirrors the source spec's `id`. */
  readonly source_id: string;
  /**
   * The structured source type, or `null` for unstructured
   * lane entries. (Unstructured uses `unstructured_strategy`
   * instead — its equivalent discriminator.)
   */
  readonly source_type: StructuredSourceType | null;
  /** The unstructured extraction strategy, or `null` for structured lane. */
  readonly unstructured_strategy: ExtractionStrategy | null;
  /**
   * Vendor-asserted version, or `null` when the source has no
   * version field (raw CHANGES.md, RSS without a version, etc.).
   */
  readonly version: string | null;
  /**
   * SHA-256 of the canonicalized body. Per ADR §5: ALWAYS present,
   * regardless of whether `version` exists. P2.1's content hash
   * filter keys off this.
   */
  readonly content_hash: string;
  /** The canonicalized body (markdown / canonical-JSON / YAML). */
  readonly body: string;
  /** MIME-ish hint, e.g. "text/markdown", "application/json". */
  readonly content_type: string;
  /**
   * Per-entry anchor (unstructured lane only). `null` for
   * structured artifacts because their `version` field already
   * encodes the equivalent.
   */
  readonly anchor: DerivedAnchorEnvelope | null;
  /** Stable identifier for the individual entry. URL or RSS guid. */
  readonly entry_id: string | null;
  /** Per ADR §5. */
  readonly detection_method: DetectionMethod;
  /** ISO-8601. */
  readonly detected_at: string;
  /** Per-fetch provenance. */
  readonly fetch_provenance: FetchProvenance;
  /**
   * How the artifact was gathered. Always set; defaults to
   * `"incremental"` for the normal polling path, `"backfill"`
   * only when the host loop's backfill mode produced it.
   * Per the backfill slice plan, this is **distinct from**
   * `detection_method` — see `FetchMode` doc comment.
   */
  readonly fetch_mode: FetchMode;
  /**
   * Backfill event discriminator. Only present when
   * `fetch_mode === "backfill"`; absent for incremental artifacts.
   */
  readonly backfill_event?: BackfillEventType;
  /**
   * Backfill range metadata. Only present when
   * `fetch_mode === "backfill"`; carries the from/to version pair
   * (and `version_count` for collapsed hops).
   */
  readonly backfill_range?: BackfillRange;
}
