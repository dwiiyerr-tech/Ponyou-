/**
 * Day Phase Trade Screener — module khusus untuk menemukan token
 * yang cocok untuk strategi day_phase_trading (swing 3-7 hari).
 *
 * Berbeda dari screening scalping (pair baru, timeframe 1m-5m),
 * screener ini mencari token mature yang sudah memasuki fase
 * Cooldown/Sideway setelah ATH dengan karakteristik:
 *   - FDV > $1M
 *   - Dip 50-70% dari ATH
 *   - Chart sideway 3-5 hari
 *   - Holder count stabil atau naik tipis
 *   - Naratif masih relevan
 *
 * Sumber data: DexScreener (free, no API key) + Helius (optional)
 * Runtime: dijalankan 1x per hari (cron), bukan per siklus screening
 */

import { log } from "../logger.js";
import { getTokenSecurityDetails } from "./dexscreener.js";

const DS_BASE = "https://api.dexscreener.com";

// ─── DexScreener fetch (reuse existing pattern) ─────────────────

async function fetchDS(url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 3000 * (i + 1))); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("DexScreener fetch failed");
}

// ─── Discovery: cari token mature via trending + search ──────────

/**
 * Fetch trending Solana tokens from DexScreener with 6h/24h window.
 * These are more mature than the 1m/5m tokens used for scalping.
 */
async function discoverMatureTokens() {
  const tokens = new Map();

  // Source 1: trending with 6h volume window
  try {
    const boosts = await fetchDS(`${DS_BASE}/token-boosts/top/v1`);
    const solana = (Array.isArray(boosts) ? boosts : []).filter(b => b.chainId === "solana");
    for (const b of solana.slice(0, 50)) {
      tokens.set(b.tokenAddress, { mint: b.tokenAddress, boost_amount: b.totalAmount || 0, source: "trending" });
    }
  } catch (e) {
    log("day_phase_discovery_warn", `trending fetch: ${e.message}`);
  }

  // Source 2: latest profiles (includes older tokens with updates)
  try {
    const profiles = await fetchDS(`${DS_BASE}/token-profiles/latest/v1`);
    const solana = (Array.isArray(profiles) ? profiles : []).filter(p => p.chainId === "solana");
    for (const p of solana.slice(0, 30)) {
      if (!tokens.has(p.tokenAddress)) {
        tokens.set(p.tokenAddress, { mint: p.tokenAddress, boost_amount: 0, source: "profile" });
      }
    }
  } catch (e) {
    log("day_phase_discovery_warn", `profiles fetch: ${e.message}`);
  }

  // Source 3: search for active Solana pairs (broad sweep)
  try {
    const searchQueries = ["sol", "ai", "meme", "bot", "cat", "dog", "pepe", "wif"];
    for (const q of searchQueries.slice(0, 4)) {
      try {
        const result = await fetchDS(`${DS_BASE}/latest/dex/search?q=${q}`);
        const pairs = (result?.pairs || []).filter(p => p.chainId === "solana");
        for (const p of pairs.slice(0, 10)) {
          const mint = p.baseToken?.address;
          if (mint && !tokens.has(mint)) {
            tokens.set(mint, { mint, boost_amount: 0, source: `search:${q}` });
          }
        }
      } catch { /* individual query may fail, continue */ }
    }
  } catch { /* best-effort */ }

  return [...tokens.values()];
}

// ─── Sideway Score Computation ───────────────────────────────────

/**
 * Compute how "sideway" a token is from price history.
 *
 * Returns a 0-100 score where:
 *   100 = perfectly flat for 5+ days
 *   60+ = acceptable sideway
 *   <40 = too volatile, not sideway
 */
function computeSidewayScore(priceHistory = []) {
  if (priceHistory.length < 3) return 0;

  const prices = priceHistory.map(p => Number(p.price || p.close || p.value || 0)).filter(v => v > 0);
  if (prices.length < 3) return 0;

  const mean = prices.reduce((s, v) => s + v, 0) / prices.length;
  if (mean === 0) return 0;

  // Coefficient of variation: stddev / mean
  const variance = prices.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / prices.length;
  const cv = Math.sqrt(variance) / mean;

  // Map CV to score: cv=0 → 100, cv=0.05 → 90, cv=0.10 → 70, cv=0.20 → 40, cv=0.30+ → 10
  const score = Math.max(0, Math.min(100, Math.round(100 - cv * 300)));
  return score;
}

/**
 * Detect sideway from DexScreener price change data (free, no OHLCV needed).
 * Uses price_change_5m, 1h, 6h, 24h to estimate volatility.
 */
