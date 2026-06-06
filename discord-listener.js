/**
 * Discord Listener — monitors Discord channels for token calls.
 *
 * Uses raw Discord REST API (no discord.js dependency needed) with
 * long-polling. Free, $0 cost. Requires:
 *   DISCORD_BOT_TOKEN   — Discord bot token (create at discord.com/developers)
 *   DISCORD_CHANNEL_IDS — comma-separated channel IDs to monitor
 *
 * Optional:
 *   DISCORD_WEBHOOK_SECRET — if you use incoming webhooks instead of bot
 *
 * All messages are filtered through social-trash-gate.js before being
 * written to social-signals.json.
 *
 * How to get a free bot token:
 *   1. discord.com/developers/applications → New Application
 *   2. Bot tab → Add Bot → copy token
 *   3. OAuth2 → URL Generator → bot + Read Message History
 *   4. Invite bot to your alpha server
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { gateSignal } from "./social-trash-gate.js";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { withFileLock } from "./atomic-write.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = __dirname;

const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN    || "";
const CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const DISCORD_API = "https://discord.com/api/v10";

const SIGNALS_FILE = resolve(ROOT, "social-signals.json");
const STATE_FILE   = resolve(ROOT, "discord-listener-state.json");

// Polling config
const POLL_INTERVAL  = 60_000;   // 60s — stays within Discord rate limits
const MAX_MSG_AGE_H  = 4;        // ignore messages older than 4h

let _timer  = null;
let _lastMsgIds = {};             // { channelId: lastMessageId }
const _channelNameCache = new Map(); // channelId -> channelName

// ─── State persistence ─────────────────────────────────────────

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveState(state) {
  try { atomicWriteJson(STATE_FILE, state); } catch {}
}

// ─── Discord REST ──────────────────────────────────────────────

async function discordGet(path) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${DISCORD_API}${path}`, {
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      const retry = parseFloat(res.headers.get("Retry-After") || "5");
      log("discord_listener_warn", `Rate limited, retry after ${retry}s`);
      await new Promise(r => setTimeout(r, (retry + 0.1) * 1000));
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── Call message parser ───────────────────────────────────────

// Common Discord call formats:
//   "🟢 $PEPE — buy now, target 3x"
//   "CALL: TOKEN entry 0.0002 target 0.001"
//   "🔥 SYMBOL | entry | TP1 | SL"
//   "$TOKEN contract: ..."

const CALL_INDICATORS = [
  /\bcall\b/i,
  /\bentry\b.*\b(sol|usd|usdc)\b/i,
  /\btp\d?\b.*\bsl\b/i,
  /🟢|🚀|💎|🔥|⚡/,
  /\b(buy|long|ape)\b.{0,30}\$?[A-Z]{2,10}/i,
  /\$[A-Z]{2,10}.{0,30}\b(gem|alpha|signal|call)\b/i,
];

const SYMBOL_RE = /\$([A-Z]{2,12})\b|(?:^|\s)([A-Z]{3,10})(?:\s|$)/g;

export function parseCallMessage(content = "", channelName = "", reactions = []) {
  const isCall = CALL_INDICATORS.some(re => re.test(content));
  if (!isCall && reactions.length === 0) return null;

  // Extract symbols
  const syms  = new Set();
  let m;
  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(content)) !== null) {
    const s = (m[1] || m[2] || "").toUpperCase();
    if (s.length >= 2 && s.length <= 12) syms.add(s);
  }

  if (syms.size === 0) return null;

  const totalReactions = reactions.reduce((sum, r) => sum + (r.count || 0), 0);

  return [...syms].map(sym => ({
    symbol:    sym,
    source:    "discord",
    channel:   channelName,
    text:      content.slice(0, 300),
    engagement: totalReactions,
    reactions: totalReactions,
    isCall:    isCall,
    postedAt:  new Date().toISOString(),
  }));
}

// ─── Channel poll ──────────────────────────────────────────────

// DL-1: Discord snowflake IDs are 64-bit numeric strings that can vary in
// digit count across boundaries (e.g. when Discord rolls into 19-digit IDs).
// Lexicographic `>` compares "999...999" > "1000...000" which is incorrect
// — the latter is newer. Compare as BigInt so length boundaries are handled.
function _snowflakeMax(a, b) {
  try {
    if (!a) return b;
    if (!b) return a;
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    // Bad input (non-numeric ID) — fall back to lexicographic to keep moving.
    return a > b ? a : b;
  }
}

async function pollChannel(channelId) {
  const after  = _lastMsgIds[channelId] || "";
  const path   = `/channels/${channelId}/messages?limit=50${after ? `&after=${after}` : ""}`;
  const msgs   = await discordGet(path);
  if (!Array.isArray(msgs) || msgs.length === 0) return [];

  // DL-1: BigInt-safe max so the cursor advances correctly past
  // length-boundary snowflakes.
  const newest = msgs.reduce((max, m) => _snowflakeMax(m.id, max), after);
  _lastMsgIds[channelId] = newest;

  // DL-2: fetch channel info ONCE per poll, not once per message.
  // Cache channel name to avoid repetitive REST API calls and rate limits.
  let channelName = _channelNameCache.get(channelId);
  if (!channelName) {
    const channelInfo = await discordGet(`/channels/${channelId}`);
    channelName = channelInfo?.name || channelId;
    _channelNameCache.set(channelId, channelName);
  }

  const signals = [];
  for (const msg of msgs) {
    // Skip old messages
    const ageH = (Date.now() - new Date(msg.timestamp).getTime()) / 3_600_000;
    if (ageH > MAX_MSG_AGE_H) continue;

    // Skip bots (unless it's a trusted call bot)
    if (msg.author?.bot) continue;

    const parsed = parseCallMessage(msg.content || "", channelName, msg.reactions || []);
    if (parsed) signals.push(...parsed);
  }

  return signals;
}

// ─── Write to social-signals.json ─────────────────────────────

// DL-3: lock the social-signals.json read-modify-write because three modules
// (this one, social-hunter.js, telegram.js handleCallMessage) all merge into
// the same cache file. Without coordination, concurrent runs would clobber
// each other's signals.
const SOURCES_CAP = 50; // DL-4: cap unbounded per-symbol sources growth

function mergeIntoCache(newSignals) {
  return withFileLock(SIGNALS_FILE, async () => {
    let cache = { updatedAt: null, signals: [] };
    try {
      if (existsSync(SIGNALS_FILE)) cache = JSON.parse(readFileSync(SIGNALS_FILE, "utf-8"));
    } catch {}

    const now = Date.now();
    const existing = new Map(
      (cache.signals || [])
        .filter(s => {
          if (!s.lastSeen) return false;
          const ageH = (now - new Date(s.lastSeen).getTime()) / 3_600_000;
          return ageH <= 24; // memory leak fix: evict signals older than 24h
        })
        .map(s => [s.symbol, s])
    );

    for (const sig of newSignals) {
      const gate = gateSignal(sig);
      if (!gate.pass) {
        log("discord_gate_block", `BLOCK ${sig.symbol} [discord] reason=${gate.reason}`);
        continue;
      }

      const prev = existing.get(sig.symbol) || {
        symbol: sig.symbol, mentions: 0, engagement: 0, sources: [],
        firstSeen: sig.postedAt, lastSeen: sig.postedAt,
      };

      const newSources = [...(prev.sources || []), `discord:${sig.channel}:${sig.engagement}`];
      existing.set(sig.symbol, {
        ...prev,
        source:    "discord",
        mentions:  (prev.mentions || 0) + 1,
        engagement: (prev.engagement || 0) + (sig.engagement || 0),
        // DL-4: keep only the most recent SOURCES_CAP entries to prevent
        // unbounded growth on long-lived popular symbols.
        sources:   newSources.length > SOURCES_CAP ? newSources.slice(-SOURCES_CAP) : newSources,
        lastSeen:  sig.postedAt,
        gate,
        // social score: discord calls are high signal
        socialScore: Math.min(100, (prev.socialScore || 0) + 25),
      });
    }

    cache.updatedAt = new Date().toISOString();
    cache.signals   = [...existing.values()];
    try { atomicWriteJson(SIGNALS_FILE, cache); } catch {}
  });
}

// ─── Main poll loop ────────────────────────────────────────────

async function poll() {
  if (!BOT_TOKEN) return;
  if (CHANNEL_IDS.length === 0) return;

  const allSignals = [];

  for (const channelId of CHANNEL_IDS) {
    try {
      const signals = await pollChannel(channelId);
      allSignals.push(...signals);
    } catch (e) {
      log("discord_listener_warn", `Channel ${channelId} error: ${e.message}`);
    }
  }

  if (allSignals.length > 0) {
    await mergeIntoCache(allSignals);
    log("discord_listener", `Processed ${allSignals.length} new messages from ${CHANNEL_IDS.length} channels`);
  }

  saveState(_lastMsgIds);
}

// ─── Public API ───────────────────────────────────────────────

export function isDiscordEnabled() {
  return !!(BOT_TOKEN && CHANNEL_IDS.length > 0);
}

export function startDiscordListener() {
  if (_timer) return;
  // Silent fail-soft — index.js prints a consolidated "optional features" summary.
  if (!BOT_TOKEN || CHANNEL_IDS.length === 0) return;

  _lastMsgIds = loadState();
  poll(); // immediate first run
  _timer = setInterval(poll, POLL_INTERVAL);
  log("discord_listener", `Listening on ${CHANNEL_IDS.length} channels, polling every ${POLL_INTERVAL / 1000}s`);
}

export function stopDiscordListener() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
