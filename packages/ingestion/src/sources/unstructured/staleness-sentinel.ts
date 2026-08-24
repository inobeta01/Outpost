/**
 * Staleness sentinel (ADR §9.6).
 *
 * Some vendor pages become abandoned while still returning HTTP 200
 * and a static content hash. A provider polling such a page would
 * silently poll forever without reporting changes or errors — a
 * real ops hazard.
 *
 * The sentinel checks the gap between `now` and the last observed
 * content hash change. If the gap exceeds `max_inactivity_days`
 * (default 90), it returns `state: "stale"` with a stable
 * `SOURCE_STALENESS_THRESHOLD_EXCEEDED` telemetry signal that the
 * host loop can emit to operational dashboards.
 *
 * IMPORTANT: this module NEVER halts polling. The staleness check
 * surfaces an alert; it does not fail the run. Vendors with seasonal
 * release cadences may legitimately have long quiet periods, and
 * abruptly stopping polls would mask that pattern.
 */

const DEFAULT_MAX_INACTIVITY_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StalenessCheckInput {
  /** Source ID, for the telemetry signal. */
  readonly sourceId: string;
  /**
   * ISO-8601 timestamp of the last observed content hash change,
   * or `null` if this is the first poll. Sentinel skips a `null`
   * first poll — there's no "inactivity" to measure until the
   * first change is recorded.
   */
  readonly lastContentHashChangeAt: string | null;
  /**
   * Threshold in days. Defaults to 90. Source spec's
   * `staleness_sentinel.max_inactivity_days` overrides this.
   */
  readonly maxInactivityDays?: number;
  /** ISO-8601 timestamp the host loop started this poll. */
  readonly now: string;
}

export type StalenessCheckResult =
  | { readonly state: "active" }
  | {
      readonly state: "stale";
      readonly sourceId: string;
      readonly daysInactive: number;
      readonly thresholdDays: number;
      /** Stable telemetry event name (ADR §9.6). */
      readonly telemetryEvent: "SOURCE_STALENESS_THRESHOLD_EXCEEDED";
    };

/**
 * Run the staleness check. Pure function — no I/O, no logging.
 * The caller is responsible for emitting the telemetry signal
 * when `state === "stale"`.
 */
export function checkStaleness(input: StalenessCheckInput): StalenessCheckResult {
  if (input.lastContentHashChangeAt === null) {
    // First poll — no inactivity to measure.
    return { state: "active" };
  }
  const threshold = input.maxInactivityDays ?? DEFAULT_MAX_INACTIVITY_DAYS;
  const last = Date.parse(input.lastContentHashChangeAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(last) || Number.isNaN(now)) {
    // Bad timestamp on either side — treat as active to avoid
    // spurious alerts from clock skew or malformed input.
    return { state: "active" };
  }
  const daysInactive = (now - last) / MS_PER_DAY;
  if (daysInactive > threshold) {
    return {
      state: "stale",
      sourceId: input.sourceId,
      daysInactive,
      thresholdDays: threshold,
      telemetryEvent: "SOURCE_STALENESS_THRESHOLD_EXCEEDED",
    };
  }
  return { state: "active" };
}
