/**
 * Structured source barrel.
 *
 * Importing this file:
 *   1. Re-exports the public types, the registry helpers, and the
 *      AdapterError class.
 *   2. Side-effect imports every adapter, which registers them with
 *      `source-registry.ts`.
 *
 * Consumers (the host loop in PR 3, the test suite) should import
 * this barrel — not `source-registry.ts` directly and not the adapter
 * files directly — so the wiring is centralized.
 */

export {
  AdapterError,
  type SourceAdapter,
  type NormalizedArtifact,
  type DetectionMethod,
  type FetchLike,
  type ReadEnvLike,
  type AdapterContext,
  type FetchMetadata,
  type AdapterErrorCode,
} from "./types.js";

export {
  getStructuredAdapter,
  registerStructuredAdapter,
  listRegisteredSourceTypes,
  withStubAdapter,
} from "./source-registry.js";

// Side-effect imports — these register each adapter at module-load time.
import "./adapters/openapi.adapter.js";
import "./adapters/npm.adapter.js";
import "./adapters/pypi.adapter.js";
import "./adapters/github-releases.adapter.js";
