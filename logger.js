import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// telegram.js is loaded lazily on first error log to avoid a static cycle
// (logger → telegram → social-trash-gate → logger). Cached after first call.
let _tg = null;
async function getTelegram() {
  if (_tg !== null) return _tg;
  try { _tg = await import("./telegram.js"); } catch { _tg = false; }
  return _tg;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.PONYOU_LOG_DIR || path.join(__dirname, "logs");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// HTML escape for safe Telegram error notifications.
// Escapes all HTML special characters including Telegram parse-mode
// sensitive ones (quotes, control chars that could break formatting).
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strip CRLF, ANSI escapes, and other control chars to prevent log injection
// from external API responses or attacker-controlled error messages.
// Truncate to bound log line size.
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
const CTRL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;
function sanitizeLogText(s, max = 2000) {
  let out = String(s == null ? "" : s);
  out = out.replace(ANSI_RE, "");
  out = out.replace(/\r\n|\r|\n/g, " ");
  out = out.replace(CTRL_RE, "");
  if (out.length > max) out = out.slice(0, max) + "…";
  return out;
}

/**
 * General log function.
 */
export function log(category, message) {
  const level = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const safeCategory = sanitizeLogText(category, 64);
  const safeMessage = sanitizeLogText(message, 2000);
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${safeCategory.toUpperCase()}] ${safeMessage}`;

  // Console output
  console.log(line);

  // Send error to telegram (HTML so the tags actually render) — lazy import
  if (level === "error") {
    getTelegram().then(tg => {
      if (tg && tg.isEnabled && tg.isEnabled()) {
        tg.sendHTML(`⚠️ <b>${htmlEscape(safeCategory)}</b>\n<code>${htmlEscape(safeMessage)}</code>`).catch(() => {});
      }
    }).catch(() => {});
  }

  // File output (daily rotation, async to avoid blocking)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFile(logFile, line + "\n", () => { /* best-effort */ });
}

/**
 * Log a tool action with full details (for audit trail).
 */
function actionHint(action) {
  const a = action.args || {};
  const r = action.result || {};
  switch (action.tool) {
    case "deploy_position":   return ` ${a.pool_name || a.pool_address?.slice(0,8)} ${a.amount_sol} SOL`;
    case "close_position":    return ` ${a.position_address?.slice(0,8)}${r.pnl_usd != null ? ` | PnL $${r.pnl_usd >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${a.position_address?.slice(0,8)}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || a.pool_address?.slice(0,8) || ""}`;
    case "get_my_positions":  return ` ${r.total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${r.sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${r?.candidates?.length ?? ""} pools`;
    case "swap_token":        return ` ${a.amount} ${a.input_mint?.slice(0,6)}→SOL`;
    case "update_config":     return ` ${Object.keys(r.applied || {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${r.cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action) {
  const timestamp = new Date().toISOString();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail (async)
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFile(actionsFile, JSON.stringify(entry) + "\n", () => { /* best-effort */ });
}
