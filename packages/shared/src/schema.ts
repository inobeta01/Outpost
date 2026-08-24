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

/** CSS selectors for parsing one entry out of an unstructured page. */
export interface UnstructuredSelectors {
  readonly entry: string;
  readonly title: string;
  readonly date: string;
}

/**
 * Unstructured (prose) source. The `fetch.url` is a single page crawled
 * by Firecrawl; entries are extracted via `selectors`. v1 Firecrawl only.
 */
export interface UnstructuredFetchConfig extends FetchConfig {
  readonly auth: "none" | "generic_bearer_env";
  readonly url: string;
  readonly type: "firecrawl";
}

export interface UnstructuredSource {
  readonly id: string;
  readonly kind: "unstructured";
  readonly owner: string;
  readonly fetch: UnstructuredFetchConfig;
  readonly selectors: UnstructuredSelectors;
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
  readonly fetch: FetchConfig;
  readonly endpoints: Readonly<Record<string, Endpoint>>;
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
