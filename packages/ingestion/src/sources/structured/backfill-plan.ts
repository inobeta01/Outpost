/**
 * Backfill plan computation — the three-rule emission model in one
 * pure function, shared by every structured adapter that supports
 * backfill (npm, pypi, github_releases).
 *
 * The rules (per the backfill slice plan, vault: "Backfill Slice —
 * Structured Lane Plan"):
 *
 *   1. `max_age`        — versions older than `(latest.publishedAt
 *                          − maxAge)` are excluded entirely.
 *   2. `recent_window`  — versions newer than `(latest.publishedAt
 *                          − recentWindow)` always emit consecutive
 *                          pairs (`backfill_pair`, high confidence).
 *   3. `max_artifacts`  — hard cap. When the consecutive-pair plan
 *                          would emit more than `maxArtifacts`, the
 *                          older versions are collapsed into range
 *                          hops (`backfill_hop`, low confidence) to
 *                          fit, oldest ranges collapsed first. The
 *                          recent window keeps its full granularity
 *                          until the cap is otherwise exceeded.
 *
 * This module is a pure function — no IO, no logging, no error
 * throwing. The three adapters call it once with their already-
 * sorted `VersionObservation[]` and get back the plan. Tests live
 * in `__tests__/structured/backfill-plan.test.ts`.
 */

import type { VersionObservation } from "./types.js";

/** A single plan event — one artifact to emit. */
export interface BackfillPlanEvent {
  readonly type: "backfill_pair" | "backfill_hop";
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Number of intermediate versions collapsed into this hop. `undefined` for pairs. */
  readonly versionCount?: number;
}

/**
 * Default time windows. All overridable per call; we keep the math
 * here so the defaults are in one place and easy to tune.
 *
 *   - 5y     — outer age cap (ADR §1 mentions 5y for "history")
 *   - 18m    — recent window for full-granularity emission
 *   - 35     — hard cap on total artifacts emitted per source
 */
export const DEFAULT_MAX_AGE_MS = 5 * 365 * 24 * 60 * 60 * 1000;
export const DEFAULT_RECENT_WINDOW_MS = (18 * 30 * 24 * 60 * 60 * 1000) / 1; // ~18 months
export const DEFAULT_MAX_ARTIFACTS = 35;

export interface BackfillPlanOptions {
  /** Wall-clock anchor for window math. ISO-8601. */
  readonly now: Date;
  /** Maximum age of any version we consider. Default: 5y. */
  readonly maxAgeMs?: number;
  /** Window inside which we emit consecutive pairs at full granularity. Default: 18m. */
  readonly recentWindowMs?: number;
  /** Hard cap on total plan events. Default: 35. */
  readonly maxArtifacts?: number;
}

export interface BackfillPlan {
  readonly events: ReadonlyArray<BackfillPlanEvent>;
  /** Observations that survived `max_age` but were excluded by budget. Diagnostics. */
  readonly droppedObservations: ReadonlyArray<VersionObservation>;
}

/**
 * Compute the emission plan for a source's history.
 *
 * Inputs MUST be sorted ascending by `publishedAt` (or by the
 * adapter's chosen order when `publishedAt` is null — e.g. npm
 * falls back to insertion order from `versions` keys; the adapter
 * is responsible for that ordering, not us).
 *
 * If `observations` is empty, returns `{ events: [], droppedObservations: [] }`.
 * If only one version exists, no events are emitted (nothing to diff against).
 */
