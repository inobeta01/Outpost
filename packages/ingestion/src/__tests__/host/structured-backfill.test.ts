/**
 * Tests for the structured-lane backfill host execution (PR 4 Slice 2).
 *
 * Covers: happy path, skip-when-complete, --force re-run,
 * `backfill_unsupported` mapping, P2 transport failure / rejection
 * (state stays `pending` for resume), envelope metadata threading,
 * and the artifact/plan-event zip invariant.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import {
  AdapterError,
  withStubAdapter,
  type BackfillResult,
  type BackfillPlanEvent,
  type NormalizedArtifact,
  type SourceAdapter,
} from "../../sources/structured/index.js";

import { runStructuredBackfill } from "../../host/structured-backfill.js";
import { runStructuredSource } from "../../host/structured-lane.js";
import { InMemoryP2Receiver } from "../../host/p2-receiver.js";
import { StateStore, type FsLike } from "../../host/state-store.js";

class MemFs implements FsLike {
  files = new Map<string, string>();
  async readFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return v;
  }
  async writeFile(p: string, d: string): Promise<void> {
    this.files.set(p, d);
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error("ENOENT");
    this.files.set(to, v);
    this.files.delete(from);
  }
  async mkdir(): Promise<void> {
    /* no-op */
  }
}

const source: StructuredSource = {
  id: "registry.npmjs.org/express",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "npm",
  fetch: { auth: "none" },
  endpoints: {
    package: {
      url: "https://registry.npmjs.org/express",
      kind: "object",
    },
  },
  security: { allowed_domains: ["registry.npmjs.org"] },
  firecrawl: false,
};

function normalizedArtifact(version: string): NormalizedArtifact {
  return {
    source_id: source.id,
    source_type: "npm",
    version,
    content_hash: `hash_${version}`,
    raw_bytes: `body of ${version}`,
    raw_content_type: "application/json",
    detection_method: "version_bump",
    detected_at: "2026-08-25T12:00:00.000Z",
    fetch_metadata: {
      url: "https://registry.npmjs.org/express",
      auth: "none",
      status: 200,
      contentType: "application/json",
    },
  };
}

/**
 * Stub adapter whose `backfill` returns a canned result built from
 * the given plan events. One artifact per event, versioned by the
 * event's `toVersion`.
 */
function backfillFixtureAdapter(
  events: ReadonlyArray<BackfillPlanEvent>,
  finalState = {
    lastSeenVersion: events[events.length - 1]?.toVersion ?? "1.0.0",
    lastSeenHash: "final_hash",
  },
): SourceAdapter {
  return {
    source_type: "npm",
    async fetch(): Promise<NormalizedArtifact> {
      throw new Error("incremental fetch unused in backfill tests");
    },
    async backfill(): Promise<BackfillResult> {
      return {
        artifacts: events.map((ev) => normalizedArtifact(ev.toVersion)),
        plan: {
          events,
          finalState,
          droppedObservations: [],
        },
      };
    },
  };
}

function seedState(
  fs: MemFs,
  extra: Record<string, unknown> = {},
): void {
  fs.files.set(
    "/state/registry.npmjs.org_express.json",
    JSON.stringify({
      version: 1,
      state: {
        source_id: source.id,
        kind: "structured",
        lastSeenVersion: null,
        lastSeenHash: null,
        lastPolledAt: "2026-08-01T00:00:00.000Z",
        pollCount: 0,
        ...extra,
      },
    }),
  );
}

const TWO_PAIRS: ReadonlyArray<BackfillPlanEvent> = [
  { type: "backfill_pair", fromVersion: "1.0.0", toVersion: "1.0.1" },
  { type: "backfill_pair", fromVersion: "1.0.1", toVersion: "1.0.2" },
];

async function runBackfill(
  state: StateStore,
  p2: InMemoryP2Receiver,
  overrides: Partial<Parameters<typeof runStructuredBackfill>[0]> = {},
) {
  return runStructuredBackfill({
    source,
    now: "2026-08-25T12:00:00.000Z",
    deps: {
      fetch: () => Promise.reject(new Error("unused")),
      readEnv: () => undefined,
    },
    state,
    p2,
    ...overrides,
  });
}

