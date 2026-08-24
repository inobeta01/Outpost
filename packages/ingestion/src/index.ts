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
 * Slice 2 (this PR) lands the structured adapter layer:
 *   - sources/structured/types.ts     — SourceAdapter interface,
 *                                       NormalizedArtifact output
 *   - sources/structured/source-registry.ts — dispatch map keyed by
 *                                             source_type
 *   - sources/structured/adapters/    — one file per source_type
 *                                       (openapi, npm, pypi,
 *                                       github_releases)
 *
 * Slice 3 will land the unstructured shared modules
 * (content-validity, staleness-sentinel, anchor derivation).
 * Slice 4 will land the 5 extraction strategies.
 *
 * The `@outpost/sandbox-runner` dependency is listed but NOT yet
 * imported anywhere — sandbox is out of scope for this PR per
 * project decision; someone else owns it. The adapter code is
 * written as pure functions so it can be wrapped by a sandbox
 * later without refactor.
 *
 * NOTE: The host loop (PR 3) is not in this package yet. This PR
 * only ships the adapter/strategy code that the host loop will
 * invoke.
 */

export const INGESTION_VERSION = "0.1.0" as const;

// Re-export the structured-source barrel. Importing this file
// wires every adapter into the registry. The host loop (PR 3) and
// tests should import this barrel; importing individual files will
// leave the registry empty for that source_type.
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
