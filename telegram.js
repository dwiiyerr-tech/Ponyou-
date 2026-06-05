/**
 * Telegram Bot — rapih, minimalist, HTML-first.
 *
 * Design principles (post-cleanup):
 *  - All outbound text uses parse_mode "HTML". Markdown is fragile with
 *    underscores in token names, which LLM output produces constantly.
 *  - sendMessage(text) accepts plain text or HTML; it HTML-escapes plain
 *    bodies automatically so user/LLM content can't break parsing.
 *  - Web-page previews are disabled by default — keeps notifications clean.
 *  - Helper `fmt` exposes consistent building blocks (line, kv, divider).
 */

import "dotenv/config";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─── Group monitor config ────────────────────────────────────────
// TELEGRAM_GROUP_IDS = comma-separated group/channel IDs, or "*" for all
// Example: TELEGRAM_GROUP_IDS=-1001234567890,-1009876543210
const _RAW_GROUP_IDS = process.env.TELEGRAM_GROUP_IDS || "";
const _MONITOR_ALL   = _RAW_GROUP_IDS.trim() === "*";
const _MONITORED_IDS = _MONITOR_ALL
  ? new Set()
  : new Set(_RAW_GROUP_IDS.split(",").map(s => s.trim()).filter(Boolean));

// Runtime stats per group
const _groupStats = new Map(); // chatId → { title, calls, lastSeen }

let _pollingActive = false;
let _lastOffset = 0;
let _pollTimer = null;

export function isEnabled() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

export function isGroupMonitorEnabled() {
  return !!(TELEGRAM_BOT_TOKEN && (_MONITOR_ALL || _MONITORED_IDS.size > 0));
}

export function getGroupMonitorStats() {
  return {
    mode:     _MONITOR_ALL ? "all" : "whitelist",
    groups:   _MONITORED_IDS.size,
    stats:    Object.fromEntries(_groupStats),
  };
}

// ─── Format helpers ──────────────────────────────────────────────

export function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const DIVIDER = "──────────────";

export const fmt = {
  bold:  (s) => `<b>${htmlEscape(s)}</b>`,
  code:  (s) => `<code>${htmlEscape(s)}</code>`,
  it:    (s) => `<i>${htmlEscape(s)}</i>`,
  link:  (text, href) => `<a href="${href}">${htmlEscape(text)}</a>`,
  divider: () => DIVIDER,
  kv:    (k, v) => `${htmlEscape(k)}: <b>${htmlEscape(v)}</b>`,
  short: (s, n = 8) => (s ? `${String(s).slice(0, n)}…` : "?"),
  pct:   (n) => {
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
  },
  usd:   (n) => {
    if (!Number.isFinite(n)) return "—";
    return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
  },
  sol:   (n) => {
    if (!Number.isFinite(n)) return "—";
    return `${n.toFixed(n >= 1 ? 3 : 4)} SOL`;
  },
};

// Allow callers to opt-out of escape for already-HTML strings.
function looksLikeHtml(s) {
  return typeof s === "string" && /<[a-z][^>]*>/i.test(s);
}

// ─── Low-level send ──────────────────────────────────────────────

async function postTelegram(endpoint, body) {
  if (!isEnabled()) return null;
  try {
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return await res.json();
  } catch (e) {
    console.error(`[Telegram] ${endpoint} failed: ${e.message}`);
    return null;
  }
}

/**
 * Send a message. Accepts:
 *  - Plain text (will be HTML-escaped)
 *  - Already-HTML (detected via tag scan; sent as-is)
 *
 * Always uses parse_mode "HTML" and disables URL preview.
 */
