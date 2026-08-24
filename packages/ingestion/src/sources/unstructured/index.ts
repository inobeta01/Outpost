/**
 * Unstructured source barrel.
 *
 * Importing this file:
 *   1. Re-exports the cross-cutting modules (content-validity,
 *      staleness-sentinel, anchor/, strategy-registry) used by
 *      every extraction strategy.
 *   2. Side-effect imports each strategy file (added in Slice 4),
 *      which registers them with `strategy-registry.ts`.
 *
 * Slice 3 wires the shared modules and the registry dispatch
 * primitives. Slice 4 will register the 5 strategies
 * (single_page, index_then_detail, paginated_index, raw_file, rss).
 *
 * Consumers (the host loop in PR 3, the test suite) should import
 * this barrel — not the module files directly — so the wiring is
 * centralized.
 */

export {
  validateContent,
  type ContentValidityResult,
  type ContentValidityInput,
} from "./content-validity.js";

export {
  checkStaleness,
  type StalenessCheckInput,
  type StalenessCheckResult,
} from "./staleness-sentinel.js";

export {
  deriveAnchor,
  ANCHOR_PRECEDENCE,
  type AnchorSpec,
  type AnchorDeriveInput,
  type DerivedAnchor,
  type AnchorType,
  type AnchorMechanism,
} from "./anchor/derive-anchor.js";

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
} from "./strategy-registry.js";

// Side-effect imports — register the 5 extraction strategies
// (single_page, index_then_detail, paginated_index, raw_file, rss)
// with the strategy registry. Importing this barrel is the only
// place this registration happens; tests and the host loop
// should always go through the barrel.
import "./extractors/single-page.strategy.js";
import "./extractors/index-then-detail.strategy.js";
import "./extractors/paginated-index.strategy.js";
import "./extractors/raw-file.strategy.js";
import "./extractors/rss.strategy.js";
