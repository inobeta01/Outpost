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
  withStubAdapter,
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
  type ResolvedItem,
  type ScrapeClient,
  type ExtractionTelemetry,
  StrategyExecutionError,
  type StrategyExecutionErrorCode,
} from "./sources/unstructured/strategy-registry.js";

export { buildAnchorInput } from "./sources/unstructured/anchor-input.js";

// --- Host loop (PR 3) ---
export {
  runIngestion,
  type RunIngestionOptions,
  type RunReport,
  type PerSourceOutcome,
  type BackfillSummary,
} from "./host/orchestrator.js";
export { runStructuredSource, type StructuredRunResult } from "./host/structured-lane.js";
export {
  runStructuredBackfill,
  type StructuredBackfillResult,
  type StructuredBackfillOptions,
} from "./host/structured-backfill.js";
export { runUnstructuredSource, type UnstructuredRunResult } from "./host/unstructured-lane.js";
export { runEnrichment, type EnrichmentRunResult, type EnrichmentRunOptions } from "./host/enrichment-lane.js";
export { loadSources, type LoadedSource, type LoadFailure, type LoadReport } from "./host/source-loader.js";
export {
  StateStore,
  initialState,
  loadOrInit,
  type SourceState,
  type EntryState,
  type FsLike,
  type BackfillStatus,
} from "./host/state-store.js";
export {
  InMemoryP2Receiver,
  P2TransportError,
  type P2Receiver,
  type P2PushResult,
} from "./host/p2-receiver.js";

// --- Backfill plan module (PR 4 Slice 1) ---
export {
  computeBackfillPlan,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_RECENT_WINDOW_MS,
  DEFAULT_MAX_ARTIFACTS,
  type BackfillPlanEvent,
  type BackfillPlan,
  type BackfillPlanOptions,
} from "./sources/structured/backfill-plan.js";

// --- Backfill contract types (PR 4 Slice 1) ---
export {
  type BackfillOptions,
  type BackfillResult,
  type VersionObservation,
} from "./sources/structured/types.js";
