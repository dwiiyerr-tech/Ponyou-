/**
 * Shadow Watchlist — free learning without buying.
 *
 * Tokens that PASS the trash filter but are NOT bought (signal too low,
 * kelly skip, workflow shadow/skip) get parked here. Their price is
 * monitored every 30 min for up to 6 hours.
 *
 * If price drops >70% within the observation window → classified as rug.
 * The learning-agent is notified via agentBus so it can update patterns
 * without Ponyou ever having traded the token.
 *
 * If liquidity disappears (< $200) → classified as liquidity pull (also rug).
 *
 * Bus events emitted:
 *   shadow:rug_detected   — token rugged without being bought → free learning
 *   shadow:stats          — periodic watchlist health report
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";
import { getTokenMarketInfo } from "./dexscreener.js";
import { agentBus } from "../agents/agent-bus.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE  = path.join(__dirname, "../shadow-watchlist.json");

const WATCH_DURATION_MS  = 6 * 60 * 60 * 1000;   // 6 hours max observation
const CHECK_INTERVAL_MS  = 30 * 60 * 1000;         // check every 30 min
const RUG_DROP_THRESHOLD = 0.70;                    // price dropped 70%+ = rug
const RUG_LIQ_THRESHOLD  = 200;                     // liquidity < $200 = LP pulled
const MAX_WATCHLIST_SIZE = 200;                      // cap — no unbounded growth

let _timer = null;
let _running = false;

// ─── Persistence ────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(WATCHLIST_FILE)) return { tokens: [] };
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8")); }
  catch { return { tokens: [] }; }
}

function save(data) {
  atomicWriteJson(WATCHLIST_FILE, data);
}

// ─── Add token to watchlist ─────────────────────────────────────────────────

/**
 * Called by screening pipeline when a token is NOT bought.
 * @param {Object} token - scored candidate from runScreeningCycle
 */
// SW-2: lock the watchlist file. shadowWatch can fire from the screening
// pipeline concurrently with checkAll (the interval), so two writes can
// race and one set of changes is lost. The lock is cheap (in-process).
export function shadowWatch(token) {
  if (!token?.mint) return;

  return withFileLock(WATCHLIST_FILE, async () => {
    const data = load();
    // Skip if already watching this mint
    if (data.tokens.find(t => t.mint === token.mint)) return;

    const entry = {
      mint:          token.mint,
      symbol:        token.symbol || "UNKNOWN",
      name:          token.name   || "",
      hunt_source:   token._hunt_source || token._source || "unknown",
      social_source: token._social_source || null,
      entry_price:   token.price || token.priceUsd || token.price_usd || null,
      entry_liq:     token.liquidity || null,
      signal_score:  token.signal?.signal_score ?? null,
      rug_score:     token.rug_score ?? null,
      added_at:      Date.now(),
      expires_at:    Date.now() + WATCH_DURATION_MS,
      checks:        [],
      status:        "watching", // watching | rugged | survived | expired
    };

    data.tokens.push(entry);

    // Cap size — drop oldest first
    if (data.tokens.length > MAX_WATCHLIST_SIZE) {
      data.tokens = data.tokens.slice(-MAX_WATCHLIST_SIZE);
    }

    save(data);
    log("shadow_watchlist", `Watching ${token.symbol} (${token.mint.slice(0, 8)}) source=${entry.hunt_source}`);
  });
}

// ─── Price check cycle ──────────────────────────────────────────────────────