export function computeBackfillPlan(
  observations: ReadonlyArray<VersionObservation>,
  opts: BackfillPlanOptions,
): BackfillPlan {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const recentWindowMs = opts.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const maxArtifacts = opts.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;

  // Rule 1: drop versions older than max_age. We use the latest
  // observation's `publishedAt` as the reference point; if the
  // latest itself has no `publishedAt`, we keep everything and let
  // the caller handle the time semantics.
  if (observations.length === 0) {
    return { events: [], droppedObservations: [] };
  }
  const latest = observations[observations.length - 1]!;
  const referenceMs = latest.publishedAt
    ? Date.parse(latest.publishedAt)
    : opts.now.getTime();
  const cutoffMs = referenceMs - maxAgeMs;
  const recentCutoffMs = referenceMs - recentWindowMs;

  const inWindow: VersionObservation[] = [];
  const dropped: VersionObservation[] = [];
  for (const obs of observations) {
    const ts = obs.publishedAt ? Date.parse(obs.publishedAt) : null;
    if (ts === null || ts >= cutoffMs) {
      inWindow.push(obs);
    } else {
      dropped.push(obs);
    }
  }

  if (inWindow.length < 2) {
    // Need at least two versions to form a pair.
    return { events: [], droppedObservations: dropped };
  }

  // Rule 2: every in-window observation emits a consecutive pair
  // against the one that preceded it. That covers the user's stated
  // requirement: "we need to have diff between every 2 consecutive
  // versions, for clients who have older versions." Older versions
  // also get paired — collapse only happens later if the budget is
  // exceeded.
  const allPairs: BackfillPlanEvent[] = [];
  for (let i = 1; i < inWindow.length; i++) {
    allPairs.push({
      type: "backfill_pair",
      fromVersion: inWindow[i - 1]!.version,
      toVersion: inWindow[i]!.version,
    });
  }

  // We still track `recentStart` for the budget-collapse heuristic:
  // when we're forced to collapse (Rule 3), we want to preserve the
  // recent window at full granularity. Older pairs are the ones that
  // get folded into hops.
  const recentIdx = inWindow.findIndex(
    (o) => o.publishedAt !== null && Date.parse(o.publishedAt) >= recentCutoffMs,
  );
  // findIndex returns -1 if no recent version exists — in that case
  // the whole chain is "older" and we'd collapse from the left end.
  const recentStart = recentIdx === -1 ? 0 : recentIdx;
  // Pairs whose `toVersion` is a recent version. In ascending order,
  // `toVersion === inWindow[i].version` for the pair at index i-1.
  const recentPairCount = Math.max(0, inWindow.length - 1 - (recentStart - 1));

  const tentativeEvents: BackfillPlanEvent[] = [...allPairs];

  // Rule 3: budget enforcement. If tentative events exceed
  // maxArtifacts, collapse the oldest ranges first, preserving the
  // recent window at full granularity.
  if (tentativeEvents.length > maxArtifacts) {
    const excess = tentativeEvents.length - maxArtifacts;
    // We can collapse K excess events by merging K consecutive pairs
    // into one hop each. Each merge removes one event from the list.
    // Limit the merges to the older portion only: a recent pair
    // index `t >= recentStart - 1` (since pair[i] = inWindow[i]→inWindow[i+1]).
    const olderPairEnd = Math.max(0, recentStart - 1);
    const canMerge = Math.max(0, olderPairEnd - 0);
    const mergesToDo = Math.min(excess, canMerge);
    const merged: BackfillPlanEvent[] = [...tentativeEvents];
    let merges = 0;
    let i = 0;
    while (merges < mergesToDo && i < olderPairEnd) {
      const a = merged[i]!;
      const b = merged[i + 1]!;
      const versionCount =
        (a.versionCount ?? 1) + 1 + (b.versionCount ?? 1);
      merged.splice(i, 2, {
        type: "backfill_hop",
        fromVersion: a.fromVersion,
        toVersion: b.toVersion,
        versionCount,
      });
      merges++;
      // Don't advance i — the next pair (now at the same i) might
      // also need merging to fully reduce.
    }
    // If the cap is still exceeded after exhausting older-pair
    // merges (i.e. the recent window alone overflows the budget),
    // fall back to collapsing oldest recent pairs into hops. This
    // is the "max_artifacts is a hard cap" guarantee.
    let postExcess = merged.length - maxArtifacts;
    if (postExcess > 0) {
      let j = 0;
      while (postExcess > 0 && j < merged.length - 1) {
        const a = merged[j]!;
        const b = merged[j + 1]!;
        const versionCount =
          (a.versionCount ?? 1) + 1 + (b.versionCount ?? 1);
        merged.splice(j, 2, {
          type: "backfill_hop",
          fromVersion: a.fromVersion,
          toVersion: b.toVersion,
          versionCount,
        });
        postExcess--;
      }
    }
    return { events: merged, droppedObservations: dropped };
  }

  return { events: tentativeEvents, droppedObservations: dropped };
}
