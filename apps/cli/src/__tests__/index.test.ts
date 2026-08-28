/**
 * Minimal tests for the CLI arg parser (PR 4 Slice 2 backfill
 * subcommand + duration parsing).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseArgs, parseDuration } from "../index.js";

describe("parseDuration", () => {
  it("parses single-unit durations", () => {
    assert.equal(parseDuration("5y")?.ms, 5 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(parseDuration("180d")?.ms, 180 * 24 * 60 * 60 * 1000);
    assert.equal(parseDuration("24m")?.ms, 24 * 30 * 24 * 60 * 60 * 1000);
    assert.equal(parseDuration("48h")?.ms, 48 * 60 * 60 * 1000);
    assert.equal(parseDuration("90s")?.ms, 90 * 1000);
  });

  it("parses compound durations", () => {
    const d = parseDuration("1y6m");
    assert.ok(d);
    assert.equal(
      d.ms,
      365 * 24 * 60 * 60 * 1000 + 6 * 30 * 24 * 60 * 60 * 1000,
    );
  });

  it("rejects garbage", () => {
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration("abc"), null);
    assert.equal(parseDuration("5x"), null);
    assert.equal(parseDuration("y5"), null);
  });
});

describe("parseArgs", () => {
  it("defaults to incremental mode with default dirs", () => {
    const args = parseArgs([]);
    assert.equal(args.command, "incremental");
    assert.equal(args.sources, "./sources");
    assert.equal(args.state, "./.outpost/state");
    assert.equal(args.help, false);
    assert.equal(args.force, false);
  });

  it("recognizes the backfill subcommand and its flags", () => {
    const args = parseArgs([
      "backfill",
      "--source",
      "registry.npmjs.org/express",
      "--sources",
      "/tmp/src",
      "--state",
      "/tmp/st",
      "--max-age",
      "5y",
      "--recent-window",
      "18m",
      "--max-artifacts",
      "35",
      "--force",
    ]);
    assert.equal(args.command, "backfill");
    assert.equal(args.backfillSource, "registry.npmjs.org/express");
    assert.equal(args.sources, "/tmp/src");
    assert.equal(args.state, "/tmp/st");
    assert.equal(args.maxAge?.ms, 5 * 365 * 24 * 60 * 60 * 1000);
    assert.equal(args.recentWindow?.ms, 18 * 30 * 24 * 60 * 60 * 1000);
    assert.equal(args.maxArtifacts, 35);
    assert.equal(args.force, true);
  });

  it("does not treat --source as backfill source in incremental mode", () => {
    // --source is only meaningful for backfill; in incremental mode
    // the flag still parses (the orchestrator ignores it), which we
    // assert here so a rename doesn't silently change semantics.
    const args = parseArgs(["--source", "x"]);
    assert.equal(args.backfillSource, "x");
    assert.equal(args.command, "incremental");
  });

  it("throws on invalid durations and artifact counts", () => {
    assert.throws(() => parseArgs(["backfill", "--max-age", "5parsecs"]), /invalid --max-age/);
    assert.throws(
      () => parseArgs(["backfill", "--recent-window", "banana"]),
      /invalid --recent-window/,
    );
    assert.throws(
      () => parseArgs(["backfill", "--max-artifacts", "0"]),
      /invalid --max-artifacts/,
    );
    assert.throws(
      () => parseArgs(["backfill", "--max-artifacts", "3.5"]),
      /invalid --max-artifacts/,
    );
  });

  it("parses -h as help", () => {
    assert.equal(parseArgs(["-h"]).help, true);
  });
});
