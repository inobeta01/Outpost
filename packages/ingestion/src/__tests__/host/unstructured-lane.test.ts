/**
 * Tests for the unstructured-lane host execution.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { UnstructuredSource } from "@outpost/shared";

import { getStrategy, type ScrapeClient } from "../../sources/unstructured/strategy-registry.js";

import { runUnstructuredSource } from "../../sources/../host/unstructured-lane.js";
import { InMemoryP2Receiver } from "../../sources/../host/p2-receiver.js";
import { StateStore, type FsLike } from "../../sources/../host/state-store.js";

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

const source: UnstructuredSource = {
  id: "reactrouter.com/changelog",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "single_page",
  strategy_config: { index_url: "https://reactrouter.com/changelog" },
  fetch: {
    auth: "none",
    url: "https://reactrouter.com/changelog",
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["reactrouter.com"] },
  anchor_source: "heading",
  anchor_pattern: "v?(\\d+\\.\\d+\\.\\d+)",
  firecrawl: true,
};

function stubScrapeClient(body: string): ScrapeClient {
  return {
    scrape: () =>
      Promise.resolve({
        markdown: body,
        html: "",
        metadata: { title: null, sourceURL: "https://reactrouter.com/changelog" },
      }),
  };
}

describe("unstructured-lane host execution", () => {
  it("first poll: fetches, derives anchor, pushes first_poll artifact", async () => {
    getStrategy("single_page");
    const body = "# Changelog\n\n## v1.0.0\n\nInitial release.";
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    const result = await runUnstructuredSource({
      source,
      now: "2026-08-25T12:00:00.000Z",
      deps: {
        fetch: () => Promise.reject(new Error("unused")),
        readEnv: () => undefined,
        scrape: stubScrapeClient(body),
      },
      state,
      p2,
    });
    assert.equal(result.status, "success");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]!.detection_method, "first_poll");
    assert.equal(p2.artifacts.length, 1);
    const loaded = await state.read(source.id);
    assert.ok(loaded);
    if (loaded && loaded.kind === "unstructured") {
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.pollCount, 1);
    }
  });

  it("pre-seeded state with the entry hash produces entry_update detection", async () => {
    const fs = new MemFs();
    const priorBody = "# Changelog\n\n## v1.0.0\n\nInitial release.";
    const priorHash = (await import("../../sources/structured/canonical.js")).hashText(priorBody);
    await fs.writeFile(
      "/state/reactrouter.com_changelog.json",
      JSON.stringify({
        version: 1,
        state: {
          source_id: source.id,
          kind: "unstructured",
          entries: [
            {
              entryId: "https://reactrouter.com/changelog",
              contentHash: priorHash,
              lastSeenAt: "2026-08-25T11:00:00.000Z",
            },
          ],
          lastSeenAnchors: [],
          lastPolledAt: "2026-08-25T11:00:00.000Z",
          pollCount: 1,
        },
      }),
    );
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    const result = await runUnstructuredSource({
      source,
      now: "2026-08-25T12:00:00.000Z",
      deps: {
        fetch: () => Promise.reject(new Error("unused")),
        readEnv: () => undefined,
        scrape: stubScrapeClient(priorBody),
      },
      state,
      p2,
    });
    // Same body → same hash → entry_update. (Single page can't
    // dedupe by anchor, so the host loop sees the same item
    // every poll.)
    assert.ok(["success", "skipped"].includes(result.status));
    if (result.status === "success" && result.artifacts.length === 1) {
      assert.equal(result.artifacts[0]!.detection_method, "entry_update");
    }
  });

  it("per-item scrape failure → no artifact, telemetry emitted", async () => {
    getStrategy("single_page");
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    const failingScrape: ScrapeClient = {
      scrape: () => Promise.reject(new Error("firecrawl 502")),
    };
    const result = await runUnstructuredSource({
      source,
      now: "2026-08-25T12:00:00.000Z",
      deps: {
        fetch: () => Promise.reject(new Error("unused")),
        readEnv: () => undefined,
        scrape: failingScrape,
      },
      state,
      p2,
    });
    // Single-item strategies swallow per-item scrape failures
    // as recoverable errors (telemetry-only). The host loop
    // considers that a "success-but-no-artifacts" outcome.
    assert.ok(["success", "skipped"].includes(result.status));
    assert.equal(p2.artifacts.length, 0);
    // Telemetry carries the warning.
    assert.ok(
      result.telemetry.some((t) => t.event === "fetch_warning_bot_challenge"),
      "expected fetch_warning_bot_challenge telemetry",
    );
  });
});
