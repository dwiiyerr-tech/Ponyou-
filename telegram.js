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

let _pollingActive = false;
let _lastOffset = 0;
let _pollTimer = null;

export function isEnabled() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
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

// ─── Long-poll incoming ──────────────────────────────────────────

export function startPolling(onMessage) {
  if (!isEnabled() || _pollingActive) return;
  _pollingActive = true;
  console.log("[Telegram] Polling started");

  const poll = async () => {
    if (!_pollingActive) return;
    try {
      const res = await fetch(`${API_BASE}/getUpdates?offset=${_lastOffset + 1}&timeout=30`, { signal: AbortSignal.timeout(35000) });
      const data = await res.json();
      if (data?.ok && data.result?.length > 0) {
        for (const update of data.result) {
          _lastOffset = update.update_id;
          if (update.message && String(update.message.chat.id) === String(TELEGRAM_CHAT_ID)) {
            await onMessage(update.message);
          }
        }
      }
    } catch (e) {
      console.error(`[Telegram] Polling error: ${e.message}`);
    }
    if (_pollingActive) {
      _pollTimer = setTimeout(poll, 1000);
    }
  };
  poll();
}

export function stopPolling() {
  _pollingActive = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
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
