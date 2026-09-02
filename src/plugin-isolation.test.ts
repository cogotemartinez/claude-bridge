import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pluginIsolationSettings, pushPluginIsolationArgs, settingsPathFor } from "./plugin-isolation.ts";

test("turns every enabled plugin off, keeps unrelated settings out", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-iso-"));
  const p = join(dir, "settings.json");
  writeFileSync(p, JSON.stringify({ enabledPlugins: { "a@x": true, "b@x": false }, model: "opus" }));
  assert.equal(pluginIsolationSettings(p), JSON.stringify({ enabledPlugins: { "a@x": false, "b@x": false } }));
});

test("no settings file, no plugins, or broken JSON → null (nothing appended)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-iso-"));
  assert.equal(pluginIsolationSettings(join(dir, "missing.json")), null);
  const empty = join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify({ enabledPlugins: {} }));
  assert.equal(pluginIsolationSettings(empty), null);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  assert.equal(pluginIsolationSettings(broken), null);
  assert.deepEqual(pushPluginIsolationArgs(["--print"], null), ["--print"]);
});

test("appends --settings once, respects the kill switch", () => {
  assert.deepEqual(pushPluginIsolationArgs(["--print"], '{"enabledPlugins":{"a":false}}'), ["--print", "--settings", '{"enabledPlugins":{"a":false}}']);
  process.env.CLAUDE_BRIDGE_PLUGIN_ISOLATION = "0";
  assert.deepEqual(pushPluginIsolationArgs(["--print"], '{"enabledPlugins":{"a":false}}'), ["--print"]);
  delete process.env.CLAUDE_BRIDGE_PLUGIN_ISOLATION;
});

test("settings path honours CLAUDE_CONFIG_DIR", () => {
  assert.equal(settingsPathFor({ CLAUDE_CONFIG_DIR: "/x" }), "/x/settings.json");
  assert.equal(settingsPathFor({ HOME: "/h" }), "/h/.claude/settings.json");
});
