/**
 * @outpost/sandbox-runner
 *
 * Isolation primitive for community-contributed adapters. The whole point
 * of this package is that "network policy is enforced by isolation, not by
 * adapter cooperation" (per Ingestion Implementation Plan).
 *
 * v1 (PR 2): nsjail with allow-listed URLs.
 * v2: Firecracker / gVisor microVM.
 *
 * NOTE: This is a placeholder until PR 2 lands.
 */

export const SANDBOX_RUNNER_VERSION = "0.0.0" as const;
