/**
 * @outpost/ingestion
 *
 * P1 host loop. By design, does almost no interesting work:
 *   - Walks sources/*.json, builds work queue
 *   - For each source: spawns sandbox, verifies artifact source_id hash
 *     matches declaration, hands to P2 via local socket
 *   - Signing happens HERE, before crossing into P2
 *
 * P1 is the LESS-TRUSTED half of the P1/P2 trust boundary. It must
 * never write to the registry DB, never run LLM calls, never normalize.
 * P2 owns all of those.
 *
 * Slice 2 landed the structured adapter layer (per source_type).
 * Slice 3 (this PR) lands the unstructured SHARED modules:
 *   - content-validity — ADR §9.5 (bot-challenge sanitization)
 *   - staleness-sentinel — ADR §9.6 (per-source inactivity check)
 *   - anchor/ — ADR §10 (deterministic version/date anchor parsing)
 *   - strategy-registry — dispatch map keyed by extraction_strategy
 *   - types — the 3-step contract (resolve_items / fetch_item / derive_anchor)
 *
 * Slice 4 will land the 5 extraction strategies themselves
 * (single_page, index_then_detail, paginated_index, raw_file, rss).
 *
 * The `@outpost/sandbox-runner` dependency is listed but NOT yet
 * imported anywhere — sandbox is out of scope for this PR per
 * project decision; someone else owns it. The adapter/strategy
 * code is written as pure functions so it can be wrapped by a
 * sandbox later without refactor.
 *
 * NOTE: The host loop (PR 3) is not in this package yet. Slices
 * 2-4 only ship the code that the host loop will invoke.
 */

export const INGESTION_VERSION = "0.2.0" as const;

// --- Structured lane (Slice 2) ---
export {
  getStructuredAdapter,
  registerStructuredAdapter,
  listRegisteredSourceTypes,
  AdapterError,
  type SourceAdapter,
  type NormalizedArtifact,
  type DetectionMethod,
  type FetchLike,
  type ReadEnvLike,
  type AdapterContext,
  type FetchMetadata,
  type AdapterErrorCode,
} from "./sources/structured/index.js";

// --- Unstructured lane shared modules (Slice 3) ---
// Re-exports of the cross-cutting modules every strategy uses.
export {
  validateContent,
  type ContentValidityResult,
  type ContentValidityInput,
} from "./sources/unstructured/content-validity.js";

export {
  checkStaleness,
  type StalenessCheckInput,
  type StalenessCheckResult,
} from "./sources/unstructured/staleness-sentinel.js";

export {
  deriveAnchor,
  ANCHOR_PRECEDENCE,
  type AnchorSpec,
  type AnchorDeriveInput,
  type DerivedAnchor,
  type AnchorType,
  type AnchorMechanism,
} from "./sources/unstructured/anchor/derive-anchor.js";

export {
  getStrategy,
  registerStrategy,
  listRegisteredStrategies,
  type ExtractionStrategyAdapter,
  type ResolveItemsInput,
  type ResolveItemsOutput,
  type FetchItemInput,
  type FetchItemOutput,
  type ExtractionTelemetry,
  StrategyExecutionError,
  type StrategyExecutionErrorCode,
} from "./sources/unstructured/strategy-registry.js";
