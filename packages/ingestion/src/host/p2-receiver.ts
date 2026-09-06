/**
 * P2 stub receiver (PR 3 host-loop handoff).
 *
 * The vault plan calls for "hand to P2 via local socket". P2 itself
 * (the registry-core) is still a placeholder package — its real
 * implementation lands later. For PR 3's host loop we need a
 * pluggable receiver interface with a concrete in-memory impl
 * for tests and dev. v1 leaves no real socket.
 *
 * The receiver is intentionally tiny: `push()` takes an `Artifact`
 * and returns whatever P2 says (in v1: just "ok"). Validation of
 * the artifact is the receiver's responsibility — but in v1 we
 * accept everything. A real P2 will reject malformed envelopes.
 *
 * Why this lives in `ingestion/` and not `shared/`: it's purely a
 * P1-side concern (P1 needs to hand things off somewhere). P2
 * defines its own receiver interface when it grows up.
 */

import type { Artifact } from "@outpost/shared";

/** Result codes the receiver can return after pushing an artifact. */
export type P2PushResult =
  | { readonly ok: true; readonly artifactId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The handoff contract. Implementations decide what "ok" means —
 * the in-memory test impl just stores; a future socket impl would
 * post to a Unix domain socket.
 */
export interface P2Receiver {
  /**
   * Push one artifact to P2. Throws on transport errors (e.g.
   * socket disconnected); returns `ok: false` for validation-
   * level rejections the operator should see in logs.
   */
  push(artifact: Artifact): Promise<P2PushResult>;
}

/** Stable error thrown for transport-level failures. */
export class P2TransportError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "P2TransportError";
    this.cause = cause;
  }
}

/**
 * In-memory receiver. Stores all artifacts in an array; lets
 * tests assert on what was handed off without any I/O.
 *
 * v1: assigns sequential ids. A real P2 would use deterministic
 * ids derived from `source_id` + `content_hash`.
 */
export class InMemoryP2Receiver implements P2Receiver {
  private readonly store: Artifact[] = [];
  private nextId = 1;

  /** Read-only view of the artifacts received so far. */
  get artifacts(): ReadonlyArray<Artifact> {
    return this.store;
  }

  async push(artifact: Artifact): Promise<P2PushResult> {
    const id = `art_${String(this.nextId).padStart(8, "0")}`;
    this.nextId += 1;
    this.store.push(artifact);
    return { ok: true, artifactId: id };
  }
}
