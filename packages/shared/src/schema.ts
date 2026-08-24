/**
 * @outpost/source-spec — TypeScript types
 *
 * The TypeScript mirror of `schemas/source-spec.schema.json`. Both are
 * generated from the same intent; if they ever disagree, the validator
 * catches it. Keep the two files in lockstep on every PR.
 *
 * Per the Ingestion Implementation Plan, this is the contract between
 * P1 (less-trusted, community-contributed adapters) and P2+ (registry
 * core). The blast radius is the file tree: a curated list of source
 * specs in `sources/*.json`, validated at PR time.
 */

/** Auth mode for outbound fetches. v1 only allows env-var-based auth. */
export type FetchAuth =
  | "none"
  | "github_token_env"
  | "npm_token_env"
  | "pypi_token_env"
  | "generic_bearer_env";

/** Fetch config shared by both structured and unstructured sources. */
export interface FetchConfig {
  readonly auth: FetchAuth;
  /** Per-source rate limit, e.g. "5000/h". Optional but recommended. */
  readonly rate_limit?: string;
}

/** Shape of the data an endpoint returns. Drives adapter choice at runtime. */
export type EndpointKind = "list" | "object" | "spec" | "raw";

/**
 * One named endpoint. `url` may be a template using `{var}` placeholders
 * whose bindings live in `variables` (e.g. `{owner}` → `"anthropics"`).
 */
export interface Endpoint {
  readonly url: string;
  readonly kind: EndpointKind;
  readonly variables?: Readonly<Record<string, string>>;
}

/**
 * Closed enum of structured source types. Per ADR §2, P1.1 is a dumb
 * switch statement on this value — no runtime inference. To add a new
 * structured source type, add it here AND in the JSON Schema's
 * `source_type.enum` AND write an adapter in
 * `packages/ingestion/src/sources/structured/adapters/`.
 */
export type StructuredSourceType =
  | "openapi"
  | "npm"
  | "pypi"
  | "github_releases"
  | "git_tracked_file";

/**
 * Defense-in-depth domain allowlist (ADR §2). Redundant with the
 * URL's own domain for well-formed configs; protects against a
 * malicious or sloppy community PR that points a URL somewhere
 * unexpected. The sandbox rejects any fetch whose target domain is
 * not in this list, independent of the URL string.
 */
export interface SecurityConfig {
  readonly allowed_domains: ReadonlyArray<string>;
}

/**
 * Per ADR §9.1, the extraction strategy is a declared, human-verified
 * config property, never inferred at runtime. Closed enum. Adding a
 * new strategy requires a new entry here, in the schema's
 * `extraction_strategy.enum`, and a new strategy file in
 * `packages/ingestion/src/sources/unstructured/extractors/`.
 */
export type ExtractionStrategy =
  | "single_page"
  | "index_then_detail"
  | "paginated_index"
  | "raw_file"
  | "rss";

/** Per ADR §10.2, where the version/date identifier for an entry comes from. */
export type AnchorSource =
  | "url_slug"
  | "heading"
  | "inline_regex"
  | "feed_field"
  | "none";

/**
 * Per-strategy config blocks. Exactly one applies, chosen by
 * `extraction_strategy`. The schema's `oneOf` enforces this at
 * validation time; the discriminated union gives the same
 * narrowing to TypeScript.
 */
export interface StrategyConfigSinglePage {
  readonly index_url: string;
}

export interface StrategyConfigIndexThenDetail {
  readonly index_url: string;
  /** Regex (no anchors) matching href of an entry-detail link on the index page. */
  readonly entry_link_pattern: string;
}

export interface StrategyConfigPaginatedIndex {
  readonly index_url: string;
  readonly pagination: {
    readonly param: string;
    readonly max_pages: number;
  };
}

export interface StrategyConfigRawFile {
  readonly file_url: string;
}

export interface StrategyConfigRss {
  readonly rss_url: string;
}

export type StrategyConfig =
  | StrategyConfigSinglePage
  | StrategyConfigIndexThenDetail
  | StrategyConfigPaginatedIndex
  | StrategyConfigRawFile
  | StrategyConfigRss;

/**
 * Unstructured (prose) source. `fetch.url` is the page (or file/feed)
 * fetched; how it's fetched depends on `extraction_strategy` and
 * `fetch_method`. v1: Firecrawl `scrape` is the only browser path;
 * `raw_file` and `rss` use direct HTTPS GET.
 */
export interface UnstructuredFetchConfig {
  readonly auth: "none" | "generic_bearer_env";
  readonly url: string;
  readonly type: "firecrawl";
  /** Per ADR §2 — only `scrape` is allowed. `crawl`/`map` are out of scope. */
  readonly fetch_method: "scrape";
  readonly rate_limit?: string;
}

/** Optional staleness sentinel. Per ADR §9.6. */
export interface StalenessSentinel {
  readonly max_inactivity_days?: number;
}

export interface UnstructuredSource {
  readonly id: string;
  readonly kind: "unstructured";
  readonly owner: string;
  readonly extraction_strategy: ExtractionStrategy;
  readonly strategy_config?: StrategyConfig;
  readonly fetch: UnstructuredFetchConfig;
  readonly security: SecurityConfig;
  /**
   * Per ADR §10.2 — locked per source at onboarding. Precedence
   * (url_slug > heading > inline_regex > feed_field > none) is
   * the runtime fallback order, but in practice each source
   * pins one.
   */
  readonly anchor_source: AnchorSource;
  /** Regex with at least one capture group. Required when anchor_source is url_slug/heading/inline_regex. */
  readonly anchor_pattern?: string;
  readonly staleness_sentinel?: StalenessSentinel;
  readonly firecrawl: true;
}

/**
 * Structured (machine-readable) source. One or more typed endpoints
 * (OpenAPI, npm, PyPI, GitHub releases) declared under `endpoints`.
 * No LLM, no Firecrawl — symbolic diff path.
 */
export interface StructuredSource {
  readonly id: string;
  readonly kind: "structured";
  readonly owner: string;
  readonly source_type: StructuredSourceType;
  readonly fetch: FetchConfig;
  readonly endpoints: Readonly<Record<string, Endpoint>>;
  readonly security: SecurityConfig;
  readonly firecrawl: false;
}

/** Discriminated union. Narrow with `source.kind === "structured"`. */
export type SourceSpec = StructuredSource | UnstructuredSource;

/** Type guard helpers — narrower than a full validate() call. */
export function isStructured(source: SourceSpec): source is StructuredSource {
  return source.kind === "structured";
}

export function isUnstructured(source: SourceSpec): source is UnstructuredSource {
  return source.kind === "unstructured";
}
