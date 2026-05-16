/**
 * Market Rug Harvester — proactively scan currently-trending tokens for
 * pumped-then-dumped patterns, then feed them into rug memory + pattern engine.
 *
 * Unlike processObservations (which only sees tokens Ponyou itself observed),
 * this scans the broader market — so Ponyou can learn from rugs that happened
 * to other traders without first losing money on them.
 *
 * Pipeline:
 *   1. Pull trending tokens (DexScreener)
 *   2. Compute peak-to-current drop via DexScreener pair price changes
 *   3. For each token matching the rug profile, fetch live security signals
 *   4. recordRug(...) — auto-triggers learnPatterns via the lessons.js loop
 */

import { log } from "../logger.js";
import { discoverTokens, getTokenSecurityDetails } from "./dexscreener.js";
import { recordRug } from "../lessons.js";

const DS_BASE = "https://api.dexscreener.com";

async function fetchPair(mint) {
  try {
    const res = await fetch(`${DS_BASE}/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  } catch {
    return null;
  }
}

/**
 * Determine if a token's price action fits the pumped-then-dumped rug profile.
 * Uses DexScreener priceChange windows: m5, h1, h6, h24.
 *
 * A rug typically looks like:
 *   - peak window (h6 or h24) shows +200% or more
 *   - more recent window (m5 or h1) shows -50% or more
 *   - liquidity below $20k now (LP drained)
 */
function detectRugProfile(pair) {
  if (!pair) return { is_rug: false, reason: "no pair data" };

  const pc = pair.priceChange || {};
  const liquidity = pair.liquidity?.usd || 0;

  const pumpedH6  = (pc.h6  || 0) > 200;
  const pumpedH24 = (pc.h24 || 0) > 200;
  const dumpedM5  = (pc.m5  || 0) < -50;
  const dumpedH1  = (pc.h1  || 0) < -60;
  const dumpedH6  = (pc.h6  || 0) < -70;

  const pumped = pumpedH6 || pumpedH24;
  const dumped = dumpedM5 || dumpedH1 || dumpedH6;

  if (pumped && dumped) {
    return {
      is_rug: true,
      reason: `pumped (h6:${pc.h6}% h24:${pc.h24}%) → dumped (m5:${pc.m5}% h1:${pc.h1}% h6:${pc.h6}%)`,
      severity: "pump_dump",
    };
  }

  // Liquidity drain pattern: liquidity collapsed AND price down hard
  if (liquidity < 5000 && (pc.h24 || 0) < -80) {
    return {
      is_rug: true,
      reason: `liquidity drained ($${liquidity.toFixed(0)}) + price ${pc.h24}% h24`,
      severity: "lp_drain",
    };
  }

  return { is_rug: false, reason: "normal price action" };
}

/**
 * Main entry. Scans trending tokens for rug profiles and feeds matches into rug memory.
 */
export async function harvestMarketRugs({
  source_tokens = 30,
  max_record = 10,
  include_security_fetch = true,
} = {}) {
  // Stage 1 — seed from trending
  const trending = await discoverTokens({ limit: source_tokens });
  if (trending.error || !trending.tokens?.length) {
    return { error: "no trending tokens", harvested: 0 };
  }

  log("rug_harvester", `Scanning ${trending.tokens.length} trending tokens for rug profiles...`);

  // Stage 2 — fetch pair data + detect rug profile
  const candidates = [];
  for (const t of trending.tokens) {
    const pair = await fetchPair(t.mint);
    const detection = detectRugProfile(pair);
    if (detection.is_rug) {
      candidates.push({
        mint: t.mint,
        symbol: t.symbol,
        reason: detection.reason,
        severity: detection.severity,
        liquidity_usd: pair.liquidity?.usd || 0,
        price_change: pair.priceChange,
      });
    }
    await new Promise(r => setTimeout(r, 150));
  }

  log("rug_harvester", `Found ${candidates.length} rug-profile tokens`);

  // Stage 3 — fetch security + recordRug (which auto-triggers learnPatterns)
  const harvested = [];
  for (const c of candidates.slice(0, max_record)) {
    try {
      let rug_signals = {};
      if (include_security_fetch) {
        const sec = await getTokenSecurityDetails({ mint: c.mint });
        rug_signals = sec?.rug_signals || {};
      }

      recordRug({
        mint: c.mint,
        symbol: c.symbol,
        creator: null,  // not easy to derive without deeper on-chain trace
        launchpad: null,
        rug_signals,
        pattern_notes: `market-harvested: ${c.reason}`,
      });

      harvested.push({
        symbol: c.symbol,
        mint: c.mint,
        severity: c.severity,
        reason: c.reason,
        signals_collected: Object.keys(rug_signals).length,
      });

      log("rug_harvester", `Recorded rug: ${c.symbol} (${c.severity})`);
    } catch (e) {
      log("rug_harvester_warn", `Failed to record ${c.symbol}: ${e.message}`);
    }
  }

  return {
    scanned: trending.tokens.length,
    candidates_detected: candidates.length,
    harvested: harvested.length,
    rugs: harvested,
    note: harvested.length > 0 ? "Patterns may have been auto-learned — check list_rug_patterns" : "No qualifying rugs this scan",
  };
}
