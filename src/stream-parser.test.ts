import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStream,
  type StreamToolUse,
} from "./stream-parser.ts";

async function* lines(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}
const J = (o: unknown): string => JSON.stringify(o);

test("parseStream: collects assistant text + tool_use and fires handlers", async () => {
  const deltas: string[] = [];
  const tus: StreamToolUse[] = [];
  const result = await parseStream(
    lines([
      J({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hola " },
            { type: "text", text: "mundo" },
            { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-opus-4-5-20251201",
        },
      }),
      J({ type: "result", stop_reason: "tool_use" }),
    ]),
    { onTextDelta: (d) => deltas.push(d), onToolUse: (t) => tus.push(t) },
  );
  assert.equal(result.text, "Hola mundo");
  assert.equal(result.toolUses.length, 1);
  assert.deepEqual(result.toolUses[0], {
    id: "toolu_1",
    name: "search",
    input: { q: "x" },
  });
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.modelVersion, "claude-opus-4-5-20251201");
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.isError, false);
  assert.deepEqual(deltas, ["Hola ", "mundo"]);
  assert.equal(tus.length, 1);
});

test("parseStream: is_error with no tool_use escalates to isError", async () => {
  const result = await parseStream(
    lines([
      J({ type: "result", stop_reason: "end_turn", is_error: true, errors: ["boom"] }),
    ]),
  );
  assert.equal(result.isError, true);
  assert.equal(result.errorMessage, "boom");
});

test("parseStream: is_error AFTER a tool_use is not escalated (max-turns case)", async () => {
  const result = await parseStream(
    lines([
      J({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_2", name: "do", input: {} }] },
      }),
      J({
        type: "result",
        stop_reason: "tool_use",
        is_error: true,
        errors: ["Reached maximum number of turns (16)"],
      }),
    ]),
  );
  assert.equal(result.toolUses.length, 1);
  assert.equal(result.isError, false);
});

test("parseStream: a user-injection event freezes subsequent assistant text", async () => {
  const result = await parseStream(
    lines([
      J({ type: "assistant", message: { content: [{ type: "text", text: "before" }] } }),
      J({ type: "user" }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "after" }] } }),
      J({ type: "result", stop_reason: "end_turn" }),
    ]),
  );
  assert.equal(result.text, "before");
});

test("parseStream: result usage overrides assistant usage (last write wins)", async () => {
  const result = await parseStream(
    lines([
      J({
        type: "assistant",
        message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 2 } },
      }),
      J({ type: "result", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 200 } }),
    ]),
  );
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 200);
});

test("parseStream: rate_limit_event status is captured", async () => {
  const result = await parseStream(
    lines([
      J({ type: "rate_limit_event", rate_limit_info: { status: "approaching" } }),
      J({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      J({ type: "result", stop_reason: "end_turn" }),
    ]),
  );
  assert.equal(result.rateLimitStatus, "approaching");
});

test("parseStream: blank and malformed lines are skipped", async () => {
  const result = await parseStream(
    lines([
      "",
      "   ",
      "not json {",
      J({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      J({ type: "result", stop_reason: "end_turn" }),
    ]),
  );
  assert.equal(result.text, "hi");
  assert.equal(result.stopReason, "end_turn");
});

test("parseStream: defaults stop_reason to end_turn when none seen", async () => {
  const result = await parseStream(
    lines([
      J({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      J({ type: "result" }),
    ]),
  );
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.isError, false);
});

test("parseStream: cache token counts are captured, not discarded", async () => {
  // The Claude CLI reports a cached prompt as input_tokens≈0 plus the real
  // bulk in cache_read/cache_creation. Dropping those made the bridge report
  // `prompt_tokens: 2` for a 250KB prompt, so OpenClaw's context accounting
  // read ~0 and auto-compaction never fired on long sessions.
  const result = await parseStream(
    lines([
      J({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "x" }],
          usage: {
            input_tokens: 2,
            output_tokens: 745,
            cache_read_input_tokens: 140_000,
            cache_creation_input_tokens: 8_000,
          },
        },
      }),
      J({ type: "result", stop_reason: "end_turn" }),
    ]),
  );
  assert.equal(result.inputTokens, 2);
  assert.equal(result.outputTokens, 745);
  assert.equal(result.cacheReadTokens, 140_000);
  assert.equal(result.cacheCreationTokens, 8_000);
});

test("parseStream: result-event cache usage overrides assistant cache usage", async () => {
  const result = await parseStream(
    lines([
      J({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 5 },
        },
      }),
      J({
        type: "result",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 400,
        },
      }),
    ]),
  );
  assert.equal(result.cacheReadTokens, 300);
  assert.equal(result.cacheCreationTokens, 400);
});

test("parseStream: cache token counts default to 0 when the CLI omits them", async () => {
  const result = await parseStream(
    lines([
      J({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
      J({ type: "result", stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 8 } }),
    ]),
  );
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheCreationTokens, 0);
});
