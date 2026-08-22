/**
 * @outpost/verification-sdk
 *
 * N4 from the Architecture diagram. The "verification" half of the trust
 * boundary — every consumer that wants to act on a ChangeEvent uses this
 * SDK to confirm it was actually signed by the registry's trust root.
 *
 * Without a published SDK, the Architecture Review gap #7 holds: the
 * "open" promise is a spec without a smoking gun. This package is the
 * smoking gun.
 *
 * Two verification modes (per Architecture Review gap #2):
 *   1. PRIVATELY verifiable — self-hosted registry, per-deployment key,
 *      consumer pins the public key out-of-band.
 *   2. PUBLICLY verifiable — hosted registry, shared trust root, key
 *      discoverable (Open Question #1: PKI? Sigstore? DNS? MCP init?).
 *
 * NOTE: Placeholder until the public key discovery decision lands.
 */

export const VERIFICATION_SDK_VERSION = "0.0.0" as const;
