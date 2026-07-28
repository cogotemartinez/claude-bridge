import { test } from "node:test";
import assert from "node:assert";
import {
  couldBeErrorAsContent,
  isErrorAsContent,
} from "./error-as-content.ts";

const REAL_ERROR =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CbujMNeskwtUgPrUt3i9a"}';

test("matches the production out-of-extra-usage error verbatim", () => {
  assert.equal(isErrorAsContent(REAL_ERROR), true);
});

test("matches other status codes and leading whitespace", () => {
  assert.equal(isErrorAsContent("API Error: 429 {}"), true);
  assert.equal(isErrorAsContent("  API Error: 529 overloaded"), true);
});

test("does not match normal replies", () => {
  assert.equal(isErrorAsContent("Hola jefe, ¿qué hacés?"), false);
  assert.equal(isErrorAsContent(""), false);
});

test("does not match replies that merely mention API errors", () => {
  assert.equal(
    isErrorAsContent("Che, ayer vi un API Error: 400 en los logs de jarvis"),
    false,
  );
  assert.equal(isErrorAsContent("API Error: sin código no cuenta"), false);
});

test("couldBeErrorAsContent buffers plausible prefixes only", () => {
  // Prefixes of the error line keep buffering...
  assert.equal(couldBeErrorAsContent("API"), true);
  assert.equal(couldBeErrorAsContent("API Error: 4"), true);
  // ...but ordinary openers flush immediately.
  assert.equal(couldBeErrorAsContent("Hola"), false);
  assert.equal(couldBeErrorAsContent("Dale,"), false);
  // Long-enough accumulations resolve to the strict check.
  assert.equal(couldBeErrorAsContent(REAL_ERROR), true);
  assert.equal(
    couldBeErrorAsContent("API Error happened yesterday, te cuento"),
    false,
  );
});

test("couldBeErrorAsContent keeps buffering non-4xx status prefixes (streaming gate)", () => {
  // Regression: the gate used to hardcode "API Error: 400" as its probe, so a
  // 5xx/529 error arriving char-by-char (the retryable overload/upstream
  // class) flushed as a real delta before the 3rd status digit arrived,
  // leaking the error as chat content and disabling retry.
  for (const prefix of ["API Error: 5", "API Error: 52", "API Error: 529"]) {
    assert.equal(couldBeErrorAsContent(prefix), true, prefix);
  }
  assert.equal(couldBeErrorAsContent("API Error: 503"), true);
  assert.equal(couldBeErrorAsContent("API Error: 9"), true);
  // The bare lead (status not yet arrived) must also keep buffering.
  assert.equal(couldBeErrorAsContent("API Error:"), true);
  assert.equal(couldBeErrorAsContent("API Error: "), true);
});

test("couldBeErrorAsContent flushes once it's clearly not an error line", () => {
  // After the lead, a non-digit means it's prose, not a status code.
  assert.equal(couldBeErrorAsContent("API Error: nope"), false);
  // A full 5xx error line resolves to the strict check.
  assert.equal(
    couldBeErrorAsContent('API Error: 529 {"type":"overloaded_error"}'),
    true,
  );
});

// --- Quota-exhaustion notices (added 2026-07-28) ---------------------------
// The Max/OAuth CLI prints these instead of an `API Error:` line and exits
// zero, so they used to be returned as a normal completion with HTTP 200.
// Measured on the openclaw fleet: 447 cron runs recorded status=ok whose only
// output was one of these, which also kept consecutiveErrors at 0 and
// suppressed every failure alert.

const REAL_QUOTA = "You've hit your limit · resets 8:10am (UTC)";

test("matches the production quota notice verbatim", () => {
  assert.equal(isErrorAsContent(REAL_QUOTA), true);
});

test("matches quota notice variants seen in the run logs", () => {
  assert.equal(
    isErrorAsContent("You've hit your limit · resets 11pm (America/Buenos_Aires)"),
    true,
  );
  assert.equal(isErrorAsContent("  You've hit your limit · resets 4am (UTC)"), true);
  // Typographic apostrophe and the "usage limit" wording.
  assert.equal(isErrorAsContent("You’ve hit your usage limit · resets 9am (UTC)"), true);
});

test("does not match an assistant legitimately talking about limits", () => {
  assert.equal(
    isErrorAsContent("You've hit your limit of 3 retries, so I stopped there."),
    false,
  );
  assert.equal(
    isErrorAsContent("Che, ayer el bridge tiró 'You've hit your limit' en los logs"),
    false,
  );
  // Missing the `· resets` marker: not the CLI line.
  assert.equal(isErrorAsContent("You've hit your limit."), false);
});

test("streaming gate keeps buffering a partial quota line", () => {
  assert.equal(couldBeErrorAsContent("You'"), true);
  assert.equal(couldBeErrorAsContent("You've hit your"), true);
  assert.equal(couldBeErrorAsContent("You’ve hit your li"), true);
  // A normal reply that starts differently must not be held back.
  assert.equal(couldBeErrorAsContent("Hola jefe"), false);
});
