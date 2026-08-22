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
 * NOTE: PR 1 will replace this stub with the real source-spec schema
 * (per the Ingestion Implementation Plan) and 3 example provider
 * sources (GitHub releases, npm, one Firecrawl unstructured).
 */

export const SOURCE_SPEC_VERSION = "0.0.0" as const;
