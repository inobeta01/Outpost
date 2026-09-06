/**
 * Tests for the source-spec loader.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { FsLike } from "../../sources/../host/state-store.js";
import { loadSources } from "../../sources/../host/source-loader.js";

interface DirEntry {
  name: string;
  isFile: () => boolean;
}

class MemFs implements FsLike {
  constructor(public files: Map<string, string>) {}
  list: DirEntry[] = [];

  async readFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return v;
  }
  async writeFile(): Promise<void> {
    /* unused */
  }
  async rename(): Promise<void> {
    /* unused */
  }
  async mkdir(): Promise<void> {
    /* unused */
  }
  async readdir(p: string): Promise<DirEntry[]> {
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
  id: "stripe.com/changelog",
  kind: "unstructured",
  owner: "@vendor-bot",
  extraction_strategy: "single_page",
  strategy_config: { index_url: "https://stripe.com/changelog" },
  fetch: {
    auth: "none",
    url: "https://stripe.com/changelog",
    type: "firecrawl",
    fetch_method: "scrape",
  },
  security: { allowed_domains: ["stripe.com"] },
  anchor_source: "heading",
  firecrawl: true,
};

describe("source-spec loader", () => {
  it("loads + validates a directory of structured + unstructured specs", async () => {
    const fs = new MemFs(
      new Map([
        ["/sources/x.json", JSON.stringify(STRUCTURED)],
        ["/sources/y.json", JSON.stringify(UNSTRUCTURED)],
      ]),
    );
    fs.list = [
      { name: "x.json", isFile: () => true },
      { name: "y.json", isFile: () => true },
    ];
    const report = await loadSources("/sources", fs);
    assert.equal(report.sources.length, 2);
    assert.equal(report.failures.length, 0);
    assert.equal(report.sources[0]!.spec.kind, "structured");
    assert.equal(report.sources[1]!.spec.kind, "unstructured");
  });

  it("skips hidden files and non-.json files", async () => {
    const fs = new MemFs(
      new Map([
        ["/sources/.hidden.json", JSON.stringify(STRUCTURED)],
        ["/sources/README.md", "not json"],
      ]),
    );
    fs.list = [
      { name: ".hidden.json", isFile: () => true },
      { name: "README.md", isFile: () => true },
    ];
    const report = await loadSources("/sources", fs);
    assert.equal(report.sources.length, 0);
  });

  it("captures validation failures without throwing", async () => {
    const fs = new MemFs(
      new Map([
        ["/sources/good.json", JSON.stringify(STRUCTURED)],
        ["/sources/bad.json", JSON.stringify({ kind: "structured", source_type: "unknown_type" })],
      ]),
    );
    fs.list = [
      { name: "good.json", isFile: () => true },
      { name: "bad.json", isFile: () => true },
    ];
    const report = await loadSources("/sources", fs);
    assert.equal(report.sources.length, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]!.file, "bad.json");
    assert.equal(report.failures[0]!.reason, "validation_failed");
  });

  it("captures JSON parse failures", async () => {
    const fs = new MemFs(new Map([["/sources/broken.json", "{not_json"]]));
    fs.list = [{ name: "broken.json", isFile: () => true }];
    const report = await loadSources("/sources", fs);
    assert.equal(report.sources.length, 0);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]!.reason, "parse_failed");
  });
});