async function checkAll() {
  if (_running) return;
  _running = true;

  // SW-2: serialize the whole check + write under the same lock as
  // shadowWatch so the interval cycle and external add-to-watchlist
  // calls cannot interleave a partial write.
  return withFileLock(WATCHLIST_FILE, async () => {
  const data = load();
  const now  = Date.now();
  let rugsFound = 0;
  let expired   = 0;

  const active = data.tokens.filter(t => t.status === "watching");

  for (const token of active) {
    // Expire old tokens
    if (now > token.expires_at) {
      token.status = "survived"; // survived the window — probably not a rug
      expired++;
      continue;
    }

    // Fetch current price
    try {
      const info = await getTokenMarketInfo({ mint: token.mint });
      if (info.error) {
        // Token disappeared from DexScreener entirely → LP pulled
        token.checks.push({ ts: now, status: "not_found" });
        if (token.checks.filter(c => c.status === "not_found").length >= 2) {
          // Two consecutive not-founds = confirmed LP pull
          token.status = "rugged";
          token.rug_type = "lp_removed";
          token.rug_detected_at = now;
          rugsFound++;
          _emitRug(token, "LP removed — token vanished from DexScreener");
        }
        continue;
      }

      const currentPrice = info.price || 0;
      const currentLiq   = info.liquidity || 0;
      const checkResult  = { ts: now, price: currentPrice, liq: currentLiq };

      // Liquidity pull
      if (currentLiq < RUG_LIQ_THRESHOLD && (token.entry_liq || 0) > 1000) {
        token.status = "rugged";
        token.rug_type = "lp_pull";
        token.rug_detected_at = now;
        token.checks.push({ ...checkResult, status: "lp_pull" });
        rugsFound++;
        _emitRug(token, `LP pulled — liquidity $${currentLiq.toFixed(0)} (was $${(token.entry_liq || 0).toFixed(0)})`);
        continue;
      }

      // Price crash
      if (token.entry_price && token.entry_price > 0 && currentPrice > 0) {
        const dropPct = (token.entry_price - currentPrice) / token.entry_price;
        if (dropPct >= RUG_DROP_THRESHOLD) {
          token.status = "rugged";
          token.rug_type = "price_crash";
          token.rug_detected_at = now;
          token.price_drop_pct = parseFloat((dropPct * 100).toFixed(1));
          token.checks.push({ ...checkResult, status: "rugged", drop_pct: token.price_drop_pct });
          rugsFound++;
          _emitRug(token, `Price crashed ${token.price_drop_pct}% — ${token.entry_price?.toFixed(8)} → ${currentPrice.toFixed(8)}`);
          continue;
        }
      }

      token.checks.push({ ...checkResult, status: "ok" });
      // Keep checks array lean
      if (token.checks.length > 12) token.checks = token.checks.slice(-12);

    } catch (e) {
      log("shadow_watchlist_error", `Check failed for ${token.symbol}: ${e.message}`);
    }
  }

  save(data);

  const stats = {
    total: data.tokens.length,
    watching: data.tokens.filter(t => t.status === "watching").length,
    rugged: data.tokens.filter(t => t.status === "rugged").length,
    survived: data.tokens.filter(t => t.status === "survived").length,
    rugs_this_cycle: rugsFound,
    expired_this_cycle: expired,
  };

  if (rugsFound > 0 || active.length > 0) {
    log("shadow_watchlist", `Cycle done — ${stats.watching} watching, ${rugsFound} rugs found this pass`);
    agentBus.emit("shadow:stats", stats);
  }

  _running = false;
  }); // end withFileLock
}

function _emitRug(token, reason) {
  log("shadow_watchlist", `RUG (no buy): ${token.symbol} — ${reason}`);
  agentBus.emit("shadow:rug_detected", {
    mint:         token.mint,
    symbol:       token.symbol,
    name:         token.name,
    hunt_source:  token.hunt_source,
    social_source: token.social_source,
    rug_type:     token.rug_type,
    reason,
    signal_score: token.signal_score,
    rug_score:    token.rug_score,
    timestamp:    Date.now(),
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function startShadowWatchlist() {
  if (_timer) return;
  _timer = setInterval(checkAll, CHECK_INTERVAL_MS);
  // First check after 5 min so startup isn't hammered
  setTimeout(checkAll, 5 * 60 * 1000);
  log("shadow_watchlist", `Started — checking every ${CHECK_INTERVAL_MS / 60000}min, max ${WATCH_DURATION_MS / 3600000}h window`);
}

export function stopShadowWatchlist() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function getShadowStats() {
  const data = load();
  const tokens = data.tokens || [];
  return {
    total:    tokens.length,
    watching: tokens.filter(t => t.status === "watching").length,
    rugged:   tokens.filter(t => t.status === "rugged").length,
    survived: tokens.filter(t => t.status === "survived").length,
    by_source: Object.fromEntries(
      [...new Set(tokens.map(t => t.hunt_source))].map(src => [
        src,
        {
          total:  tokens.filter(t => t.hunt_source === src).length,
          rugged: tokens.filter(t => t.hunt_source === src && t.status === "rugged").length,
        },
      ])
    ),
  };
}
