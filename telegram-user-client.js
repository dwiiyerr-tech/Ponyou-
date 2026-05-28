/**
 * Telegram User Client — MTProto login pakai akun asli, bukan bot.
 *
 * KEUNGGULAN vs Bot API:
 *   - Bisa monitor channel/grup APAPUN tanpa harus di-invite sebagai bot
 *   - Bisa baca channel privat yang user sudah join
 *   - Tidak perlu bot token — cukup API_ID + API_HASH + session
 *   - Tidak ada rate limit ketat seperti bot
 *
 * ENV yang dibutuhkan:
 *   TELEGRAM_API_ID     — dari my.telegram.org (angka, contoh: 1234567)
 *   TELEGRAM_API_HASH   — dari my.telegram.org (hex string)
 *   TELEGRAM_SESSION    — session string (kosong pertama kali, diisi setelah auth)
 *   TELEGRAM_GROUP_IDS  — sama seperti sebelumnya (comma-separated channel/group IDs)
 *                         atau "*" untuk monitor semua pesan masuk
 *
 * Auth pertama kali:
 *   npm run telegram:auth   → ikuti prompt (nomor HP → kode OTP → 2FA jika ada)
 *   Copy SESSION STRING ke .env sebagai TELEGRAM_SESSION
 *
 * Bot API (telegram.js) tetap dipakai untuk KIRIM notifikasi ke user.
 * File ini hanya untuk TERIMA sinyal dari channel/grup.
 */

import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { log } from "./logger.js";

const API_ID     = Number(process.env.TELEGRAM_API_ID   || 0);
const API_HASH   = process.env.TELEGRAM_API_HASH         || "";
const SESSION_STR = process.env.TELEGRAM_SESSION         || "";

const _RAW_IDS    = process.env.TELEGRAM_GROUP_IDS       || "";
const MONITOR_ALL = _RAW_IDS.trim() === "*";
// TUC-1: Telegram channel/supergroup IDs come in two equivalent forms:
//   raw:    "1234567890"          (internal channelId)
//   prefixed: "-1001234567890"    (Bot-API-style; supergroup/channel prefix)
// Normalize the whitelist to BOTH forms so the runtime match can use either
// representation the MTProto event delivers. Without this, the bot silently
// missed messages from any channel where the operator configured the form
// that didn't match the form the event surfaced.
function _normalizeTelegramIdForms(raw) {
  const out = new Set();
  for (const id of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    out.add(id);
    if (id.startsWith("-100")) {
      out.add(id.slice(4));            // also accept raw form
    } else if (/^\d+$/.test(id)) {
      out.add(`-100${id}`);             // also accept prefixed form
    }
  }
  return out;
}
const MONITOR_IDS = MONITOR_ALL ? new Set() : _normalizeTelegramIdForms(_RAW_IDS);

let _client    = null;
let _connected = false;

// ─── Status ───────────────────────────────────────────────────────────────

export function isUserClientEnabled() {
  return !!(API_ID && API_HASH && SESSION_STR);
}

export function isUserClientConnected() {
  return _connected;
}

export function getUserClientStatus() {
  return {
    enabled:      isUserClientEnabled(),
    connected:    _connected,
    monitor_mode: MONITOR_ALL ? "all" : `whitelist (${MONITOR_IDS.size} channels)`,
    has_session:  !!SESSION_STR,
    api_id_set:   !!API_ID,
    api_hash_set: !!API_HASH,
  };
}

// ─── Start user client ────────────────────────────────────────────────────

/**
 * @param {Function} onMessage - callback dipanggil tiap pesan baru
 *                               signature: async (msg: { text, chat, sender, date, _source }) => void
 */
export async function startUserClient({ onMessage } = {}) {
  if (!isUserClientEnabled()) {
    log("tg_user", "User client disabled — set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION");
    return false;
  }

  if (_client && _connected) {
    log("tg_user", "Already connected");
    return true;
  }

  try {
    const session = new StringSession(SESSION_STR);
    _client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries:  10,
      retryDelay:         2000,
      autoReconnect:      true,
      useWSS:             false,
    });

    await _client.connect();
    _connected = true;

    const me = await _client.getMe();
    log("tg_user", `Connected as ${me.firstName} ${me.lastName || ""} (@${me.username || me.phone})`);

    // ── Event handler untuk pesan masuk ──────────────────────────
    _client.addEventHandler(async (event) => {
      try {
        const msg   = event.message;
        if (!msg?.text) return;

        const chatId = String(msg.peerId?.channelId || msg.peerId?.chatId || msg.peerId?.userId || "");
        const chatTitle = msg.chat?.title || msg.chat?.username || chatId;

        // Filter: hanya proses channel/grup yang ada di whitelist, atau semua jika "*"
        if (!MONITOR_ALL && !MONITOR_IDS.has(chatId) && !MONITOR_IDS.has(`-100${chatId}`)) {
          return;
        }

        log("tg_user", `[${chatTitle}] ${msg.text.slice(0, 80)}`);

        if (typeof onMessage === "function") {
          await onMessage({
            text:       msg.text,
            caption:    msg.message || "",
            chat: {
              id:    chatId,
              title: chatTitle,
              type:  msg.chat?.className?.toLowerCase() || "channel",
            },
            sender:     msg.senderId ? String(msg.senderId) : null,
            date:       msg.date,
            message_id: msg.id,
            _source:    "telegram_user",
            // Kompatibel dengan format bot API agar parseCallSignal tetap bekerja
            _forwardedFrom: msg.fwdFrom?.fromId
              ? String(msg.fwdFrom.fromId?.channelId || msg.fwdFrom.fromId)
              : null,
          });
        }
      } catch (e) {
        log("tg_user_error", `Handler error: ${e.message}`);
      }
    }, new NewMessage({}));

    log("tg_user", `Listening — mode=${MONITOR_ALL ? "ALL" : `whitelist(${MONITOR_IDS.size})`}`);
    return true;
  } catch (e) {
    log("tg_user_error", `Connection failed: ${e.message}`);
    _connected = false;
    return false;
  }
}

// ─── Stop ─────────────────────────────────────────────────────────────────

export async function stopUserClient() {
  if (_client && _connected) {
    await _client.disconnect();
    _connected = false;
    // TUC-2: drop the disconnected handle so the next startUserClient
    // builds a fresh client instead of trying to reuse a dead socket.
    _client = null;
    log("tg_user", "Disconnected");
  }
}

// ─── Kirim pesan via user client (opsional, fallback) ─────────────────────
// Normalnya kirim tetap pakai Bot API (telegram.js). Ini hanya untuk edge case.

export async function sendViaUserClient(chatId, text) {
  if (!_client || !_connected) return false;
  try {
    await _client.sendMessage(chatId, { message: text });
    return true;
  } catch (e) {
    log("tg_user_error", `Send failed: ${e.message}`);
    return false;
  }
}
