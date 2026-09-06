/**
 * Tests for the P2 in-memory receiver stub.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Artifact } from "@outpost/shared";

import { InMemoryP2Receiver } from "../../sources/../host/p2-receiver.js";

const SAMPLE: Artifact = {
  source_id: "github.com/x/y",
  source_type: "github_releases",
  unstructured_strategy: null,
  version: "1.2.3",
  content_hash: "abc",
  body: "raw",
  content_type: "text/markdown",
  anchor: null,
  entry_id: null,
  detection_method: "version_bump",
  detected_at: "2026-08-25T12:00:00.000Z",
  fetch_provenance: {
    url: "https://api.github.com/repos/x/y/releases",
    auth: "github_token_env",
    httpStatus: 200,
    fetchedAt: "2026-08-25T12:00:00.000Z",
  },
};

describe("InMemoryP2Receiver", () => {
  it("stores artifacts and assigns sequential ids", async () => {
    const recv = new InMemoryP2Receiver();
    const r1 = await recv.push(SAMPLE);
    const r2 = await recv.push(SAMPLE);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (r1.ok && r2.ok) {
      assert.notEqual(r1.artifactId, r2.artifactId);
    }
    assert.equal(recv.artifacts.length, 2);
  });
});
