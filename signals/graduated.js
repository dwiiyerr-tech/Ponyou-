/**
 * Graduated Token Signal Source
 * Inspired by Charon (yunus-0x/charon) signals/graduated.js
 *
 * Polls for tokens that have "graduated" from pump.fun or similar launchpads
 * (completed bonding curve → listed on Raydium/Orca).
 * Marks results with _source_graduated = true.
 */

import { log } from "../logger.js";

const GMGN_BASE = "https://gmgn.ai";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
let _uaIdx = 0;
function ua() { return USER_AGENTS[_uaIdx++ % USER_AGENTS.length]; }

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": ua(),
      "Accept": "application/json",
      "Referer": "https://gmgn.ai/",
      "Origin": "https://gmgn.ai",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Dedup cache: avoid re-processing same token within window ─

const _seenMints = new Map();
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isDuplicate(mint) {
  const now = Date.now();
  if (_seenMints.has(mint)) {
    if (now - _seenMints.get(mint) < DEDUP_WINDOW_MS) return true;
  }
  _seenMints.set(mint, now);
  // Cleanup old entries
  for (const [m, t] of _seenMints) {
    if (now - t > DEDUP_WINDOW_MS) _seenMints.delete(m);
  }
  return false;
}

/**
 * Fetch recently graduated tokens (pump.fun → Raydium).
 *
 * @param {object} opts
 * @param {number}  opts.minVolume   - Minimum 24h volume (USD)
 * @param {number}  opts.minMcap     - Minimum market cap
 * @param {number}  opts.limit       - Max results
 * @param {boolean} opts.dedup       - Skip mints seen in last 5 min
 * @returns {Promise<Array>}
 */
export async function fetchGraduated({
  minVolume = 50_000,
  minMcap = 50_000,
  limit = 10,
  dedup = true,
} = {}) {
  // GMGN graduated endpoint: tokens that completed bonding curve
  const url = `${GMGN_BASE}/defi/quotation/v1/rank/sol/graduated?orderby=market_cap&direction=desc&limit=50`;

  try {
    const data = await fetchJson(url);
    const coins = data.data?.coins || data.coins || [];

    const results = [];
    for (const t of coins) {
      const mint = t.address;
      if (!mint) continue;
      if (dedup && isDuplicate(mint)) continue;
      if ((t.volume || 0) < minVolume) continue;
      if ((t.market_cap || 0) < minMcap) continue;
      if (results.length >= limit) break;

      results.push({
        mint,
        symbol: t.symbol,
        name: t.name,
        price: t.price,
        mcap: t.market_cap,
        liquidity: t.liquidity,
        volume: t.volume,
        holder_count: t.holder_count,
        created_at: t.open_time,
        initial_mcap: t.base_market_cap || t.initial_market_cap,
        launchpad: t.launchpad || "pump.fun",
        creator: t.creator,
        rug_ratio: t.rug_ratio,
        bundler_pct: t.bundler_rate ? t.bundler_rate * 100 : null,
        top_10_holder_pct: t.top_10_holder_rate ? t.top_10_holder_rate * 100 : null,
        ath_price: t.ath_price,
        graduated_at: t.graduated_at || t.created_at,
        // Signal source marker
        _source_graduated: true,
      });
    }

    log("signal_graduated", `fetchGraduated: ${results.length} tokens`);
    return results;
  } catch (err) {
    log("signal_graduated", `fetchGraduated failed: ${err.message}`);
    return [];
  }
}
