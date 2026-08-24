/**
 * Structured source-type → adapter dispatch.
 *
 * The host loop (PR 3) calls `getStructuredAdapter(source.source_type)`
 * to find the right adapter for a given `StructuredSource`. Adapters
 * register themselves with `registerStructuredAdapter` at module-load
 * time; importing `./index.js` (the barrel) is what wires them in.
 *
 * The map is keyed by `StructuredSourceType` (a closed enum from
 * `@outpost/shared`) — adding a new source type is impossible without
 * updating the enum, which is the point. There is no runtime fallback.
 *
 * Usage:
 *
 *   // In host loop:
 *   import "./sources/structured/index.js"; // wire the registry
 *   const adapter = getStructuredAdapter(source.source_type);
 *   const artifact = await adapter.fetch(source, ctx, { fetch, readEnv });
 *
 *   // In tests:
 *   import "./sources/structured/index.js"; // wire the registry
 *   registerStructuredAdapter(myStubAdapter); // override for the test
 *
 * IMPORTANT: do NOT import any adapter file from this registry module —
 * the import would create a cycle (adapter → registry → adapters/index
 * → adapter) that triggers a TDZ ReferenceError on load. The barrel
 * import is the single source of truth for wiring.
 */

import type { StructuredSourceType } from "@outpost/shared";

import { AdapterError, type SourceAdapter } from "./types.js";

const registry = new Map<StructuredSourceType, SourceAdapter>();

/**
 * Register an adapter for its `source_type`. Throws if a different
 * adapter is already registered for the same type — a guard against
 * accidental double-registration that would silently mask bugs.
 */
export function registerStructuredAdapter(adapter: SourceAdapter): () => void {
  const existing = registry.get(adapter.source_type);
  if (existing && existing !== adapter) {
    throw new AdapterError(
      "schema_mismatch",
      `duplicate registration for source_type=${adapter.source_type}; ` +
        `an adapter is already registered for this type`,
    );
  }
  registry.set(adapter.source_type, adapter);
  return () => {
    if (registry.get(adapter.source_type) === adapter) {
      registry.delete(adapter.source_type);
    }
  };
}

/**
 * Look up the adapter for a `source_type`. Throws `AdapterError`
 * with code `"schema_mismatch"` if no adapter is registered — which
 * is a programming error, not a runtime condition, since the closed
 * enum + this registry are kept in lockstep.
 */
export function getStructuredAdapter(
  sourceType: StructuredSourceType,
): SourceAdapter {
  const adapter = registry.get(sourceType);
  if (!adapter) {
    throw new AdapterError(
      "schema_mismatch",
      `no adapter registered for source_type=${sourceType}; ` +
        `add an adapter under packages/ingestion/src/sources/structured/adapters/ ` +
        `and import the barrel from packages/ingestion/src/sources/structured/index.js`,
    );
  }
  return adapter;
}

/**
 * List the source types currently registered. Useful for diagnostics
 * and for the host loop's "all registered types" sanity check.
 */
export function listRegisteredSourceTypes(): ReadonlyArray<StructuredSourceType> {
  return Array.from(registry.keys());
}
