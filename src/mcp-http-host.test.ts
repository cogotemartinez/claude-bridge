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

test("the MCP pending gate waits a minute by default, and takes an override from the env", () => {
  // Was a hard 10s and killed a slow CLI turn on 2026-09-19.
  assert.equal(mcpPendingTimeoutMs({}), 60_000);
  assert.equal(mcpPendingTimeoutMs({ CLAUDE_BRIDGE_MCP_PENDING_TIMEOUT_MS: "5000" }), 5_000);
  assert.equal(mcpPendingTimeoutMs({ CLAUDE_BRIDGE_MCP_PENDING_TIMEOUT_MS: "no" }), 60_000);
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
