/**
 * @outpost/source-spec
 *
 * Typed provider/source configs. This package is the contract between
 * the ingestion layer (P1, less-trusted, community-contributed adapters)
 * and the registry core (P2+).
 *
 * The blast radius is the file tree: schema + types define what a
 * provider config CAN express, and the JSON Schema validator enforces
 * it at PR time.
 *
 * PR 1 lands the schema, types, validator, and 5 example sources
 * (4 structured + 1 unstructured). PR 2 fills in
 * `packages/ingestion/src/sources/{structured,unstructured}/` — the
 * adapter and strategy code that runs inside the sandbox.
 */

export const SOURCE_SPEC_VERSION = "0.1.0" as const;

export type {
  AnchorSource,
  Endpoint,
  EndpointKind,
  EnrichmentConfig,
  ExtractionStrategy,
  FetchAuth,
  FetchConfig,
  SecurityConfig,
  SourceSpec,
  StalenessSentinel,
  StrategyConfig,
  StrategyConfigIndexThenDetail,
  StrategyConfigPaginatedIndex,
  StrategyConfigRawFile,
  StrategyConfigRss,
  StrategyConfigSinglePage,
  StructuredSource,
  StructuredSourceType,
  UnstructuredFetchConfig,
  UnstructuredSource,
} from "./schema.js";

export { isStructured, isUnstructured } from "./schema.js";

export { validateSourceSpec } from "./validate.js";
export { SourceSpecValidationError } from "./validate.js";

export type {
  Artifact,
  BackfillEventType,
  BackfillRange,
  DetectionMethod,
  DerivedAnchorEnvelope,
  FetchMode,
  FetchProvenance,
} from "./artifact.js";
