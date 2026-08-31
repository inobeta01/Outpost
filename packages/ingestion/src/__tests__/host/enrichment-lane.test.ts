/**
 * Tests for the enrichment lane (version-join host execution).
 *
 * Covers:
 *   - Source without an enrichment block: skipped.
 *   - Source with empty state: looks up the lastSeenVersion
 *     (which is null on first run), produces no artifacts,
 *     skipped.
 *   - Brand-new version: looks it up, pushes the enrichment
 *     artifact, updates the per-version state.
 *   - Re-fetch of last K versions: detects hash change, emits
 *     entry_update artifact.
 *   - 404 (not_found): silent skip, no artifact, no telemetry.
 *   - Transient failure: version added to pendingEnrichments,
 *     retried on next poll.
 *   - Successful retry clears pendingEnrichments.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { EnrichmentConfig, StructuredSource } from "@outpost/shared";

import { runEnrichment } from "../../host/enrichment-lane.js";
import { InMemoryP2Receiver } from "../../host/p2-receiver.js";
import {
  initialState,
  loadOrInit,
  StateStore,
  type FsLike,
} from "../../host/state-store.js";
import { noEnv, stubFetch } from "../structured/_helpers.js";

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

const SOURCE: StructuredSource = {
  id: "pypi/requests",
  kind: "structured",
  owner: "@vendor-bot",
  source_type: "pypi",
  fetch: { auth: "none" },
  endpoints: {
    package: {
      url: "https://pypi.org/pypi/{package}/json",
      kind: "object",
      variables: { package: "requests" },
    },
  },
  security: { allowed_domains: ["pypi.org", "example.com"] },
  firecrawl: false,
  enrichment: {
    strategy: "rss",
    endpoint_url: "https://example.com/feed.xml",
    strategy_config: { rss_url: "https://example.com/feed.xml" },
    anchor_source: "feed_field",
  },
};

function buildFeedXml(items: ReadonlyArray<{ guid: string; title: string; link: string }>): string {
  return [
    '<rss version="2.0">',
    "  <channel>",
    "    <title>Releases</title>",
    ...items.flatMap((i) => [
      "    <item>",
      `      <title>${i.title}</title>`,
      `      <link>${i.link}</link>`,
      `      <guid>${i.guid}</guid>`,
      "    </item>",
    ]),
    "  </channel>",
    "</rss>",
  ].join("\n");
}

describe("enrichment lane (version-join host execution)", () => {
  it("skips sources without an enrichment block", async () => {
    const source: StructuredSource = { ...SOURCE };
    // Strip the enrichment block.
    const noEnrich: StructuredSource = JSON.parse(JSON.stringify(source));
    delete (noEnrich as { enrichment?: unknown }).enrichment;

    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    const result = await runEnrichment({
      source: noEnrich,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: stubFetch(""), readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.versionsLookedUp, 0);
  });

  it("looks up the lastSeenVersion and pushes an enrichment artifact", async () => {
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    // Seed state with a structured lastSeenVersion.
    const initial = initialState(SOURCE.id, "structured", "2026-08-25T11:00:00.000Z");
    if (initial.kind !== "structured") throw new Error("kind mismatch");
    await state.write({
      ...initial,
      lastSeenVersion: "2.32.3",
      lastSeenHash: "abc",
      pollCount: 1,
    });

    const feedXml = buildFeedXml([
      { guid: "2.32.3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
    ]);
    const result = await runEnrichment({
      source: SOURCE,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: stubFetch(feedXml), readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.status, "success");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.versionsLookedUp, 1);
    assert.equal(result.versionsNotFound, 0);
    assert.equal(p2.artifacts.length, 1);
    const pushed = p2.artifacts[0]!;
    assert.equal(pushed.source_id, "pypi/requests");
    assert.equal(pushed.version, "2.32.3");
    assert.equal(pushed.fetch_mode, "incremental");
    assert.equal(pushed.unstructured_strategy, "rss");
  });

  it("does not push an artifact when lastSeenVersion is null (no version yet)", async () => {
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    // First poll: no structured detection has happened yet.
    const initial = initialState(SOURCE.id, "structured", "2026-08-25T11:00:00.000Z");
    await state.write(initial);

    const result = await runEnrichment({
      source: SOURCE,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: stubFetch(""), readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.versionsLookedUp, 0);
  });

  it("returns not_found (silent skip) when no entry matches the version", async () => {
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    const initial = initialState(SOURCE.id, "structured", "2026-08-25T11:00:00.000Z");
    if (initial.kind !== "structured") throw new Error("kind mismatch");
    await state.write({
      ...initial,
      lastSeenVersion: "1.0.0",
      pollCount: 1,
    });

    const feedXml = buildFeedXml([
      { guid: "2.32.3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
    ]);
    const result = await runEnrichment({
      source: SOURCE,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: stubFetch(feedXml), readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.versionsNotFound, 1);
    assert.equal(result.artifacts.length, 0);
    assert.equal(p2.artifacts.length, 0);
  });

  it("adds transiently-failed versions to pendingEnrichments", async () => {
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    const initial = initialState(SOURCE.id, "structured", "2026-08-25T11:00:00.000Z");
    if (initial.kind !== "structured") throw new Error("kind mismatch");
    await state.write({
      ...initial,
      lastSeenVersion: "2.32.3",
      pollCount: 1,
    });

    // First poll: fetch throws.
    const throwingFetch = (() => {
      throw new Error("network blip");
    }) as never;

    const result = await runEnrichment({
      source: SOURCE,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: throwingFetch, readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.versionsPending, 1);
    assert.equal(result.artifacts.length, 0);

    // The state should now have the version in pendingEnrichments.
    const next = await loadOrInit(state, SOURCE.id, "structured", "2026-08-25T12:00:00.000Z");
    if (next.kind !== "structured") throw new Error("kind mismatch");
    assert.ok(next.pendingEnrichments.includes("2.32.3"));
  });

  it("clears pendingEnrichments on successful retry", async () => {
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    // Seed state with a pending enrichment from a previous failed run.
    const initial = initialState(SOURCE.id, "structured", "2026-08-25T11:00:00.000Z");
    if (initial.kind !== "structured") throw new Error("kind mismatch");
    await state.write({
      ...initial,
      lastSeenVersion: "2.32.3",
      pollCount: 1,
      pendingEnrichments: ["2.32.3"],
    });

    const feedXml = buildFeedXml([
      { guid: "2.32.3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
    ]);
    const result = await runEnrichment({
      source: SOURCE,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: stubFetch(feedXml), readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.status, "success");
    assert.equal(result.versionsPending, 0);
    assert.equal(result.artifacts.length, 1);

    const next = await loadOrInit(state, SOURCE.id, "structured", "2026-08-25T12:00:00.000Z");
    if (next.kind !== "structured") throw new Error("kind mismatch");
    assert.deepEqual(next.pendingEnrichments, []);
    assert.equal(next.enrichments.length, 1);
    assert.equal(next.enrichments[0]?.version, "2.32.3");
  });

  it("detects a hash change in a re-fetched version and emits entry_update", async () => {
    const fs = new MemFs();
    const state = new StateStore({ baseDir: "/state", fs });
    const p2 = new InMemoryP2Receiver();
    // Seed state with a previously-seen enrichment whose hash was "old-hash".
    const initial = initialState(SOURCE.id, "structured", "2026-08-25T11:00:00.000Z");
    if (initial.kind !== "structured") throw new Error("kind mismatch");
    await state.write({
      ...initial,
      lastSeenVersion: "2.32.3",
      pollCount: 1,
      enrichments: [
        {
          version: "2.32.3",
          contentHash: "old-hash-that-will-not-match",
          lastSeenAt: "2026-08-25T11:00:00.000Z",
        },
      ],
    });

    const feedXml = buildFeedXml([
      { guid: "2.32.3", title: "Release 2.32.3", link: "https://example.com/posts/2-32-3" },
    ]);
    const result = await runEnrichment({
      source: SOURCE,
      now: "2026-08-25T12:00:00.000Z",
      deps: { fetch: stubFetch(feedXml), readEnv: noEnv, scrape: {} as never },
      state,
      p2,
    });
    assert.equal(result.status, "success");
    assert.equal(result.artifacts.length, 1);
    assert.equal(p2.artifacts[0]?.detection_method, "entry_update");
  });
});
