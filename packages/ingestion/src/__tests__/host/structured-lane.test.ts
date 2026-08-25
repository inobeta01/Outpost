/**
 * Tests for the structured-lane host execution.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { StructuredSource } from "@outpost/shared";

import {
  getStructuredAdapter,
  registerStructuredAdapter,
  withStubAdapter,
  type AdapterContext,
  type FetchLike,
  type NormalizedArtifact,
  type ReadEnvLike,
  type SourceAdapter,
  type StructuredSourceType,
} from "../../sources/structured/index.js";

import { runStructuredSource } from "../../sources/../host/structured-lane.js";
import { InMemoryP2Receiver } from "../../sources/../host/p2-receiver.js";
import {
  StateStore,
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
  id: "github.com/x/y",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "github_releases",
  fetch: { auth: "github_token_env" },
  endpoints: {
    releases: {
      url: "https://api.github.com/repos/x/y/releases",
      kind: "list",
    },
  },
  security: { allowed_domains: ["api.github.com"] },
  firecrawl: false,
};

function fixtureAdapter(
  responses: Array<{
    version: string;
    content_hash: string;
  }>,
  mode: "queue" | "exhaust" = "queue",
): SourceAdapter {
  let i = 0;
  return {
    source_type: "github_releases",
    async fetch(
      _source: StructuredSource,
      ctx: AdapterContext,
      _deps: { fetch: FetchLike; readEnv: ReadEnvLike },
    ): Promise<NormalizedArtifact> {
      const r =
        mode === "queue"
          ? responses[Math.min(i, responses.length - 1)]!
          : (responses[i++] ?? responses[responses.length - 1]!);
      const isVersionBump = ctx.lastSeenVersion !== r.version;
      return {
        source_id: _source.id,
        source_type: "github_releases",
        version: r.version,
        content_hash: r.content_hash,
        raw_bytes: `# ${r.version}\n\nbody`,
        raw_content_type: "text/markdown",
        detection_method: isVersionBump ? "version_bump" : "hash_only",
        detected_at: ctx.now,
        fetch_metadata: {
          url: "https://api.github.com/repos/x/y/releases",
          auth: "github_token_env",
          status: 200,
          contentType: "application/json",
        },
      };
    },
  };
}

describe("structured-lane host execution", () => {
  it("first poll emits first_poll, persists state, pushes to P2", async () => {
    const adapter = fixtureAdapter([{ version: "1.0.0", content_hash: "aaa" }]);
    await withStubAdapter("github_releases", adapter, async () => {
      const fs = new MemFs();
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const result = await runStructuredSource({
        source,
        now: "2026-08-25T12:00:00.000Z",
        deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: () => undefined },
        state,
        p2,
      });
      assert.equal(result.status, "success");
      assert.ok(result.artifact);
      assert.equal(result.artifact!.detection_method, "first_poll");
      assert.equal(result.artifact!.version, "1.0.0");
      assert.equal(p2.artifacts.length, 1);
      const loaded = await state.read("github.com/x/y");
      assert.ok(loaded);
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.lastSeenVersion, "1.0.0");
        assert.equal(loaded.pollCount, 1);
      }
    });
  });

  it("version bump on second poll emits version_bump", async () => {
    const fs = new MemFs();
    await fs.writeFile(
      "/state/github.com_x_y.json",
      JSON.stringify({
        version: 1,
        state: {
          source_id: "github.com/x/y",
          kind: "structured",
          lastSeenVersion: "1.0.0",
          lastSeenHash: "aaa",
          lastPolledAt: "2026-08-01T00:00:00.000Z",
          pollCount: 1,
        },
      }),
    );

    const adapter = fixtureAdapter([{ version: "1.1.0", content_hash: "bbb" }]);
    await withStubAdapter("github_releases", adapter, async () => {
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const result = await runStructuredSource({
        source,
        now: "2026-08-25T12:00:00.000Z",
        deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: () => undefined },
        state,
        p2,
      });
      assert.equal(result.status, "success");
      assert.equal(result.artifact!.detection_method, "version_bump");
      const loaded = await state.read("github.com/x/y");
      if (loaded && loaded.kind === "structured") {
        assert.equal(loaded.lastSeenVersion, "1.1.0");
        assert.equal(loaded.pollCount, 2);
      }
    });
  });

  it("returns failed when the adapter throws", async () => {
    const failingAdapter: SourceAdapter = {
      source_type: "github_releases",
      async fetch(): Promise<NormalizedArtifact> {
        throw new Error("upstream 500");
      },
    };
    await withStubAdapter("github_releases", failingAdapter, async () => {
      const fs = new MemFs();
      const state = new StateStore({ baseDir: "/state", fs });
      const p2 = new InMemoryP2Receiver();
      const result = await runStructuredSource({
        source,
        now: "2026-08-25T12:00:00.000Z",
        deps: { fetch: () => Promise.reject(new Error("unused")), readEnv: () => undefined },
        state,
        p2,
      });
      assert.equal(result.status, "failed");
      assert.equal(p2.artifacts.length, 0);
    });
  });
});
