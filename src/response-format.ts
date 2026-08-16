import type { CLIResult, CLIToolCall } from "./cli-worker.js";

/** Map the Claude/Anthropic stop_reason to a valid OpenAI finish_reason.
 *  OpenAI's enum is {stop, length, tool_calls, content_filter, function_call}.
 *  Every terminal site previously emitted just `hasToolCalls ? "tool_calls" :
 *  "stop"`, discarding the real stop_reason — so a max-tokens truncation was
 *  reported as a normal "stop" and a caller couldn't tell the reply was cut
 *  off. */
export function mapFinishReason(
  stopReason: string | undefined,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls) return "tool_calls";
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    // end_turn, stop_sequence, pause_turn, undefined → normal stop
    default:
      return "stop";
  }
}

/** Strip raw `claude` CLI stderr from an error message before it reaches the
 *  HTTP client. The CLI worker appends stderr as a " | stderr: …" tail (and
 *  emits "CLI exited N: <stderr>") which can contain absolute file paths or
 *  auth-state hints. The full message still goes to structured logs and to the
 *  retry classifier — only the client-facing copy is trimmed. */
export function sanitizeClientError(message: string): string {
  let m = message;
  const sIdx = m.indexOf(" | stderr:");
  if (sIdx >= 0) m = m.slice(0, sIdx);
  m = m.replace(/^(CLI exited -?\d+):[\s\S]*$/, "$1");
  return m;
}

function toOAIToolCall(tc: CLIToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  };
}

/** OpenAI-shape usage block for a finished turn.
 *
 *  `prompt_tokens` is the WHOLE prompt — uncached input plus both cache
 *  counters — because that is what OpenAI-compatible clients read as the
 *  context size. The split is preserved in `prompt_tokens_details` so a client
 *  can still recover the uncached input (`prompt_tokens - cached_tokens -
 *  cache_write_tokens`) and price the turn correctly.
 *
 *  This matters more than it looks: the CLI serves nearly every prompt from
 *  its prefix cache, so reporting only `inputTokens` told callers a 150k-token
 *  conversation was ~2 tokens. OpenClaw sizes its context from this block, so
 *  it never saw a session fill up and never compacted one. */
export function buildUsagePayload(result: CLIResult): Record<string, unknown> {
  const cacheRead = result.cacheReadTokens || 0;
  const cacheWrite = result.cacheCreationTokens || 0;
  const promptTokens = result.inputTokens + cacheRead + cacheWrite;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: result.outputTokens,
    total_tokens: promptTokens + result.outputTokens,
    // Omitted entirely when nothing was cached, so a plain turn keeps the
    // minimal shape older clients expect.
    ...(cacheRead > 0 || cacheWrite > 0
      ? { prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite } }
      : {}),
  };
}

export function buildCompletionResponse(
  result: CLIResult,
  modelId: string,
): Record<string, unknown> {
  const hasToolCalls = result.toolCalls.length > 0;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || null,
  };
  if (hasToolCalls) {
    message.tool_calls = result.toolCalls.map(toOAIToolCall);
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(result.stopReason, hasToolCalls),
      },
    ],
    usage: buildUsagePayload(result),
  };
}