function estimateSidewayFromDexData(token) {
  const changes = [
    Math.abs(token.price_change_5m || 0),
    Math.abs(token.price_change_1h || 0),
    Math.abs(token.price_change_6h || 0),
    Math.abs(token.price_change_24h || 0),
  ].filter(v => Number.isFinite(v));

  if (changes.length < 2) return 0;

  // Average absolute change per timeframe: lower = more sideway
  const avgChange = changes.reduce((s, v) => s + v, 0) / changes.length;

  // Map: 0% avg change → 100, 2% → 85, 5% → 60, 10% → 30, 20%+ → 5
  return Math.max(0, Math.min(100, Math.round(100 - avgChange * 5)));
}

// ─── Holder Trend Detection ──────────────────────────────────────

/**
 * Estimate holder trend by comparing current holders vs.
 * expected distribution. Returns { stable, rising, falling, score }.
 * Score 0-100: 100 = stable/rising, 0 = fast decline.
 */
function assessHolderTrend(token, security) {
  const holders = security?.holders || [];
  const holderCount = security?.holders?.length || 0;

  if (holderCount < 50) return { trend: "unknown", score: 30, reason: "too few holders" };

  // Check concentrated supply as proxy for distribution health
  const top10Pct = security?.rug_signals?.top10_concentration_pct || 0;
  const supplyConcentrated = security?.rug_signals?.supply_concentrated || false;

  if (supplyConcentrated && top10Pct > 50) {
    return { trend: "falling", score: 15, reason: `top10 holds ${top10Pct.toFixed(0)}% — concentrated distribution` };
  }

  if (top10Pct > 40) {
    return { trend: "unstable", score: 40, reason: `top10 holds ${top10Pct.toFixed(0)}%` };
  }

  // Check for dust holders (out of SOL = can't trade = dead weight)
  const dustCount = holders.filter(h => (h.sol_balance || 0) < 0.1).length;
  const dustRatio = holders.length > 0 ? dustCount / holders.length : 0;

  if (dustRatio > 0.5) {
    return { trend: "falling", score: 25, reason: `${(dustRatio * 100).toFixed(0)}% holders are dust — distribution declining` };
  }

  if (dustRatio > 0.3) {
    return { trend: "unstable", score: 50, reason: `${(dustRatio * 100).toFixed(0)}% dust holders` };
  }

  return { trend: "stable", score: 75, reason: "holder distribution looks healthy" };
}

// ─── Main Screening Function ─────────────────────────────────────

/**
 * Run full day-phase screening pipeline.
 *
 * @returns {Object} { watchlist: Array, stats: Object }
 */
