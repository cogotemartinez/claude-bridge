import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeMcpHttpServer, isLoopbackHost, mcpPendingTimeoutMs } from "./mcp-http.ts";

test("isLoopbackHost: accepts loopback hosts (with and without port)", () => {
  for (const h of [
    "127.0.0.1",
    "127.0.0.1:3456",
    "localhost",
    "localhost:18080",
    "[::1]",
    "[::1]:3456",
    "0.0.0.0:3456",
  ]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
});

test("isLoopbackHost: accepts a missing/empty Host header", () => {
  // Some minimal MCP clients omit Host; the server is loopback-bound anyway.
  assert.equal(isLoopbackHost(undefined), true);
  assert.equal(isLoopbackHost(""), true);
  assert.equal(isLoopbackHost("   "), true);
});

test("isLoopbackHost: rejects non-loopback hosts (DNS-rebinding defense)", () => {
  for (const h of [
    "evil.example.com",
    "evil.example.com:3456",
    "169.254.169.254",
    "attacker.local",
    "10.0.0.5:3456",
  ]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("waitForPending resolves on the tools/call event (real loopback server)", async () => {
  const server = new BridgeMcpHttpServer();
  const port = await server.start(0);
  const key = "agent:test:waitforpending";
  server.registerSession(key, [{ name: "search", inputSchema: { type: "object" } }]);
  const toolUseId = "toolu_event_1";
  const url = `http://127.0.0.1:${port}/${encodeURIComponent(key)}`;

  // Fire the parked tools/call POST — it stays open until we resolve it, so
  // do NOT await it here.
  const post = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search",
        arguments: {},
        _meta: { "claudecode/toolUseId": toolUseId },
      },
    }),
  }).catch(() => undefined);

  // The waiter must resolve once the POST lands (via the event fast path).
  await server.waitForPending(key, toolUseId, 2000);

  // Deliver a result so the parked POST closes cleanly, then shut down.
  assert.equal(server.tryResolveToolCall(key, toolUseId, [{ type: "text", text: "ok" }]), true);
  await post;
  await server.stop();
});

test("the gate resolves on the tool the CLI really called, not the one announced first", async () => {
  // The 2026-09-19 deadlock. An assistant turn can carry SEVERAL tool_use
  // blocks; nextCheckpoint hands back only the first and buffers the rest,
  // while the CLI invokes them in its own order. The bridge announced `exec`
  // and the CLI POSTed `memory_search`: nobody resolved that POST, because the
  // gateway was never told about it, so the CLI blocked on its result and the
  // bridge blocked on a different id. Both sides waited out the whole budget.
  const server = new BridgeMcpHttpServer();
  const port = await server.start(0);
  const key = "agent:test:parallel-toolcalls";
  server.registerSession(key, [
    { name: "exec", inputSchema: { type: "object" } },
    { name: "memory_search", inputSchema: { type: "object" } },
  ]);
  const announced = "toolu_announced_exec";
  const actuallyCalled = "toolu_actual_memory_search";
  const url = `http://127.0.0.1:${port}/${encodeURIComponent(key)}`;

  const post = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {},
        _meta: { "claudecode/toolUseId": actuallyCalled },
      },
    }),
  }).catch(() => undefined);

  try {
    const landed = await server.waitForPending(key, announced, 2000, "exec");

    // It must report the call that actually arrived, so the caller forwards
    // THAT one to the gateway and the CLI gets its result.
    assert.equal(landed.toolUseId, actuallyCalled);
    assert.equal(landed.name, "memory_search");
  } finally {
    // Always close the parked POST, or a red run hangs the whole suite.
    server.tryResolveToolCall(key, actuallyCalled, [{ type: "text", text: "ok" }]);
    await post;
    await server.stop();
  }
});

test("the gate still prefers the announced tool when that is the one that lands", async () => {
  // Negative control for the change above: with no surprise, nothing changes.
  const server = new BridgeMcpHttpServer();
  const port = await server.start(0);
  const key = "agent:test:single-toolcall";
  server.registerSession(key, [{ name: "search", inputSchema: { type: "object" } }]);
  const toolUseId = "toolu_expected";
  const url = `http://127.0.0.1:${port}/${encodeURIComponent(key)}`;

  const post = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search",
        arguments: {},
        _meta: { "claudecode/toolUseId": toolUseId },
      },
    }),
  }).catch(() => undefined);

  try {
    const landed = await server.waitForPending(key, toolUseId, 2000, "search");

    assert.equal(landed.toolUseId, toolUseId);
    assert.equal(landed.name, "search");
  } finally {
    server.tryResolveToolCall(key, toolUseId, [{ type: "text", text: "ok" }]);
    await post;
    await server.stop();
  }
});

test("the MCP pending gate waits the turn's own budget, and takes an override from the env", () => {
  // Was a hard 10s, then briefly a hard 60s earlier the same day. Both were
  // invented numbers: measured on 2026-09-19, a continuation in a 304k-token
  // session took 3m55s and 7m55s to reach its tool call, on two models. The
  // gate cannot separate slow from stuck, so it waits as long as the turn may.
  assert.equal(mcpPendingTimeoutMs({}, 300_000), 300_000);
  assert.equal(mcpPendingTimeoutMs({}, 42_000), 42_000);
  // No budget passed: the pool's own default, not something shorter.
  assert.equal(mcpPendingTimeoutMs({}), 300_000);
  // An explicit override still wins over the budget, in both directions.
  assert.equal(mcpPendingTimeoutMs({ CLAUDE_BRIDGE_MCP_PENDING_TIMEOUT_MS: "5000" }, 300_000), 5_000);
  assert.equal(
    mcpPendingTimeoutMs({ CLAUDE_BRIDGE_MCP_PENDING_TIMEOUT_MS: "900000" }, 300_000),
    900_000,
  );
  // Garbage falls back to the budget rather than to zero.
  assert.equal(mcpPendingTimeoutMs({ CLAUDE_BRIDGE_MCP_PENDING_TIMEOUT_MS: "no" }, 300_000), 300_000);
});

test("waitForPending names the tool in its timeout, so the log says what the CLI asked for", async () => {
  // The 2026-09-19 webchat failure only said the tool_use id, which appears in
  // no other log line: nothing said which tool the CLI announced.
  const server = new BridgeMcpHttpServer();
  await server.start(0);
  const key = "agent:test:namedtimeout";
  server.registerSession(key, []);
  await assert.rejects(
    () => server.waitForPending(key, "toolu_missing", 100, "mcp__openclaw__read"),
    /waitForPending timeout: mcp__openclaw__read toolu_missing did not arrive within 100ms/,
  );
  await server.stop();
});

test("waitForPending rejects with a forbidden Host POST never landing (timeout)", async () => {
  const server = new BridgeMcpHttpServer();
  await server.start(0);
  const key = "agent:test:nopending";
  server.registerSession(key, []);
  await assert.rejects(
    () => server.waitForPending(key, "toolu_missing", 150),
    /waitForPending timeout/,
  );
  await server.stop();
});
