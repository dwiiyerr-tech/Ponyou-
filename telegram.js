import "dotenv/config";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

let _pollingActive = false;
let _lastOffset = 0;

export function isEnabled() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

/**
 * Send a simple text message.
 */
export async function sendMessage(text) {
  if (!isEnabled()) return;
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "Markdown",
      }),
    });
    return await res.json();
  } catch (e) {
    console.error(`[Telegram] Send failed: ${e.message}`);
  }
}

/**
 * Send an HTML message (useful for tables/formatting).
 */
export async function sendHTML(html) {
  if (!isEnabled()) return;
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: html,
        parse_mode: "HTML",
      }),
    });
    return await res.json();
  } catch (e) {
    console.error(`[Telegram] Send HTML failed: ${e.message}`);
  }
}

/**
 * Format PnL data as an HTML table for Telegram.
 */
export function formatPnLTable(trades) {
  if (!trades || trades.length === 0) return "<i>No trades recorded.</i>";
  
  let html = "<b>📊 PnL Report Table</b>\n<pre>";
  html += "Token      | PnL %  | Result\n";
  html += "-----------|--------|-------\n";
  
  trades.slice(-10).forEach(t => {
    const symbol = (t.symbol || "???").padEnd(10).slice(0, 10);
    const pnl = (t.pnl_pct >= 0 ? "+" : "") + t.pnl_pct.toFixed(2).padEnd(6);
    const result = t.win ? "WIN 🟢" : "LOSS 🔴";
    html += `${symbol} | ${pnl} | ${result}\n`;
  });
  
  html += "</pre>";
  return html;
}

/**
 * Start polling for incoming messages.
 */
export function startPolling(onMessage) {
  if (!isEnabled() || _pollingActive) return;
  _pollingActive = true;
  console.log("[Telegram] Polling started...");

  const poll = async () => {
    if (!_pollingActive) return;
    try {
      const res = await fetch(`${API_BASE}/getUpdates?offset=${_lastOffset + 1}&timeout=30`);
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
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
    setTimeout(poll, 1000);
  };
  poll();
}

export function stopPolling() {
  _pollingActive = false;
}

export async function createLiveMessage(title, initialText) {
  if (!isEnabled()) return { toolStart: () => {}, toolFinish: () => {}, finalize: () => {} };

  let messageId = null;
  const header = `<b>${title}</b>\n`;
  let currentStatus = initialText;

  const res = await sendHTML(`${header}<i>${currentStatus}</i>`);
  messageId = res?.result?.message_id;

  return {
    toolStart: async (name) => {
      if (!messageId) return;
      currentStatus = `Executing: <code>${name}</code>...`;
      await editMessage(messageId, `${header}${currentStatus}`);
    },
    toolFinish: async (name, result, success) => {
      if (!messageId) return;
      const status = success ? "✅" : "❌";
      currentStatus = `${status} Finished: <code>${name}</code>`;
      await editMessage(messageId, `${header}${currentStatus}`);
    },
    finalize: async (finalText) => {
      if (!messageId) return;
      await editMessage(messageId, `${header}\n${finalText}`);
    }
  };
}

async function editMessage(messageId, text) {
  try {
    await fetch(`${API_BASE}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        message_id: messageId,
        text: text,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.error(`[Telegram] Edit failed: ${e.message}`);
  }
}

export function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  const msg = `🔄 <b>Swap Executed</b>\n` +
              `Input: ${amountIn} ${inputSymbol}\n` +
              `Output: ${amountOut || "?"} ${outputSymbol}\n` +
              `<a href="https://solscan.io/tx/${tx}">View on Solscan</a>`;
  return sendHTML(msg);
}

export function notifyDeploy({ symbol, amount, tx }) {
  const msg = `🚀 <b>New Position Opened</b>\n` +
              `Token: ${symbol}\n` +
              `Amount: ${amount} SOL\n` +
              `<a href="https://solscan.io/tx/${tx}">View on Solscan</a>`;
  return sendHTML(msg);
}

export function notifyClose({ symbol, pnl, tx }) {
  const emoji = pnl >= 0 ? "💰" : "📉";
  const msg = `${emoji} <b>Position Closed</b>\n` +
              `Token: ${symbol}\n` +
              `PnL: ${pnl >= 0 ? "+" : ""}${pnl}%\n` +
              `<a href="https://solscan.io/tx/${tx}">View on Solscan</a>`;
  return sendHTML(msg);
}
