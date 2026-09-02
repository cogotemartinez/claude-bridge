/**
 * Plugin isolation for the spawned `claude` CLI.
 *
 * Why (2026-09-01): the bridge spawns `claude` with the operator's own
 * ~/.claude/settings.json, so every plugin the operator enabled for their
 * interactive Claude Code sessions (superpowers, frontend-design, …) loads
 * into every bridge worker too. The superpowers plugin registers a
 * SessionStart hook (matcher startup|clear|compact) that injects a "you have
 * superpowers, invoke a skill before ANY response" block; the agent then
 * spends its first line rejecting it — 3/3 plata-briefing runs and 11 lines
 * of "ignoro superpowers" in one sistema-mantenimiento run. The block never
 * enters the gateway transcript, so no workspace rule can see it coming.
 *
 * Measured with `--output-format stream-json --include-hook-events`: without
 * the flag, 15 hook events and 3 "superpowers" mentions; with
 * `--settings '{"enabledPlugins":{…:false}}'`, 13 events and 0 mentions, and
 * OAuth auth intact. `--bare` was rejected because it also disables OAuth;
 * a separate CLAUDE_CONFIG_DIR was rejected because the login lives in the
 * default one ("Not logged in" measured).
 *
 * The list is computed at spawn time from the operator's settings so a plugin
 * enabled tomorrow is disabled for the bridge tomorrow too, without a redeploy.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function settingsPathFor(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  return join(dir, "settings.json");
}

/** Reads the operator's enabledPlugins and returns them all set to false. */
export function pluginIsolationSettings(settingsPath = settingsPathFor()): string | null {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return null; // no settings file → nothing to isolate
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // unreadable settings: the CLI will complain on its own
  }
  const enabled = (parsed as { enabledPlugins?: unknown })?.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return null;
  const off: Record<string, false> = {};
  for (const key of Object.keys(enabled as Record<string, unknown>)) off[key] = false;
  if (Object.keys(off).length === 0) return null;
  return JSON.stringify({ enabledPlugins: off });
}

/** Appends `--settings <json>` when there is something to isolate. */
export function pushPluginIsolationArgs(args: string[], settings = pluginIsolationSettings()): string[] {
  if (settings && process.env.CLAUDE_BRIDGE_PLUGIN_ISOLATION !== "0") {
    args.push("--settings", settings);
  }
  return args;
}