export async function sendMessage(text) {
  if (!isEnabled() || !text) return null;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: looksLikeHtml(text) ? text : htmlEscape(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  return postTelegram("sendMessage", payload);
}

/** Explicit HTML sender — text is sent verbatim (caller is responsible). */
export async function sendHTML(html) {
  if (!isEnabled() || !html) return null;
  return postTelegram("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ─── PnL table — minimalist monospace ────────────────────────────

export function formatPnLTable(trades) {
  if (!trades?.length) return fmt.it("Belum ada trade tercatat.");

  const rows = trades.slice(-10).map((t) => {
    const sym = (t.symbol || "?").slice(0, 8).padEnd(8);
    const pnl = Number.isFinite(t.pnl_pct) ? t.pnl_pct : 0;
    const pct = (pnl >= 0 ? "+" : "") + pnl.toFixed(2);
    const mark = t.win ? "🟢" : "🔴";
    return `${sym} ${pct.padStart(7)}% ${mark}`;
  });

  return [
    "<b>PnL — last 10</b>",
    "<pre>" + rows.join("\n") + "</pre>",
  ].join("\n");
}

// ─── Bot command registration ────────────────────────────────────

const BOT_COMMANDS = [
  { command: "status",        description: "Status bot & market" },
  { command: "pnl",           description: "Riwayat profit & loss" },
  { command: "menu",          description: "Menu lengkap strategi & posisi" },
  { command: "health",        description: "Health check semua fitur" },
  { command: "agents",        description: "Status semua agent" },
  { command: "positions",     description: "Posisi aktif saat ini" },
  { command: "strategies",    description: "List & ganti strategi" },
  { command: "auto",          description: "Start/stop automation (on|off)" },
  { command: "autonomy",      description: "Set autonomy level (manual|supervised|full_auto)" },
  { command: "proposals",     description: "Lihat vault proposals pending" },
  { command: "chains",        description: "Status multi-chain market" },
  { command: "setup_brain",   description: "Hubungkan Obsidian vault ke GitHub (panduan)" },
  { command: "help",          description: "Daftar semua command" },
];

export async function registerBotCommands() {
  if (!isEnabled()) return;
  const res = await postTelegram("setMyCommands", { commands: BOT_COMMANDS });
  if (res?.ok) {
    console.log(`[Telegram] Registered ${BOT_COMMANDS.length} bot commands`);
  } else {
    console.warn("[Telegram] setMyCommands failed:", res?.description || "unknown error");
  }
}

// ─── Long-poll incoming ──────────────────────────────────────────

export function startPolling(onMessage) {
  if (!TELEGRAM_BOT_TOKEN || _pollingActive) return;
  _pollingActive = true;
  console.log("[Telegram] Polling started" + (isGroupMonitorEnabled()
    ? ` | group monitor: ${_MONITOR_ALL ? "ALL groups" : `${_MONITORED_IDS.size} groups`}`
    : ""));

  const poll = async () => {
    if (!_pollingActive) return;
    try {
      const res  = await fetch(
        `${API_BASE}/getUpdates?offset=${_lastOffset + 1}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      const data = await res.json();

      if (data?.ok && data.result?.length > 0) {
        for (const update of data.result) {
          _lastOffset = update.update_id;

          // message = group/private messages
          // channel_post = posts from channels where bot is admin
          const msg = update.message || update.channel_post;
          if (!msg) continue;

          const chatId   = String(msg.chat?.id || "");
          const chatType = msg.chat?.type || "";   // private | group | supergroup | channel

          // ── Personal chat → bot commands ────────────────────────
          if (chatId === String(TELEGRAM_CHAT_ID)) {
            await onMessage(msg);
            continue;
          }

          // ── Group / channel → call hunter ───────────────────────
          const isMonitored = _MONITOR_ALL || _MONITORED_IDS.has(chatId);
          const isGroupLike  = chatType === "group" || chatType === "supergroup" || chatType === "channel";

          if (isMonitored && isGroupLike) {
            // Track group stats
            if (!_groupStats.has(chatId)) {
              _groupStats.set(chatId, { title: msg.chat?.title || chatId, calls: 0, lastSeen: null });
            }
            const stat = _groupStats.get(chatId);
            stat.lastSeen = new Date().toISOString();

            // Enrich message with group metadata before parsing
            const enriched = _enrichGroupMessage(msg);
            const parsed   = await handleCallMessage(enriched);
            if (parsed > 0) stat.calls += parsed;
          }
        }
      }
    } catch (e) {
      console.error(`[Telegram] Polling error: ${e.message}`);
    }
    if (_pollingActive) _pollTimer = setTimeout(poll, 1000);
  };

  poll();
}

// Enrich a group message with context useful for the call parser
function _enrichGroupMessage(msg) {
  const fwd = msg.forward_from_chat;
  return {
    ...msg,
    // If message is forwarded from another channel, use original channel name
    _forwardedFrom: fwd ? (fwd.title || fwd.username || String(fwd.id)) : null,
    // Prefer forward date as original posting time
    _originalDate:  msg.forward_date || msg.date,
    // Views are available on channel posts
    views:          msg.views || 0,
  };
}

export function stopPolling() {
  _pollingActive = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

// ─── Call signal parser ───────────────────────────────────────────
// Parses incoming Telegram messages for token call signals.
// Detected calls are filtered through social-trash-gate.js and written
// to social-signals.json alongside Reddit/Discord signals.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve as _resolve, dirname as _dirname } from "path";
import { fileURLToPath as _ftu } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";
const _root = _dirname(_ftu(import.meta.url));
const _SIGNALS_FILE = _resolve(_root, "social-signals.json");

const CALL_RE = [
  /\bcall\b/i,
  /\bentry\b.*\b(sol|usd)\b/i,
  /🟢|🚀|💎|🔥|⚡|📢/,
  /\b(buy|long|ape)\b.{0,30}\$?[A-Z]{2,10}/i,
  /\$[A-Z]{2,10}.{0,30}\b(gem|alpha|signal|call)\b/i,
];

const _SYM_RE = /\$([A-Z]{2,12})\b|(?:^|\s)([A-Z]{3,10})(?:\s|$)/g;
const _IGNORE = new Set(["THE","AND","FOR","BUT","GET","NEW","NOW","CAN","BUY","APE","GEM","USD","SOL","LFG","ATH","FOMO","HODL","DYOR"]);

export function parseCallSignal(message = {}) {
  const text = (message.text || message.caption || "").trim();
  if (!text) return [];

  const isCall = CALL_RE.some(re => re.test(text));
  // Also accept forwarded messages from known channels even without call keywords
  const isForwarded = !!(message._forwardedFrom || message.forward_from_chat);

  if (!isCall && !isForwarded) return [];

  const syms = new Set();
  let m;
  _SYM_RE.lastIndex = 0;
  while ((m = _SYM_RE.exec(text)) !== null) {
    const s = (m[1] || m[2] || "").toUpperCase();
    if (s.length >= 2 && s.length <= 12 && !_IGNORE.has(s)) syms.add(s);
  }
  if (syms.size === 0) return [];

  const channelName = message._forwardedFrom
    || message.chat?.title
    || String(message.chat?.id || "");

  const postedAt = new Date(
    ((message._originalDate || message.date || 0)) * 1000
  ).toISOString();

  return [...syms].map(sym => ({
    symbol:          sym,
    source:          "telegram",
    channel:         channelName,
    chatId:          String(message.chat?.id || ""),
    text:            text.slice(0, 300),
    views:           message.views || 0,
    forwards:        message.forward_count || 0,
    isForwarded:     isForwarded,
    forwardedFrom:   message._forwardedFrom || null,
    postedAt,
  }));
}

// Returns number of signals that passed the gate (0 if none)
export async function handleCallMessage(message = {}) {
  const signals = parseCallSignal(message);
  if (signals.length === 0) return 0;

  const { gateSignal } = await import("./social-trash-gate.js");

  // T3-3: wrap the read-modify-write in withFileLock so concurrent telegram
  // signal handlers don't interleave reads and clobber each other's writes.
  // social-hunter.js and discord-listener.js already use withFileLock here.
  return withFileLock(_SIGNALS_FILE, async () => {
    let cache = { updatedAt: null, signals: [] };
    try {
      if (existsSync(_SIGNALS_FILE)) cache = JSON.parse(readFileSync(_SIGNALS_FILE, "utf-8"));
    } catch {}

    const existing = new Map((cache.signals || []).map(s => [s.symbol, s]));
    let passed = 0;

    for (const sig of signals) {
      const gate = gateSignal(sig);
      if (!gate.pass) continue;
      passed++;

      const prev = existing.get(sig.symbol) || {
        symbol: sig.symbol, mentions: 0, engagement: 0, sources: [],
        firstSeen: sig.postedAt, lastSeen: sig.postedAt,
      };

      // Forwarded calls from alpha channels carry higher weight
      const scoreBoost = sig.isForwarded ? 30 : 20;

      existing.set(sig.symbol, {
        ...prev,
        source:     "telegram",
        mentions:   (prev.mentions || 0) + 1,
        engagement: (prev.engagement || 0) + (sig.views || 0),
        sources:    [...(prev.sources || []), `telegram:${sig.channel}:${sig.views}`],
        lastSeen:   sig.postedAt,
        gate,
        socialScore: Math.min(100, (prev.socialScore || 0) + scoreBoost),
      });
    }

    if (passed > 0) {
      cache.updatedAt = new Date().toISOString();
      cache.signals   = [...existing.values()];
      try { await atomicWriteJson(_SIGNALS_FILE, cache); } catch {}
    }

    return passed;
  });
}

// ─── Live message: edits in place to show progress ───────────────

const HOURGLASS = "⏳";
const CHECK     = "✅";
const CROSS     = "❌";

export async function createLiveMessage(title, initialText) {
  if (!isEnabled()) {
    return { toolStart: async () => {}, toolFinish: async () => {}, finalize: async () => {} };
  }

  const headerHtml = fmt.bold(title);
  const placeholder = `${headerHtml}\n${fmt.it(initialText || "Memproses…")}`;
  const res = await sendHTML(placeholder);
  const messageId = res?.result?.message_id;

  return {
    async toolStart(name) {
      if (!messageId) return;
      await editMessage(messageId, `${headerHtml}\n${HOURGLASS} ${fmt.code(name)}…`);
    },
    async toolFinish(name, _result, success) {
      if (!messageId) return;
      const icon = success ? CHECK : CROSS;
      await editMessage(messageId, `${headerHtml}\n${icon} ${fmt.code(name)}`);
    },
    async finalize(finalText) {
      if (!messageId) return;
      const body = looksLikeHtml(finalText) ? finalText : htmlEscape(finalText || "");
      await editMessage(messageId, `${headerHtml}\n${body}`.trim());
    },
  };
}

async function editMessage(messageId, html) {
  return postTelegram("editMessageText", {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ─── Trade notifications — minimalist ────────────────────────────

const SOLSCAN = (tx) => `https://solscan.io/tx/${tx}`;

export function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  const lines = [
    `🔄 ${fmt.bold("Swap")}`,
    `${htmlEscape(amountIn ?? "?")} ${htmlEscape(inputSymbol || "?")} → ${htmlEscape(amountOut ?? "?")} ${htmlEscape(outputSymbol || "?")}`,
  ];
  if (tx) lines.push(fmt.link("solscan", SOLSCAN(tx)));
  return sendHTML(lines.join("\n"));
}

export function notifyDeploy({ symbol, amount, tx }) {
  const lines = [
    `🚀 ${fmt.bold("Open")} · ${htmlEscape(symbol || "?")}`,
    `Size: ${fmt.sol(Number(amount))}`,
  ];
  if (tx) lines.push(fmt.link("solscan", SOLSCAN(tx)));
  return sendHTML(lines.join("\n"));
}

export function notifyClose({ symbol, pnl, tx }) {
  const pnlNum = Number(pnl);
  const icon = pnlNum >= 0 ? "💰" : "📉";
  const lines = [
    `${icon} ${fmt.bold("Close")} · ${htmlEscape(symbol || "?")}`,
    `PnL: ${fmt.pct(pnlNum)}`,
  ];
  if (tx) lines.push(fmt.link("solscan", SOLSCAN(tx)));
  return sendHTML(lines.join("\n"));
}
