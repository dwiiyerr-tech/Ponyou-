import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

// Allowed commands and their max argument lengths.
const ALLOWED_COMMANDS = new Set([
  "pause", "resume", "stop", "start", "restart",
  "set_strategy", "toggle_feature", "set_mode",
  "sweep_vault", "reset_plan", "emergency_stop",
  "clear_lessons", "add_smart_wallet", "remove_smart_wallet",
  "blacklist_token", "unblacklist_token", "refund_rent",
  "set_config", "force_readiness", "reset_kill_switch",
  "status", "buy", // dashboard test + IPC commands
]);
const MAX_CMD_LEN = 64;
const MAX_ARG_LEN = 256;
const MAX_ARGS_COUNT = 10;

function safeCmd(input) {
  return String(input || "").slice(0, MAX_CMD_LEN).replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeArg(input) {
  return String(input || "").slice(0, MAX_ARG_LEN);
}

function validateCommand(id, cmd, args) {
  if (!cmd || !ALLOWED_COMMANDS.has(cmd)) return `Unknown command: ${String(cmd).slice(0, 64)}`;
  if (typeof id !== "string" || id.length > 64) return "Invalid command id";
  if (!Array.isArray(args)) return "args must be an array";
  if (args.length > MAX_ARGS_COUNT) return `Too many args: ${args.length} (max ${MAX_ARGS_COUNT})`;
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === "object") continue; // objects are serialized by atomicWriteJson
    if (String(args[i]).length > MAX_ARG_LEN) return `Arg ${i} too long: ${String(args[i]).length} chars`;
  }
  return null;
}

export function writeAutomationCommand(cmd) {
  const safe = safeCmd(cmd);
  if (!safe) return { error: "Invalid command" };
  const fp = path.join(BASE_PATH, "automation-command.json");
  atomicWriteJson(fp, { cmd: safe, ts: new Date().toISOString() });
  return { ok: true };
}

export function writeDashboardCmd({ id, cmd, args = [] }) {
  const safe = safeCmd(cmd);
  const err = validateCommand(id, safe, args);
  if (err) return { error: err };
  const fp = path.join(BASE_PATH, "dashboard-cmd.json");
  atomicWriteJson(fp, { id, cmd: safe, args, ts: new Date().toISOString() });
  return { ok: true };
}

export function readDashboardResponse(id) {
  const fp = path.join(BASE_PATH, "dashboard-response.json");
  try {
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return data.id === id ? data : null;
  } catch { return null; }
}
