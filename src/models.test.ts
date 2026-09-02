import assert from "node:assert/strict";
import { test } from "node:test";
import { listModels, resolveModel } from "./models.ts";

test("the declared ids are the models the CLI actually runs", () => {
  // Verified 2026-09-02 with `claude -p ... --model <alias> --output-format json`:
  // the CLI's family aliases resolve to the 5 family. The bridge used to advertise
  // "claude-opus-4" while running Opus 5 — the label lied about the model.
  assert.deepEqual(
    listModels().map((m) => [m.id, m.cliAlias]),
    [
      ["claude-opus-5", "opus"],
      ["claude-sonnet-5", "sonnet"],
      ["claude-haiku-4-5", "haiku"],
      ["claude-fable-5-1", "fable"],
    ],
  );
});

test("the old family-4 ids still resolve, so existing config keeps working", () => {
  // openclaw.json and several cron payloads still say claude-opus-4. They must
  // land on the same family's current model instead of falling through to
  // passthrough, which would hand the CLI an alias it does not know.
  for (const [old, want] of [
    ["claude-opus-4", "claude-opus-5"],
    ["claude-sonnet-4", "claude-sonnet-5"],
    ["claude-haiku-4", "claude-haiku-4-5"],
  ] as const) {
    const m = resolveModel(old);
    assert.equal(m.id, want, `${old} should resolve to ${want}`);
    assert.notEqual(m.cliAlias, old, `${old} must not be passed to the CLI verbatim`);
  }
});

test("short aliases resolve, unknown ids pass through untouched", () => {
  assert.equal(resolveModel("opus").id, "claude-opus-5");
  assert.equal(resolveModel("fable").id, "claude-fable-5-1");
  const unknown = resolveModel("claude-some-future-model");
  assert.equal(unknown.id, "claude-some-future-model");
  assert.equal(unknown.cliAlias, "claude-some-future-model");
});
