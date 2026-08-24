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
 * (4 structured + 1 unstructured). PR 2 adds sandbox-runner; PR 3
 * adds the host loop and artifact envelope.
 */

export const SOURCE_SPEC_VERSION = "0.0.0" as const;

export type {
  Endpoint,
  EndpointKind,
  FetchAuth,
  FetchConfig,
  SourceSpec,
  StructuredSource,
  UnstructuredFetchConfig,
  UnstructuredSelectors,
  UnstructuredSource,
} from "./schema.js";

export { isStructured, isUnstructured } from "./schema.js";

export { validateSourceSpec } from "./validate.js";
export { SourceSpecValidationError } from "./validate.js";
