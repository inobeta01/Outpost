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
 * Source organization:
 *   - sources/structured/   — adapters for machine-readable sources
 *                             (OpenAPI, npm, PyPI, GitHub Releases).
 *                             Symbolic diff path, no LLM.
 *   - sources/unstructured/ — adapters for prose sources (changelogs,
 *                             docs, blogs). LLM extraction path.
 *
 * NOTE: Placeholder until PR 3 lands.
 */

export const INGESTION_VERSION = "0.0.0" as const;
