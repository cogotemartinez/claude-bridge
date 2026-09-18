/** The subscription quota as the bridge publishes it on `/metrics`.
 *
 *  Two sources feed it: the CLI's `rate_limit_event` (parsed in
 *  stream-parser.ts) and the bridge's own 429 path, taken when the CLI prints
 *  the quota notice instead (error-as-content.ts). Both go through the tracker
 *  below, which is the one place that decides what is fit to publish.
 *
 *  Kept free of runtime imports so the tests can load it under
 *  --experimental-strip-types (same pattern as error-as-content.ts).
 */

/** One reading of the quota. */
export interface RateLimitReading {
  /** Upstream vocabulary: "allowed" | "allowed_warning" | "rejected". */
  status: string;
  /** Epoch ms when the limiting window resets. Absent when unknown. */
  resetsAtMs?: number;
  /** The window that limits, e.g. "five_hour" or "seven_day". Absent when unknown. */
  rateLimitType?: string;
}

/** The reading as `/metrics` serves it. */
export interface PublishedRateLimit extends RateLimitReading {
  updatedAtMs: number;
  ageMs: number;
}

/** Latest plausible reset: the longest window is weekly, plus a day of slack.
 *  Same ceiling the quota-notice parser uses for its dated form. */
export const RESETS_AT_MAX_AHEAD_MS = 8 * 24 * 3600 * 1000;

/** Earliest accepted reset, for clock skew between upstream and this host. A
 *  reset further in the past says nothing about when the quota comes back. */
export const RESETS_AT_MAX_BEHIND_MS = 60 * 1000;

/** `value` when it is an epoch-ms instant in the window a real reset can fall
 *  in, otherwise undefined. The window is what catches a unit mix-up: seconds
 *  read as ms land in 1970, ms read as seconds land tens of thousands of years
 *  out. */
export function plausibleResetsAtMs(value: unknown, nowMs: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < nowMs - RESETS_AT_MAX_BEHIND_MS || value > nowMs + RESETS_AT_MAX_AHEAD_MS) {
    return undefined;
  }
  return value;
}

export interface RateLimitTracker {
  /** Replace the published reading. `undefined` (a turn without a
   *  `rate_limit_event`) is ignored so the last reading stands until something
   *  fresher arrives. A reading is replaced whole, never merged: a reset time
   *  belongs to the window it was read with. */
  record(reading: RateLimitReading | undefined, nowMs?: number): void;
  /** What `/metrics` serves, or null before the first reading. Unknown fields
   *  are left out rather than sent as null, because the dashboard parses
   *  `resetsAtMs` as an optional number and would reject the whole block. */
  snapshot(nowMs?: number): PublishedRateLimit | null;
}

export function createRateLimitTracker(): RateLimitTracker {
  let latest: (RateLimitReading & { updatedAtMs: number }) | null = null;
  return {
    record(reading, nowMs = Date.now()) {
      if (!reading || typeof reading.status !== "string" || reading.status === "") return;
      const resetsAtMs = plausibleResetsAtMs(reading.resetsAtMs, nowMs);
      const { rateLimitType } = reading;
      latest = {
        status: reading.status,
        ...(resetsAtMs !== undefined && { resetsAtMs }),
        ...(typeof rateLimitType === "string" && rateLimitType !== "" && { rateLimitType }),
        updatedAtMs: nowMs,
      };
    },
    snapshot(nowMs = Date.now()) {
      if (!latest) return null;
      return {
        status: latest.status,
        updatedAtMs: latest.updatedAtMs,
        ageMs: nowMs - latest.updatedAtMs,
        ...(latest.resetsAtMs !== undefined && { resetsAtMs: latest.resetsAtMs }),
        ...(latest.rateLimitType !== undefined && { rateLimitType: latest.rateLimitType }),
      };
    },
  };
}
