#!/usr/bin/env node
/**
 * @outpost/cli
 *
 * Operator CLI. Two subcommands:
 *
 *   outpost (default)        — run the incremental host loop once.
 *   outpost backfill --source <id>
 *                            — run a one-time backfill for the
 *                              named source (or every loaded
 *                              structured source if --source is
 *                              omitted). PR 4 Slice 2.
 *
 * Both modes print a JSON RunReport to stdout. Exit codes:
 *
 *   0 — success (every source either succeeded or was skipped)
 *   1 — at least one source failed or was skipped-with-failure
 *   2 — host loop threw (config error, fs failure, etc.)
 *
 * Future commands will live alongside the flag set: `outpost
 * inspect`, `outpost validate-configs`, etc. The CLI is
 * intentionally thin — every interesting bit lives in
 * `@outpost/ingestion`.
 *
 * Sandbox note: per the project's PR3 scope, the host loop runs
 * inside this process — there is no microVM. When a sandbox lands,
 * the host loop's `deps` will change (curl-based outbound + env
 * allowlist), but the orchestrator + per-source state persist
 * unchanged.
 */

import { pathToFileURL } from "node:url";

import { runIngestion } from "@outpost/ingestion";
import type { ScrapeClient } from "@outpost/ingestion";

const HELP = `outpost — operator CLI

Usage:
  outpost [--sources <dir>] [--state <dir>]
  outpost backfill [--source <id>] [--sources <dir>] [--state <dir>]
                   [--max-age <duration>] [--recent-window <duration>]
                   [--max-artifacts <n>] [--force]

Runs the host loop once and prints a JSON RunReport.
Default --sources: ./sources
Default --state:   ./.outpost/state

Incremental mode (default):
  --sources <dir>   Directory of source spec JSON files
  --state <dir>     Directory for per-source state JSON
  --help, -h        Show this help

Backfill mode (one-time onboarding):
  --source <id>     Run backfill only for this source id (optional;
                    defaults to all loaded structured sources)
  --max-age <dur>   Outer age cap. Default 5y. Examples: 5y, 180d, 24m.
  --recent-window <dur>
                    Window for full consecutive-pair emission.
                    Default 18m.
  --max-artifacts <n>
                    Hard cap on artifacts emitted per source.
                    Default 35.
  --force           Re-run backfill even when \`backfillStatus\`
                    is already "complete".
`;

interface ParsedDuration {
  readonly ms: number;
}

interface Args {
  sources: string;
  state: string;
  help: boolean;
  command: "incremental" | "backfill";
  backfillSource?: string;
  maxAge?: ParsedDuration;
  recentWindow?: ParsedDuration;
  maxArtifacts?: number;
  force: boolean;
}

/**
 * Parse a duration string like "5y", "180d", "24m", "30s" into ms.
 * Supports compound suffixes: "1y6m" works. Returns null on garbage.
 */
export function parseDuration(s: string): ParsedDuration | null {
  const re = /(\d+)(y|m|d|h|s)/g;
  let totalMs = 0;
  let lastIndex = 0;
  let matched = false;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    matched = true;
    lastIndex = re.lastIndex;
    const n = Number(m[1]);
    const unit = m[2];
    const ms =
      unit === "y" ? n * 365 * 24 * 60 * 60 * 1000 :
      unit === "m" ? n * 30 * 24 * 60 * 60 * 1000 :
      unit === "d" ? n * 24 * 60 * 60 * 1000 :
      unit === "h" ? n * 60 * 60 * 1000 :
      unit === "s" ? n * 1000 :
      0;
    totalMs += ms;
  }
  if (!matched || lastIndex !== s.length) return null;
  return { ms: totalMs };
}

export function parseArgs(argv: ReadonlyArray<string>): Args {
  const out: Args = {
    sources: "./sources",
    state: "./.outpost/state",
    help: false,
    command: "incremental",
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "backfill") out.command = "backfill";
    else if (arg === "--sources") {
      i++;
      if (i < argv.length) out.sources = argv[i]!;
    } else if (arg === "--state") {
      i++;
      if (i < argv.length) out.state = argv[i]!;
    } else if (arg === "--source") {
      i++;
      if (i < argv.length) out.backfillSource = argv[i]!;
    } else if (arg === "--max-age") {
      i++;
      if (i < argv.length) {
        const d = parseDuration(argv[i]!);
        if (!d) throw new Error(`invalid --max-age duration: ${argv[i]}`);
        out.maxAge = d;
      }
    } else if (arg === "--recent-window") {
      i++;
      if (i < argv.length) {
        const d = parseDuration(argv[i]!);
        if (!d) throw new Error(`invalid --recent-window duration: ${argv[i]}`);
        out.recentWindow = d;
      }
    } else if (arg === "--max-artifacts") {
      i++;
      if (i < argv.length) {
        const n = Number(argv[i]);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`invalid --max-artifacts value: ${argv[i]}`);
        }
        out.maxArtifacts = n;
      }
    } else if (arg === "--force") {
      out.force = true;
    }
  }
  return out;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    process.stderr.write(
      `outpost: arg parse error: ${cause instanceof Error ? cause.message : String(cause)}\n\n${HELP}`,
    );
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // v1 uses Node's global fetch. A future dep (undici / got) lands
  // here if globalThis.fetch turns out to be insufficient (timeouts,
  // proxy config, retries).
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const r = await globalThis.fetch(url, init as RequestInit);
    return {
      ok: r.ok,
      status: r.status,
      text: () => r.text(),
    };
  };

  // The CLI doesn't ship its own Firecrawl client — operators
  // wire a real one when running against a vendor corpus, and
  // tests wire a stub. The dummy impl below forces users to make
  // an explicit choice rather than silently failing on every
  // unstructured source.
  const scrapeImpl: ScrapeClient = {
    scrape: () => {
      throw new Error(
        "Firecrawl scrape client not wired in CLI v1 — supply a real client " +
          "(or use the test harness for fixture-driven runs).",
      );
    },
  };

  const now = new Date().toISOString();
  try {
    const backfillOpts =
      args.command === "backfill"
        ? {
            ...(args.maxAge ? { maxAgeMs: args.maxAge.ms } : {}),
            ...(args.recentWindow ? { recentWindowMs: args.recentWindow.ms } : {}),
            ...(args.maxArtifacts !== undefined ? { maxArtifacts: args.maxArtifacts } : {}),
          }
        : undefined;
    const report = await runIngestion({
      sourcesDir: args.sources,
      stateDir: args.state,
      now,
      mode: args.command,
      ...(args.command === "backfill" && args.backfillSource !== undefined
        ? { backfillSourceId: args.backfillSource }
        : {}),
      ...(backfillOpts !== undefined ? { backfillOptions: backfillOpts } : {}),
      ...(args.command === "backfill" ? { backfillForce: args.force } : {}),
      deps: { fetch: fetchImpl, readEnv: (n: string) => process.env[n], scrape: scrapeImpl },
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.summary.failed + report.summary.loadFailed > 0 ? 1 : 0;
  } catch (cause) {
    process.stderr.write(
      `outpost: host loop threw: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 2;
  }
}

// Run only when executed directly (not when imported by tests).
const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`outpost: unexpected: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
