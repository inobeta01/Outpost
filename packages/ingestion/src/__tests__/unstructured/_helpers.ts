/**
 * Shared test helpers for the extraction-strategy test suite.
 *
 * Mirrors the structured-adapter helpers in style: stub fetch /
 * scrape with recorded bodies, no live network.
 */

import type { FetchLike, ReadEnvLike } from "../../sources/structured/types.js";
import type { ScrapeClient } from "../../sources/unstructured/strategy-registry.js";

// Side-effect import — registering the 5 extraction strategies
// with the strategy registry. Importing _helpers is the canonical
// way the test suite ensures registration; consumers of the
// library should import the unstructured barrel directly.
import "../../sources/unstructured/index.js";

export const NOW = "2026-08-24T12:00:00.000Z";

/** A no-env readEnv. The unstructured lane generally doesn't need env. */
export const noEnv: ReadEnvLike = () => undefined;

/**
 * Stub a fetch that returns a fixed body + status. Tracks call
 * count so we can assert the strategy made the expected number of
 * requests and to the right URLs.
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

/** Map of URL → markdown body for the stub ScrapeClient. */
export type ScrapeFixtureMap = ReadonlyMap<string, string>;

/**
 * Build a `ScrapeClient` whose `scrape()` returns the recorded
 * markdown for the URL it's called with. URLs not in the map
 * throw — tests that expect a missing-URL scrape should use a
 * custom client instead.
 */
export function stubScrapeClient(fixtures: ScrapeFixtureMap): ScrapeClient & {
  calls: string[];
} {
  const calls: string[] = [];
  const client: ScrapeClient & { calls: string[] } = {
    calls,
    scrape(url: string) {
      calls.push(url);
      const body = fixtures.get(url);
      if (body === undefined) {
        return Promise.reject(new Error(`no scrape fixture for ${url}`));
      }
      return Promise.resolve({
        markdown: body,
        html: "",
        metadata: { title: null, sourceURL: url },
      });
    },
  };
  return client;
}
