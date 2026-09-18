import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimitTracker,
  plausibleResetsAtMs,
  RESETS_AT_MAX_AHEAD_MS,
} from "./rate-limit-state.ts";
import { CLI_ERROR_AS_CONTENT_PREFIX, quotaAwareErrorStatus } from "./error-as-content.ts";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0); // 2026-09-14T12:00:00Z
const IN_SEVEN_HOURS = NOW + 7 * 3600 * 1000;

test("tracker publishes the status, the reset and the window type", () => {
  const t = createRateLimitTracker();
  t.record({ status: "rejected", resetsAtMs: IN_SEVEN_HOURS, rateLimitType: "seven_day" }, NOW);
  assert.deepEqual(t.snapshot(NOW + 1000), {
    status: "rejected",
    updatedAtMs: NOW,
    ageMs: 1000,
    resetsAtMs: IN_SEVEN_HOURS,
    rateLimitType: "seven_day",
  });
});

test("tracker leaves unknown fields out instead of sending null", () => {
  // The dashboard parses `resetsAtMs` as an optional number: a null there
  // fails the whole block and the pill reads "no data" instead of the status.
  const t = createRateLimitTracker();
  t.record({ status: "allowed" }, NOW);
  const snap = t.snapshot(NOW);
  assert.ok(snap);
  assert.equal("resetsAtMs" in snap, false);
  assert.equal("rateLimitType" in snap, false);
  assert.equal(JSON.stringify(snap).includes("null"), false);
});

test("an implausible reset is dropped, the status still published", () => {
  const absurd: Array<[string, number]> = [
    ["seconds never converted (lands in 1970)", 1789412400],
    ["milliseconds converted again (year ~58000)", 1789412400000 * 1000],
    ["already past", NOW - 3600 * 1000],
    ["beyond the weekly window", NOW + RESETS_AT_MAX_AHEAD_MS + 1],
    ["not finite", Number.POSITIVE_INFINITY],
    ["not a number", Number.NaN],
  ];
  for (const [label, resetsAtMs] of absurd) {
    const t = createRateLimitTracker();
    t.record({ status: "rejected", resetsAtMs, rateLimitType: "five_hour" }, NOW);
    const snap = t.snapshot(NOW);
    assert.equal(snap?.status, "rejected", label);
    assert.equal(snap !== null && "resetsAtMs" in snap, false, label);
    assert.equal(snap?.rateLimitType, "five_hour", label);
  }
});

test("plausibleResetsAtMs accepts both ends of the real windows", () => {
  assert.equal(plausibleResetsAtMs(NOW + 5 * 3600 * 1000, NOW), NOW + 5 * 3600 * 1000);
  assert.equal(plausibleResetsAtMs(NOW + 7 * 24 * 3600 * 1000, NOW), NOW + 7 * 24 * 3600 * 1000);
  // A few seconds of clock skew is not a reason to drop the value.
  assert.equal(plausibleResetsAtMs(NOW - 5000, NOW), NOW - 5000);
  assert.equal(plausibleResetsAtMs(undefined, NOW), undefined);
  assert.equal(plausibleResetsAtMs(null, NOW), undefined);
});

test("a turn without a reading keeps the last one; a new reading replaces it whole", () => {
  const t = createRateLimitTracker();
  t.record({ status: "allowed_warning", resetsAtMs: IN_SEVEN_HOURS, rateLimitType: "five_hour" }, NOW);
  t.record(undefined, NOW + 60_000);
  assert.equal(t.snapshot(NOW + 60_000)?.updatedAtMs, NOW);
  // A reset time belongs to the window it was read with: never merged across.
  t.record({ status: "rejected" }, NOW + 120_000);
  assert.deepEqual(t.snapshot(NOW + 120_000), {
    status: "rejected",
    updatedAtMs: NOW + 120_000,
    ageMs: 0,
  });
});

// ── The exhausted-quota path ────────────────────────────────────────────────
// Once the quota is gone the CLI sends no rate_limit_event, only the notice.
// The 429 mapping is then the only fresh evidence, and it has to reach the
// published state with the same reset instant that feeds Retry-After.

test("exhausted quota: the 429 leaves the published state rejected, with its reset", () => {
  const now = new Date(2026, 8, 14, 7, 25, 0); // local time, like the notice
  const t = createRateLimitTracker();
  t.record({ status: "allowed_warning", rateLimitType: "five_hour" }, now.getTime() - 3600_000);

  const mapped = quotaAwareErrorStatus(
    `${CLI_ERROR_AS_CONTENT_PREFIX}You've hit your limit · resets 8:10am`,
    false,
    now,
  );
  assert.equal(mapped.status, 429);
  t.record(mapped.rateLimit, now.getTime());

  const expected = new Date(2026, 8, 14, 8, 10, 0).getTime();
  const snap = t.snapshot(now.getTime());
  assert.equal(snap?.status, "rejected");
  assert.equal(snap?.resetsAtMs, expected);
  assert.equal(snap?.updatedAtMs, now.getTime());
  // Same instant as the header: they are derived from one parse.
  assert.equal(now.getTime() + Number(mapped.headers?.["Retry-After"]) * 1000, expected);
  // The notice does not name the window in upstream's vocabulary.
  assert.equal(snap !== null && "rateLimitType" in snap, false);
});

test("exhausted quota with an unreadable reset: rejected, and no invented time", () => {
  const t = createRateLimitTracker();
  const mapped = quotaAwareErrorStatus(`${CLI_ERROR_AS_CONTENT_PREFIX}You've hit your limit · resets soon`, false);
  t.record(mapped.rateLimit, NOW);
  assert.deepEqual(t.snapshot(NOW), { status: "rejected", updatedAtMs: NOW, ageMs: 0 });
});

test("any other failure publishes nothing", () => {
  for (const [message, isTimeout] of [
    [`${CLI_ERROR_AS_CONTENT_PREFIX}API Error: 500 boom`, false],
    ["CLI error: exit 1", false],
    ["CLI timeout after 600000ms", true],
  ] as const) {
    assert.equal(quotaAwareErrorStatus(message, isTimeout).rateLimit, undefined, message);
  }
});
