/**
 * @outpost/registry-core
 *
 * Trust root. Single-writer service holds the signing key. Append-only,
 * versioned Postgres DB. Read replicas for public availability.
 *
 * Open-core posture (per Architecture Review gap #2):
 *   - Open-source release: per-deployment key generated on first run,
 *     produces a PRIVATELY verifiable registry.
 *   - Hosted tier: shared root, produces a PUBLICLY verifiable registry.
 *
 * Both modes need an explicit supersede/revoke mechanism (gap #3)
 * — not yet implemented.
 *
 * NOTE: Placeholder.
 */

export const REGISTRY_CORE_VERSION = "0.0.0" as const;
