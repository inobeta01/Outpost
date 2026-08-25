/**
 * Tests for the orchestrator — end-to-end coverage of:
 *   - spec loading + dispatch routing
 *   - per-source failure isolation
 *   - loadFailure reporting for bad specs
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  withStubAdapter,
  type NormalizedArtifact,
  type SourceAdapter,
} from "../../sources/structured/index.js";
import type { ScrapeClient } from "../../sources/unstructured/strategy-registry.js";

import { runIngestion } from "../../sources/../host/orchestrator.js";
import { InMemoryP2Receiver } from "../../sources/../host/p2-receiver.js";
import { type FsLike } from "../../sources/../host/state-store.js";

class MemFs implements FsLike {
  files = new Map<string, string>();
  list: Array<{ name: string; isFile: () => boolean }> = [];

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
  async mkdir(p: string, _opts: { recursive: boolean }): Promise<void> {
    /* no-op */
  }
  async readdir(): Promise<Array<{ name: string; isFile: () => boolean }>> {
    return this.list;
  }
}

const STRUCTURED = {
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

const UNSTRUCTURED = {
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

const stubScrape: ScrapeClient = {
  scrape: () =>
    Promise.resolve({
      markdown: "# Changelog\n\n## v1.0.0\n\nInitial release.",
      html: "",
      metadata: { title: null, sourceURL: "https://reactrouter.com/changelog" },
    }),
};

describe("orchestrator (end-to-end)", () => {
  it("dispatches structured + unstructured sources, both artifacts pushed", async () => {
    const fs = new MemFs();
    fs.files.set("/sources/structured.json", JSON.stringify(STRUCTURED));
    fs.files.set("/sources/unstructured.json", JSON.stringify(UNSTRUCTURED));
    fs.list = [
      { name: "structured.json", isFile: () => true },
      { name: "unstructured.json", isFile: () => true },
    ];

    const adapter: SourceAdapter = {
      source_type: "github_releases",
      async fetch(): Promise<NormalizedArtifact> {
        return {
          source_id: STRUCTURED.id,
          source_type: "github_releases",
          version: "1.0.0",
          content_hash: "abc",
          raw_bytes: "# 1.0.0",
          raw_content_type: "text/markdown",
          detection_method: "first_poll",
          detected_at: "2026-08-25T12:00:00.000Z",
          fetch_metadata: {
            url: "https://api.github.com/repos/x/y/releases",
            auth: "github_token_env",
            status: 200,
            contentType: "application/json",
          },
        };
      },
    };

    const p2 = new InMemoryP2Receiver();
    await withStubAdapter("github_releases", adapter, async () => {
      const report = await runIngestion({
        sourcesDir: "/sources",
        stateDir: "/state",
        now: "2026-08-25T12:00:00.000Z",
        deps: {
          fetch: () => Promise.reject(new Error("unused")),
          readEnv: () => undefined,
          scrape: stubScrape,
        },
        p2,
        fs,
      });
      assert.equal(report.outcomes.length, 2);
      assert.equal(report.summary.loaded, 2);
      assert.ok(report.summary.succeeded >= 1);
      assert.ok(report.summary.artifactsPushed >= 2, `got ${report.summary.artifactsPushed}`);
      assert.equal(report.loadFailures.length, 0);
    });
  });

  it("surfaces validation failures without throwing", async () => {
    const fs = new MemFs();
    fs.files.set("/sources/good.json", JSON.stringify(STRUCTURED));
    fs.files.set("/sources/bad.json", JSON.stringify({ kind: "structured", source_type: "what" }));
    fs.list = [
      { name: "good.json", isFile: () => true },
      { name: "bad.json", isFile: () => true },
    ];

    const adapter: SourceAdapter = {
      source_type: "github_releases",
      async fetch(): Promise<NormalizedArtifact> {
        return {
          source_id: STRUCTURED.id,
          source_type: "github_releases",
          version: "1.0.0",
          content_hash: "abc",
          raw_bytes: "x",
          raw_content_type: "text/markdown",
          detection_method: "first_poll",
          detected_at: "2026-08-25T12:00:00.000Z",
          fetch_metadata: {
            url: "x",
            auth: "github_token_env",
            status: 200,
            contentType: "application/json",
          },
        };
      },
    };

    const p2 = new InMemoryP2Receiver();
    await withStubAdapter("github_releases", adapter, async () => {
      const report = await runIngestion({
        sourcesDir: "/sources",
        stateDir: "/state",
        now: "2026-08-25T12:00:00.000Z",
        deps: {
          fetch: () => Promise.reject(new Error("unused")),
          readEnv: () => undefined,
          scrape: stubScrape,
        },
        p2,
        fs,
      });
      assert.equal(report.loadFailures.length, 1);
      assert.equal(report.loadFailures[0]!.file, "bad.json");
      assert.equal(report.loadFailures[0]!.reason, "validation_failed");
      assert.equal(report.summary.loaded, 1);
    });
  });
});
