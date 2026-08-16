import { test } from "node:test";
import assert from "node:assert/strict";
import type { CLIResult } from "./cli-worker.ts";
import {
  buildCompletionResponse,
  buildUsagePayload,
  mapFinishReason,
  sanitizeClientError,
} from "./response-format.ts";

function result(over: Partial<CLIResult>): CLIResult {
  return {
    text: "",
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "end_turn",
    sessionId: "s",
    rateLimitStatus: undefined,
    modelVersion: undefined,
    ...over,
  };
}

test("mapFinishReason: tool calls always win", () => {
  assert.equal(mapFinishReason("end_turn", true), "tool_calls");
  assert.equal(mapFinishReason("tool_use", false), "tool_calls");
});

test("mapFinishReason: max_tokens->length, refusal->content_filter, else stop", () => {
  assert.equal(mapFinishReason("max_tokens", false), "length");
  assert.equal(mapFinishReason("refusal", false), "content_filter");
  assert.equal(mapFinishReason("end_turn", false), "stop");
  assert.equal(mapFinishReason("stop_sequence", false), "stop");
  assert.equal(mapFinishReason(undefined, false), "stop");
});

test("sanitizeClientError: strips stderr tail and CLI-exited body, keeps plain", () => {
  assert.equal(
    sanitizeClientError("CLI error: boom | stderr: /Users/secret/path leaked"),
    "CLI error: boom",
  );
  assert.equal(
    sanitizeClientError("CLI exited 1: /private/tmp/x a huge raw stderr dump"),
    "CLI exited 1",
  );
  assert.equal(sanitizeClientError("plain message"), "plain message");
});

test("buildCompletionResponse: usage + finish_reason for a max_tokens truncation", () => {
  const out = buildCompletionResponse(
    result({ text: "hi", inputTokens: 3, outputTokens: 4, stopReason: "max_tokens" }),
    "claude-haiku-4",
  );
  assert.equal(out.object, "chat.completion");
  const choice = (out.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "length");
  assert.equal((choice.message as Record<string, unknown>).content, "hi");
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test("buildCompletionResponse: tool calls -> tool_calls finish + serialized args", () => {
  const out = buildCompletionResponse(
    result({
      toolCalls: [{ id: "t1", name: "search", input: { q: "x" } }],
      inputTokens: 1,
      outputTokens: 1,
      stopReason: "tool_use",
    }),
    "m",
  );
  const choice = (out.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "tool_calls");
  const msg = choice.message as Record<string, unknown>;
  assert.equal(msg.content, null);
  const tc = (msg.tool_calls as Array<Record<string, unknown>>)[0];
  const fn = tc.function as Record<string, unknown>;
  assert.equal(fn.name, "search");
  assert.equal(fn.arguments, JSON.stringify({ q: "x" }));
});

test("buildUsagePayload: cache tokens are folded into prompt_tokens + details", () => {
  // OpenClaw reads context size as input+output+cacheRead+cacheWrite, deriving
  // input as prompt_tokens - cached_tokens - cache_write_tokens. Reporting only
  // the uncached input made a 150k-token prompt look like 2 tokens.
  const usage = buildUsagePayload(
    result({ inputTokens: 2, outputTokens: 745, cacheReadTokens: 140_000, cacheCreationTokens: 8_000 }),
  );
  assert.deepEqual(usage, {
    prompt_tokens: 148_002,
    completion_tokens: 745,
    total_tokens: 148_747,
    prompt_tokens_details: { cached_tokens: 140_000, cache_write_tokens: 8_000 },
  });
});

test("buildUsagePayload: omits the details block when nothing was cached", () => {
  assert.deepEqual(buildUsagePayload(result({ inputTokens: 3, outputTokens: 4 })), {
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
  });
});

test("buildCompletionResponse: reports cache tokens in its usage block", () => {
  const out = buildCompletionResponse(
    result({ text: "hi", inputTokens: 2, outputTokens: 5, cacheReadTokens: 900 }),
    "claude-opus-4",
  );
  assert.deepEqual(out.usage, {
    prompt_tokens: 902,
    completion_tokens: 5,
    total_tokens: 907,
    prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
  });
});
