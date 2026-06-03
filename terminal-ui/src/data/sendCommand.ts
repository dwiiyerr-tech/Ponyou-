/**
 * sendCommand.ts — send a slash command to the running bot.
 *
 * Primary path: POST /api/cmd on the dashboard (port 3000).
 * Fallback: write dashboard-cmd.json (the bot polls it every 3s).
 * Mirrors terminal-app/src/data/command-bridge.js.
 */
import { writeFile } from "node:fs/promises";
import { rootPath } from "./paths.js";
import type { CommandResult } from "../types.js";

const DASHBOARD_PORT = Number(process.env.PONYOU_DASHBOARD_PORT || 3000);

async function apiPost(endpoint: string, body: unknown): Promise<CommandResult | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: true, message: String(json.message || "Command sent") };
  } catch {
    return null;
  }
}

/** Send a "/cmd arg arg" string to the bot. Never throws. */
export async function sendCommand(cmd: string): Promise<CommandResult> {
  const parts = cmd.trim().replace(/^\//, "").split(/\s+/);
  const base = parts[0];
  if (!base) return { ok: false, message: "empty command" };

  const viaApi = await apiPost("/api/cmd", { cmd: base, args: parts.slice(1) });
  if (viaApi) return viaApi;

  // File fallback — the bot's dashboard IPC poller picks this up.
  try {
    const payload = {
      id: `tui-${Date.now()}`,
      cmd: base,
      args: parts.slice(1).join(" "),
      timestamp: new Date().toISOString(),
    };
    await writeFile(rootPath("dashboard-cmd.json"), JSON.stringify(payload, null, 2));
    return { ok: true, message: `"/${base}" sent (file fallback — bot polls every 3s)` };
  } catch (e) {
    return { ok: false, message: `failed to send: ${(e as Error).message}` };
  }
}