describe("structured-backfill host execution", () => {
  it("happy path: pushes one envelope per plan event, writes complete state", async () => {
    const adapter = backfillFixtureAdapter(TWO_PAIRS);
    await withStubAdapter("npm", adapter, async () => {
      const fs = new MemFs();
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();

      const result = await runBackfill(state, p2);

      assert.equal(result.status, "success");
      assert.equal(result.artifacts.length, 2);
      assert.equal(result.planEventCount, 2);
      assert.equal(result.droppedObservationCount, 0);
      assert.equal(result.errorCode, null);

      // Envelope metadata threading: fetch_mode + per-event
      // backfill_event/backfill_range populated from the plan.
      const first = result.artifacts[0]!;
      assert.equal(first.fetch_mode, "backfill");
      assert.equal(first.backfill_event, "backfill_pair");
      assert.equal(first.backfill_range?.from, "1.0.0");
      assert.equal(first.backfill_range?.to, "1.0.1");
      assert.equal(first.backfill_range?.confidence, "high");
      assert.equal(first.version, "1.0.1");
      assert.equal(first.content_hash, "hash_1.0.1");
      assert.equal(result.artifacts[1]?.backfill_range?.from, "1.0.1");
      assert.equal(result.artifacts[1]?.backfill_range?.to, "1.0.2");

      // P2 got every envelope in plan order.
      assert.equal(p2.artifacts.length, 2);
      assert.equal(p2.artifacts[0]?.backfill_range?.from, "1.0.0");

      // Final state: complete, seeded with the plan's finalState.
      const loaded = await state.read(source.id);
      assert.ok(loaded);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.backfillStatus, "complete");
        assert.ok(loaded.backfillRunId);
        assert.equal(loaded.backfillStartedAt, "2026-08-25T12:00:00.000Z");
        assert.equal(loaded.lastSeenVersion, "1.0.2");
        assert.equal(loaded.lastSeenHash, "final_hash");
      }
    });
  });

  it("hop events carry version_count + low confidence on the envelope", async () => {
    const events: ReadonlyArray<BackfillPlanEvent> = [
      { type: "backfill_hop", fromVersion: "1.0.0", toVersion: "1.0.3", versionCount: 3 },
      { type: "backfill_pair", fromVersion: "1.0.3", toVersion: "1.0.4" },
    ];
    const adapter = backfillFixtureAdapter(events);
    await withStubAdapter("npm", adapter, async () => {
      const state = new StateStore({ baseDir: "/state", fs: new MemFs() });
      const p2 = new InMemoryP2Receiver();
      const result = await runBackfill(state, p2);
      assert.equal(result.status, "success");
      const hop = result.artifacts[0]!;
      assert.equal(hop.backfill_event, "backfill_hop");
      assert.equal(hop.backfill_range?.version_count, 3);
      assert.equal(hop.backfill_range?.confidence, "low");
      assert.equal(result.artifacts[1]?.backfill_range?.confidence, "high");
    });
  });

  it("skips when backfillStatus is complete and force is not set", async () => {
    const fs = new MemFs();
    seedState(fs, { backfillStatus: "complete", backfillRunId: "r1", backfillStartedAt: "t" });
    const adapter = backfillFixtureAdapter(TWO_PAIRS);
    await withStubAdapter("npm", adapter, async () => {
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const result = await runBackfill(state, p2);
      assert.equal(result.status, "skipped");
      assert.equal(p2.artifacts.length, 0);
      assert.ok(result.message.includes("--force"));
      // State untouched.
      const loaded = await state.read(source.id);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.backfillStatus, "complete");
        assert.equal(loaded.backfillRunId, "r1");
      }
    });
  });

  it("re-runs when force is set even if already complete", async () => {
    const fs = new MemFs();
    seedState(fs, { backfillStatus: "complete", backfillRunId: "r1", backfillStartedAt: "t" });
    const adapter = backfillFixtureAdapter(TWO_PAIRS);
    await withStubAdapter("npm", adapter, async () => {
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const result = await runBackfill(state, p2, { force: true });
      assert.equal(result.status, "success");
      assert.equal(p2.artifacts.length, 2);
      const loaded = await state.read(source.id);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.backfillStatus, "complete");
        assert.notEqual(loaded.backfillRunId, "r1");
      }
    });
  });

  it("backfill_unsupported maps to backfill_skipped with state reverted", async () => {
    const unsupportedAdapter: SourceAdapter = {
      source_type: "npm",
      async fetch(): Promise<NormalizedArtifact> {
        throw new Error("unused");
      },
      async backfill(): Promise<BackfillResult> {
        throw new AdapterError("backfill_unsupported", "no vendor history");
      },
    };
    await withStubAdapter("npm", unsupportedAdapter, async () => {
      const fs = new MemFs();
      seedState(fs, { pollCount: 3 });
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const result = await runBackfill(state, p2);
      assert.equal(result.status, "backfill_skipped");
      assert.equal(p2.artifacts.length, 0);
      // State untouched: pending was reverted back to the pre-run shape.
      const loaded = await state.read(source.id);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.backfillStatus, null);
        assert.equal(loaded.backfillRunId, null);
        assert.equal(loaded.backfillStartedAt, null);
        assert.equal(loaded.pollCount, 3);
      }
    });
  });

  it("P2 transport throw mid-backfill fails the run and leaves state pending", async () => {
    const adapter = backfillFixtureAdapter(TWO_PAIRS);
    await withStubAdapter("npm", adapter, async () => {
      const fs = new MemFs();
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      p2.push = () => Promise.reject(new Error("socket disconnected"));
      const result = await runBackfill(state, p2);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "p2_transport");
      // State remains pending — the resume marker.
      const loaded = await state.read(source.id);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.backfillStatus, "pending");
        assert.ok(loaded.backfillRunId);
      }
    });
  });

  it("P2 validation rejection fails the run and leaves state pending", async () => {
    const adapter = backfillFixtureAdapter(TWO_PAIRS);
    await withStubAdapter("npm", adapter, async () => {
      const fs = new MemFs();
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      p2.push = () => Promise.resolve({ ok: false, reason: "bad envelope" });
      const result = await runBackfill(state, p2);
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "p2_rejected");
      const loaded = await state.read(source.id);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.backfillStatus, "pending");
      }
    });
  });

  it("adapter returning more artifacts than plan events throws (zip invariant)", async () => {
    const adapter: SourceAdapter = {
      source_type: "npm",
      async fetch(): Promise<NormalizedArtifact> {
        throw new Error("unused");
      },
      async backfill(): Promise<BackfillResult> {
        return {
          artifacts: [
            normalizedArtifact("1.0.1"),
            normalizedArtifact("1.0.2"),
          ],
          plan: {
            events: [{ type: "backfill_pair", fromVersion: "1.0.0", toVersion: "1.0.1" }],
            finalState: { lastSeenVersion: "1.0.2", lastSeenHash: "h" },
            droppedObservations: [],
          },
        };
      },
    };
    await withStubAdapter("npm", adapter, async () => {
      const state = new StateStore({ baseDir: "/state", fs: new MemFs() });
      const p2 = new InMemoryP2Receiver();
      await assert.rejects(() => runBackfill(state, p2), /plan events/);
    });
  });

  it("state seam: an incremental poll after backfill sees the seeded version/hash", async () => {
    const adapter = backfillFixtureAdapter(TWO_PAIRS);
    await withStubAdapter("npm", adapter, async () => {
      const fs = new MemFs();
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const backfillResult = await runBackfill(state, p2);
      assert.equal(backfillResult.status, "success");

      // Incremental poll with the adapter reporting the same latest
      // version + hash the backfill plan's finalState carried →
      // hash_only, no version_bump.
      const incrementalAdapter: SourceAdapter = {
        source_type: "npm",
        async fetch(_s, ctx): Promise<NormalizedArtifact> {
          assert.equal(ctx.lastSeenVersion, "1.0.2");
          assert.equal(ctx.lastSeenHash, "final_hash");
          return {
            source_id: source.id,
            source_type: "npm",
            version: "1.0.2",
            content_hash: "final_hash",
            raw_bytes: "body",
            raw_content_type: "application/json",
            detection_method: ctx.lastSeenVersion === "1.0.2" ? "hash_only" : "version_bump",
            detected_at: ctx.now,
            fetch_metadata: {
              url: "https://registry.npmjs.org/express",
              auth: "none",
              status: 200,
              contentType: "application/json",
            },
          };
        },
        async backfill(): Promise<BackfillResult> {
          throw new Error("unused");
        },
      };
      await withStubAdapter("npm", incrementalAdapter, async () => {
        const result = await runStructuredSource({
          source,
          now: "2026-08-26T12:00:00.000Z",
          deps: {
            fetch: () => Promise.reject(new Error("unused")),
            readEnv: () => undefined,
          },
          state,
          p2,
        });
        // hash_only artifact — the seeded state matches the latest.
        assert.equal(result.status, "success");
        assert.equal(result.artifact?.detection_method, "hash_only");
        assert.equal(result.artifact?.version, "1.0.2");
        // Backfill fields preserved by the incremental poll.
        const loaded = await state.read(source.id);
        if (loaded && loaded.kind === "structured") {
          assert.equal(loaded.backfillStatus, "complete");
          assert.equal(loaded.lastSeenVersion, "1.0.2");
          assert.equal(loaded.pollCount, 2);
        }
      });
    });
  });
});