export async function screenDayPhaseTokens({ minFdv = 1_000_000, maxDipPct = 70, minDipPct = 40, minSidewayScore = 50, minHolders = 500 } = {}) {
  log("day_phase", "Starting day-phase screening cycle...");
  const discovered = await discoverMatureTokens();
  log("day_phase", `Discovered ${discovered.length} mature token candidates`);

  if (discovered.length === 0) {
    return { watchlist: [], stats: { discovered: 0, screened: 0, passed: 0 } };
  }

  // Batch-fetch pair data (batches of 30 — DexScreener limit)
  const watchlist = [];
  let screened = 0;

  for (let i = 0; i < discovered.length; i += 30) {
    const batch = discovered.slice(i, i + 30);
    const addresses = batch.map(t => t.mint).join(",");

    let pairs = [];
    try {
      const data = await fetchDS(`${DS_BASE}/latest/dex/tokens/${addresses}`);
      pairs = (data?.pairs || []).filter(p => p.chainId === "solana");
    } catch (e) {
      log("day_phase_warn", `Batch fetch failed for ${batch.length} tokens: ${e.message}`);
      continue;
    }

    for (const pair of pairs) {
      screened++;
      const token = pair.baseToken;
      const mint = token?.address;
      if (!mint) continue;

      // ── Quick pre-filters (free, no RPC) ──────────────────
      const fdv = pair.fdv || pair.marketCap || 0;
      if (fdv < minFdv) continue;

      const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      const ageDays = ageMs / (24 * 3600 * 1000);
      if (ageDays < 3) continue; // must be 3+ days old

      // ATH distance estimation from price changes.
      // Prefer d7 (actual 7-day change). Only fall back to h24 when d7
      // is explicitly non-null — a missing d7 field should not silently
      // use 24h data, which would hide older dips.
      const priceChange7d = pair.priceChange?.d7;
      const dipFromAth = priceChange7d != null
        ? Number(priceChange7d)
        : pair.priceChange?.h24 != null ? Number(pair.priceChange.h24) : 0;
      if (dipFromAth > -minDipPct) continue;   // not dipped enough
      if (dipFromAth < -maxDipPct) continue;    // too dead

      // Sideway estimation from DexScreener data
      const sidewayScore = estimateSidewayFromDexData({
        price_change_5m: pair.priceChange?.m5 || 0,
        price_change_1h: pair.priceChange?.h1 || 0,
        price_change_6h: pair.priceChange?.h6 || 0,
        price_change_24h: pair.priceChange?.h24 || 0,
      });
      if (sidewayScore < minSidewayScore) continue;

      // ── Deeper analysis (needs RPC) ──────────────────────
      let security = null;
      let holderAssessment = { trend: "unknown", score: 0, reason: "not checked" };
      try {
        security = await getTokenSecurityDetails({ mint });
        holderAssessment = assessHolderTrend(token, security);
      } catch (e) {
        log("day_phase_warn", `Security fetch failed for ${token.symbol}: ${e.message}`);
      }

      const holderCount = security?.holders?.length || 0;
      if (holderCount < minHolders && holderCount > 0) continue;

      // ── Build watchlist entry ────────────────────────────
      const liquidity = pair.liquidity?.usd || 0;
      const volume24h = pair.volume?.h24 || 0;
      const swaps24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);

      // Composite score: sideway(35%) + holder health(30%) + liquidity depth(20%) + volume(15%)
      const liquidityScore = liquidity > 50000 ? 100 : liquidity > 10000 ? 70 : liquidity > 5000 ? 40 : 10;
      const volumeScore = volume24h > 100000 ? 100 : volume24h > 25000 ? 65 : volume24h > 5000 ? 30 : 5;
      const compositeScore = Math.round(
        sidewayScore * 0.35 +
        holderAssessment.score * 0.30 +
        liquidityScore * 0.20 +
        volumeScore * 0.15
      );

      watchlist.push({
        mint,
        symbol: token.symbol,
        name: token.name,
        fdv,
        price_usd: parseFloat(pair.priceUsd || 0),
        liquidity_usd: liquidity,
        volume_24h_usd: volume24h,
        swaps_24h: swaps24h,
        age_days: parseFloat(ageDays.toFixed(1)),
        dip_from_ath_pct: parseFloat(dipFromAth.toFixed(1)),
        sideway_score: sidewayScore,
        holder_count: holderCount,
        holder_trend: holderAssessment.trend,
        holder_trend_score: holderAssessment.score,
        holder_trend_reason: holderAssessment.reason,
        composite_score: compositeScore,
        launchpad: pair.dexId || "unknown",
        dex: pair.dexId,
        pair_address: pair.pairAddress,
        url: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
      });
    }
  }

  // Sort by composite score descending
  watchlist.sort((a, b) => b.composite_score - a.composite_score);

  const stats = {
    discovered: discovered.length,
    screened,
    passed: watchlist.length,
    high_confidence: watchlist.filter(w => w.composite_score >= 70).length,
    medium_confidence: watchlist.filter(w => w.composite_score >= 50 && w.composite_score < 70).length,
    low_confidence: watchlist.filter(w => w.composite_score < 50).length,
  };

  log("day_phase", `Screening complete: ${stats.passed}/${stats.screened} passed (${stats.high_confidence} high confidence)`);

  return { watchlist, stats };
}

/**
 * Determine if today is a valid entry day (weekend = Saturday/Sunday).
 * Entry dilakukan di weekend dengan DCA selama 2 hari.
 */
export function isWeekendEntryWindow() {
  const day = new Date().getUTCDay();
  return day === 6 || day === 0; // 6=Saturday, 0=Sunday
}

/**
 * Determine if today is a valid exit day (Tuesday-Thursday).
 * Exit dilakukan saat weekday volume naik.
 */
export function isWeekdayExitWindow() {
  const day = new Date().getUTCDay();
  return day >= 2 && day <= 4; // 2=Tue, 3=Wed, 4=Thu
}

/**
 * Format watchlist for Telegram notification.
 */
export function formatWatchlistForNotification(watchlist, limit = 10) {
  if (watchlist.length === 0) return "No day-phase candidates found.";

  const top = watchlist.slice(0, limit);
  const lines = top.map((w, i) => {
    const confidence = w.composite_score >= 70 ? "🟢" : w.composite_score >= 50 ? "🟡" : "🟠";
    return `${confidence} #${i + 1} <b>${w.symbol}</b> · FDV $${(w.fdv / 1e6).toFixed(1)}M · Dip ${w.dip_from_ath_pct}% · Sideway ${w.sideway_score}/100 · ${w.holder_count} holders`;
  });

  const entry = isWeekendEntryWindow() ? "✅ WEEKEND — entry window OPEN" : "⏳ Entry window: Sat-Sun";
  const exit = isWeekdayExitWindow() ? "📤 Weekday exit window OPEN" : "";

  return [
    `<b>Day Phase Trade Watchlist</b> (${watchlist.length} candidates)`,
    entry,
    exit,
    "",
    ...lines,
  ].filter(Boolean).join("\n");
}
