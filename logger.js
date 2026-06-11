import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteText } from "./atomic-write.js";

// telegram.js is loaded lazily on first error log to avoid a static cycle
// (logger → telegram → social-trash-gate → logger). Cached after first call.
let _tg = null;
async function getTelegram() {
  if (_tg !== null) return _tg;
  try { _tg = await import("./telegram.js"); } catch { _tg = false; }
  return _tg;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR   = process.env.PONYOU_LOG_DIR || path.join(__dirname, "logs");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Structured error log — one JSON object per line (JSONL).
// Doctor screen reads this to surface recurring errors with location + count.
export const ERROR_LOG_FILE = process.env.PONYOU_ERROR_LOG
  || path.join(__dirname, "error-log.jsonl");

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
  // Redact credential patterns AFTER truncation so a run of repeated chars
  // does not match the key pattern (e.g. "x".repeat(5000) would match base58).
  out = out.replace(/\b(0[xX])?[0-9a-fA-F]{64}\b/g, "[REDACTED]");
  out = out.replace(/[1-9A-HJ-NP-Za-km-z]{87,88}/g, "[REDACTED]");
  out = out.replace(/sk-[A-Za-z0-9\-_]{20,}/g, "[REDACTED]");
  out = out.replace(/Bearer [A-Za-z0-9\-.+\/]{20,}/gi, "Bearer [REDACTED]");
  return out;
}

// ─── Error → Telegram throttle ──────────────────────────────────────────────
// Key = category + message prefix. The first occurrence forwards immediately;
// repeats inside the window are counted silently. When the window expires and
// the same error fires again, the forward carries a "×N (diredam)" annotation
// so the operator still sees the true volume without 142 separate messages.
const TG_ERROR_WINDOW_MS = 15 * 60 * 1000;
const TG_ERROR_MAX_KEYS = 200;
const _tgErrorSeen = new Map(); // key → { windowStart, suppressed }

export function _resetTelegramErrorThrottleForTests() { _tgErrorSeen.clear(); }

export function shouldForwardErrorToTelegram(category, message, now = Date.now()) {
  const key = `${category}|${String(message).slice(0, 80)}`;
  const windowMin = Math.round(TG_ERROR_WINDOW_MS / 60000);
  const seen = _tgErrorSeen.get(key);

  if (seen && now - seen.windowStart < TG_ERROR_WINDOW_MS) {
    seen.suppressed++;
    return { send: false, suppressed: seen.suppressed, windowMin };
  }

  // New key or expired window: forward, reporting how many were suppressed in
  // the window that just closed.
  const suppressed = seen?.suppressed ?? 0;
  if (_tgErrorSeen.size >= TG_ERROR_MAX_KEYS && !_tgErrorSeen.has(key)) {
    // Bounded memory: drop the oldest entry rather than grow without limit.
    const oldest = _tgErrorSeen.keys().next().value;
    if (oldest !== undefined) _tgErrorSeen.delete(oldest);
  }
  _tgErrorSeen.set(key, { windowStart: now, suppressed: 0 });
  return { send: true, suppressed, windowMin };
}

/**
 * General log function.
 */
export function log(category, message) {
  const level = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : category.includes("debug") ? "debug"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const safeCategory = sanitizeLogText(category, 64);
  const safeMessage = sanitizeLogText(message, 2000);
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${safeCategory.toUpperCase()}] ${safeMessage}`;

  // Console output
  console.log(line);

  // Send error to telegram (HTML so the tags actually render) — lazy import.
  // Throttled: a repeating error must not become one chat message per
  // occurrence (measured: 142 identical CRON_ERROR messages over two days).
  if (level === "error") {
    const fwd = shouldForwardErrorToTelegram(safeCategory, safeMessage);
    if (fwd.send) {
      const suffix = fwd.suppressed > 0
        ? `\n<i>×${fwd.suppressed + 1} dalam ${fwd.windowMin} menit terakhir (sisanya diredam)</i>`
        : "";
      getTelegram().then(tg => {
        if (tg && tg.isEnabled && tg.isEnabled()) {
          tg.sendHTML(`⚠️ <b>${htmlEscape(safeCategory)}</b>\n<code>${htmlEscape(safeMessage)}</code>${suffix}`).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  // File output (daily rotation, async to avoid blocking)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFile(logFile, line + "\n", () => { /* best-effort */ });

  // Structured error log — Doctor screen reads this for real-time diagnostics.
  // Only write for error-level categories; warn categories are captured in the
  // daily log file and surfaced separately.
  if (level === "error") {
    // Infer which cycle/component produced this error from the category name.
    const cycle = safeCategory.includes("management") ? "management"
      : safeCategory.includes("screening")  ? "screening"
      : safeCategory.includes("cron")       ? "cron"
      : safeCategory.includes("learning")   ? "learning"
      : safeCategory.includes("geyser")     ? "geyser"
      : safeCategory.includes("vault")      ? "vault"
      : safeCategory.includes("gmgn")       ? "gmgn"
      : safeCategory.includes("jupiter")    ? "jupiter"
      : "unknown";
    const entry = JSON.stringify({
      ts:       timestamp,
      category: safeCategory,
      msg:      safeMessage.slice(0, 300),
      cycle,
    });
    fs.appendFile(ERROR_LOG_FILE, entry + "\n", () => { /* best-effort */ });
  }
}

/**
 * Register process-level uncaught exception and unhandled rejection handlers.
 * Call once at bot startup. Errors are written to error-log.jsonl so Doctor
 * can surface them even when the cycle that caused them is long gone.
 */
// G2: trim error-log.jsonl to MAX_ERROR_LOG_LINES on startup so it never grows
// unboundedly. Called once by captureUncaught(); also safe to call manually.
const MAX_ERROR_LOG_LINES = 1000;
export function trimErrorLog() {
  try {
    if (!fs.existsSync(ERROR_LOG_FILE)) return;
    const raw = fs.readFileSync(ERROR_LOG_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_ERROR_LOG_LINES) {
      atomicWriteText(ERROR_LOG_FILE, lines.slice(-MAX_ERROR_LOG_LINES).join("\n") + "\n");
    }
  } catch { /* best-effort — don't crash the process trying to trim a log */ }
}

export function captureUncaught() {
  // G2: trim on startup so the file stays bounded across restarts.
  trimErrorLog();

  process.on("uncaughtException", (err) => {
    const entry = JSON.stringify({
      ts:       new Date().toISOString(),
      category: "UNCAUGHT_EXCEPTION",
      msg:      (err?.message || String(err)).slice(0, 300),
      stack:    (err?.stack || "").split("\n").slice(1, 4).join(" | ").slice(0, 400),
      cycle:    "process",
    });
    // B2: wrap in try/catch — blocking I/O in shutdown path must not deadlock.
    try { fs.appendFileSync(ERROR_LOG_FILE, entry + "\n"); } catch { /* disk full / locked */ }
    console.error("[UNCAUGHT_EXCEPTION]", err);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error
      ? (reason.stack || "").split("\n").slice(1, 4).join(" | ").slice(0, 400)
      : "";
    const entry = JSON.stringify({
      ts:       new Date().toISOString(),
      category: "UNHANDLED_REJECTION",
      msg:      msg.slice(0, 300),
      stack,
      cycle:    "process",
    });
    // B2: try/catch so a write failure never hides the original rejection.
    try { fs.appendFileSync(ERROR_LOG_FILE, entry + "\n"); } catch { /* disk full / locked */ }
    console.error("[UNHANDLED_REJECTION]", reason);
  });
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
