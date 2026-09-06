/**
 * Tests for the StateStore (PR3 Slice 2).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  StateStore,
  initialState,
  loadOrInit,
  type FsLike,
} from "../../sources/../host/state-store.js";

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
  async writeFile(p: string, data: string): Promise<void> {
    this.files.set(p, data);
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error("ENOENT");
    this.files.set(to, v);
    this.files.delete(from);
  }
  async mkdir(): Promise<void> {
    /* no-op for in-memory */
  }
}

describe("StateStore", () => {
  it("returns null when no state file exists", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    const got = await store.read("never-seen");
    assert.equal(got, null);
  });

  it("persists structured state to a JSON file, atomic via tmp+rename", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    const state = initialState("github.com/x/y", "structured", "2026-08-25T12:00:00.000Z");
    if (state.kind !== "structured") throw new Error("kind mismatch");

    await store.write({
      ...state,
      lastSeenVersion: "1.2.3",
      lastSeenHash: "abc",
      pollCount: 1,
    });

    // The .tmp file should have been renamed (not left behind).
    const dir = Array.from(fs.files.keys());
    const jsons = dir.filter((p) => p.endsWith(".json"));
    const tmps = dir.filter((p) => p.endsWith(".tmp"));
    assert.equal(jsons.length, 1, "one .json remains");
    assert.equal(tmps.length, 0, "no .tmp left after rename");
  });

  it("loadOrInit returns initial state for first-time sources", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    const state = await loadOrInit(store, "stripe.com/changelog", "unstructured", "2026-08-25T12:00:00.000Z");
    assert.equal(state.kind, "unstructured");
    assert.equal(state.pollCount, 0);
    assert.equal(state.entries.length, 0);
  });

  it("loadOrInit returns disk state when present and kinds match", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    const persisted = initialState("stripe.com/changelog", "unstructured", "2026-08-25T12:00:00.000Z");
    await store.write(persisted);
    const loaded = await loadOrInit(store, "stripe.com/changelog", "unstructured", "2026-08-25T13:00:00.000Z");
    assert.equal(loaded.kind, "unstructured");
  });

  it("loadOrInit throws on kind mismatch (corrupted state file)", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    const persisted = initialState("x", "structured", "2026-08-25T12:00:00.000Z");
    await store.write(persisted);
    await assert.rejects(
      loadOrInit(store, "x", "unstructured", "2026-08-25T13:00:00.000Z"),
      /state-file kind mismatch/,
    );
  });
});

describe("initialState (structured, version-join fields)", () => {
  it("initializes enrichments, pendingEnrichments, enrichmentLastRunAt as empty/null", () => {
    const s = initialState("pypi/requests", "structured", "2026-08-25T12:00:00.000Z");
    if (s.kind !== "structured") throw new Error("expected structured");
    assert.deepEqual(s.enrichments, []);
    assert.deepEqual(s.pendingEnrichments, []);
    assert.equal(s.enrichmentLastRunAt, null);
  });
});

describe("migrateState (version-join fields)", () => {
  it("fills missing enrichments with [] for pre-existing state files", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    // Write a state file without the enrichment fields, simulating
    // a pre-version-join state file.
    fs.files.set(
      "/state/pypi_requests.json",
      JSON.stringify({
        version: 1,
        state: {
          source_id: "pypi/requests",
          kind: "structured",
          lastSeenVersion: "2.32.3",
          lastSeenHash: "abc",
          lastPolledAt: "2026-08-25T12:00:00.000Z",
          pollCount: 5,
          backfillStatus: "complete",
          backfillRunId: "r1",
          backfillStartedAt: "2026-08-20T00:00:00.000Z",
          backfillCheckpoint: null,
        },
      }),
    );
    const got = await store.read("pypi/requests");
    assert.ok(got);
    if (got && got.kind === "structured") {
      assert.deepEqual(got.enrichments, []);
      assert.deepEqual(got.pendingEnrichments, []);
      assert.equal(got.enrichmentLastRunAt, null);
      // Existing fields preserved.
      assert.equal(got.lastSeenVersion, "2.32.3");
      assert.equal(got.backfillStatus, "complete");
      assert.equal(got.pollCount, 5);
    }
  });

  it("preserves existing enrichment fields when present", async () => {
    const fs = new MemFs();
    const store = new StateStore({ baseDir: "/state", fs });
    fs.files.set(
      "/state/pypi_requests.json",
      JSON.stringify({
        version: 1,
        state: {
          source_id: "pypi/requests",
          kind: "structured",
          lastSeenVersion: "2.32.3",
          lastSeenHash: "abc",
          lastPolledAt: "2026-08-25T12:00:00.000Z",
          pollCount: 5,
          backfillStatus: "complete",
          backfillRunId: "r1",
          backfillStartedAt: "2026-08-20T00:00:00.000Z",
          backfillCheckpoint: null,
          enrichments: [
            { version: "2.32.3", contentHash: "h1", lastSeenAt: "2026-08-25T12:00:00.000Z" },
          ],
          pendingEnrichments: ["2.32.4"],
          enrichmentLastRunAt: "2026-08-25T12:00:00.000Z",
        },
      }),
    );
    const got = await store.read("pypi/requests");
    assert.ok(got);
    if (got && got.kind === "structured") {
      assert.equal(got.enrichments.length, 1);
      assert.equal(got.enrichments[0]?.version, "2.32.3");
      assert.equal(got.enrichments[0]?.contentHash, "h1");
      assert.deepEqual(got.pendingEnrichments, ["2.32.4"]);
      assert.equal(got.enrichmentLastRunAt, "2026-08-25T12:00:00.000Z");
    }
  });
});
