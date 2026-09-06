/**
 * @outpost/processing
 *
 * P2 — the trust boundary's other half. Core-maintainer-owned code only.
 *
 * Owns:
 *   - P2.1 Content hash filter (decides "is this actually new?")
 *   - P2.2 Spec/SDK symbolic diff (no LLM, structured lane)
 *   - P2.3 Prose normalize (LLM extraction, structured-output only,
 *           zero tool access — per ADR §9)
 *   - P2.4 Confidence scoring
 *   - P2.5 HMAC signing of ChangeEvents
 *
 * Architecture Review gap #1: a deterministic validator must sit
 * AFTER P2.3 and BEFORE P2.5. Extracted content must be re-parsed
 * against the source before signing.
 *
 * NOTE: Placeholder until P2 work begins.
 */

export const PROCESSING_VERSION = "0.0.0" as const;
