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
