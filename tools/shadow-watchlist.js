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
 *   shadow:winner_missed  — skipped token mooned anyway → free learning
 *   shadow:stats          — periodic watchlist health report
 *
 * Darwin feedback: every terminal outcome (rugged / mooned) also updates the
 * signal-component weights via updateDarwinWeights, using the components that
 * voted for the token at screening time (active_signals). This is what lets
 * Ponyou learn from the whole market — dozens of watched candidates per day —
 * instead of only its own handful of closed trades.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";
import { getTokenMarketInfo } from "./dexscreener.js";
import { agentBus } from "../agents/agent-bus.js";
import { log } from "../logger.js";
import { updateDarwinWeights } from "../lessons.js";
import { triggeredSignals } from "../signal-aggregator.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE  = path.join(__dirname, "../shadow-watchlist.json");

const WATCH_DURATION_MS  = 6 * 60 * 60 * 1000;   // 6 hours max observation
const CHECK_INTERVAL_MS  = 30 * 60 * 1000;         // check every 30 min
const RUG_DROP_THRESHOLD = 0.70;                    // price dropped 70%+ = rug
const RUG_LIQ_THRESHOLD  = 200;                     // liquidity < $200 = LP pulled
const MAX_WATCHLIST_SIZE = 200;                      // cap — no unbounded growth
const MISSED_WINNER_PCT  = 50;                       // peak ≥ +50% from entry = mooned

// Major tokens / stablecoins / quote assets are not memecoin candidates. Their
// SOL-denominated prices fluctuate with SOL/USD, causing false "rug crash" alerts
// (e.g. USDC flagged at -78%). Skip by mint — spoof-proof.
const SHADOW_EXCLUDED_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

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
  if (SHADOW_EXCLUDED_MINTS.has(token.mint)) return;

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
      // GMGN row-risk fields — lets experiment #1's hard-reject review
      // correlate skipped-token OUTCOMES (rugged/mooned) with rug_ratio.
      gmgn_rug_ratio: token._gmgn_risk?.rug_ratio ?? null,
      gmgn_honeypot:  token._gmgn_risk?.is_honeypot ?? null,
      // Darwinian genome: which signal components voted for this token. The
      // terminal outcome (rugged/mooned) feeds back into their weights.
      active_signals: Array.isArray(token.active_signals) && token.active_signals.length > 0
        ? token.active_signals
        : triggeredSignals(token.signal),
      peak_price:    token.price || token.priceUsd || token.price_usd || null,
      added_at:      Date.now(),
      expires_at:    Date.now() + WATCH_DURATION_MS,
      checks:        [],
      status:        "watching", // watching | rugged | survived | mooned
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

export async function checkAll() {
  if (_running) return;
  _running = true;

  // SW-2: serialize the whole check + write under the same lock as
  // shadowWatch so the interval cycle and external add-to-watchlist
  // calls cannot interleave a partial write.
  // SW-3: reset _running in finally and swallow errors. load()/save()/the
  // lock can throw OUTSIDE the per-token try/catch; without this a single
  // throw wedged _running=true forever (watchlist silently stops checking)
  // and surfaced as an unhandled rejection from the unawaited interval.
  try {
    return await withFileLock(WATCHLIST_FILE, async () => {
  const data = load();
  const now  = Date.now();
  let rugsFound = 0;
  let expired   = 0;

  const active = data.tokens.filter(t => t.status === "watching");

  for (const token of active) {
    // Expire old tokens: classify by what the price DID during the window.
    // A skipped token that mooned is as much a lesson as one that rugged —
    // without it, darwinian selection only ever sees the downside.
    if (now > token.expires_at) {
      const peakGain = (token.entry_price > 0 && token.peak_price > 0)
        ? ((token.peak_price - token.entry_price) / token.entry_price) * 100
        : 0;
      if (peakGain >= MISSED_WINNER_PCT) {
        token.status = "mooned";
        token.peak_gain_pct = parseFloat(peakGain.toFixed(1));
        _emitWinnerMissed(token);
        _feedDarwin(token.active_signals, peakGain);
      } else {
        token.status = "survived"; // flat/mild — neutral, no darwin signal
      }
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

      // Track the high-water mark for missed-winner classification at expiry.
      if (currentPrice > (token.peak_price || 0)) token.peak_price = currentPrice;

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
    mooned: data.tokens.filter(t => t.status === "mooned").length,
    rugs_this_cycle: rugsFound,
    expired_this_cycle: expired,
  };

  if (rugsFound > 0 || active.length > 0) {
    log("shadow_watchlist", `Cycle done — ${stats.watching} watching, ${rugsFound} rugs found this pass`);
    agentBus.emit("shadow:stats", stats);
  }
  }); // end withFileLock
  } catch (e) {
    log("shadow_watchlist_error", `checkAll failed: ${e.message}`);
  } finally {
    _running = false;
  }
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
  // Skipping this token was the RIGHT call — decay the components that
  // voted for it so the same vote pattern scores lower next time.
  _feedDarwin(token.active_signals, -100);
}

function _emitWinnerMissed(token) {
  log("shadow_watchlist", `WINNER MISSED (no buy): ${token.symbol} peaked +${token.peak_gain_pct}% — source=${token.hunt_source}`);
  agentBus.emit("shadow:winner_missed", {
    mint:          token.mint,
    symbol:        token.symbol,
    name:          token.name,
    hunt_source:   token.hunt_source,
    social_source: token.social_source,
    peak_gain_pct: token.peak_gain_pct,
    signal_score:  token.signal_score,
    rug_score:     token.rug_score,
    timestamp:     Date.now(),
  });
}

/**
 * Feed a shadow outcome into the darwin signal weights. Positive pnl boosts
 * the components that voted for the token, negative decays them. Best-effort:
 * darwin failures must never break the watchlist cycle.
 */
function _feedDarwin(activeSignals, pnlPct) {
  if (config?.darwin?.enabled === false) return;
  if (!Array.isArray(activeSignals) || activeSignals.length === 0) return;
  try {
    updateDarwinWeights(activeSignals, pnlPct, config?.darwin || {});
  } catch (e) {
    log("shadow_watchlist_error", `darwin update failed: ${e.message}`);
  }
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
    mooned:   tokens.filter(t => t.status === "mooned").length,
    by_source: Object.fromEntries(
      [...new Set(tokens.map(t => t.hunt_source))].map(src => [
        src,
        {
          total:  tokens.filter(t => t.hunt_source === src).length,
          rugged: tokens.filter(t => t.hunt_source === src && t.status === "rugged").length,
          mooned: tokens.filter(t => t.hunt_source === src && t.status === "mooned").length,
        },
      ])
    ),
  };
}
