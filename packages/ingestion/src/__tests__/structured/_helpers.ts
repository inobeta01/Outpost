/**
 * Shared test helpers for the structured adapter test suite.
 *
 * No live network. Every test stubs the `fetch` dependency with a
 * function that returns a fixture loaded from `__fixtures__/`. This
 * keeps the suite hermetic and lets us exercise 4xx/5xx/parse-error
 * paths without mocking frameworks.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FetchLike, ReadEnvLike } from "../../sources/structured/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, "..", "..", "__tests__", "structured", "__fixtures__");

export async function loadFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), "utf8");
}

/**
 * Stub a fetch that returns a fixed body + status. Tracks call count
 * so tests can assert the adapter only made the expected number of
 * requests.
 */
export function stubFetch(
  body: string,
  status = 200,
  ok = status >= 200 && status < 300,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok,
      status,
      text: () => Promise.resolve(body),
    });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Stub a fetch that always errors with a given status + body. */
export function stubFetchError(
  status: number,
  body = "error",
): FetchLike & { calls: string[] } {
  return stubFetch(body, status, false);
}

/** A no-env readEnv; tests that don't need auth use this. */
export const noEnv: ReadEnvLike = () => undefined;

/** A readEnv that returns a fixed token. */
export function envWith(token: string | undefined): ReadEnvLike {
  return (name: string) => {
    if (token !== undefined && name === "GITHUB_TOKEN") return token;
    return undefined;
  };
}

export const NOW = "2026-08-24T12:00:00.000Z";
