#!/usr/bin/env node
/**
 * @outpost/cli
 *
 * Operator CLI. v1 ships one command: `outpost --sources <dir>
 * --state <dir>` which runs the full host loop exactly once and
 * prints the resulting RunReport as JSON to stdout.
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

import { runIngestion } from "@outpost/ingestion";
import type { ScrapeClient } from "@outpost/ingestion";

const HELP = `outpost — operator CLI

Usage:
  outpost [--sources <dir>] [--state <dir>]

Runs the host loop once and prints a JSON RunReport.
Default --sources: ./sources
Default --state:   ./.outpost/state

Flags:
  --sources <dir>   Directory of source spec JSON files
  --state <dir>     Directory for per-source state JSON
  --help, -h        Show this help
`;

interface Args {
  sources: string;
  state: string;
  help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const out: Args = { sources: "./sources", state: "./.outpost/state", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--sources") {
      i++;
      if (i < argv.length) out.sources = argv[i]!;
    } else if (arg === "--state") {
      i++;
      if (i < argv.length) out.state = argv[i]!;
    }
  }
  return out;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseArgs(argv);
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
    const report = await runIngestion({
      sourcesDir: args.sources,
      stateDir: args.state,
      now,
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`outpost: unexpected: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
