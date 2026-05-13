/**
 * Trending Signal Source
 * Inspired by Charon (yunus-0x/charon) signals/trending.js
 *
 * Polls GMGN for trending tokens with volume/swap filters.
 * Marks results with _source_trending = true.
 */

import { log } from "../logger.js";
import { config } from "../config.js";

const GMGN_BASE = "https://gmgn.ai";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
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

/**
 * Fetch trending tokens from GMGN, filtered by volume and swap thresholds.
 *
 * @param {object} opts
 * @param {string}  opts.timeframe   - "1m" | "5m" | "1h"
 * @param {number}  opts.minVolume   - Minimum USD volume
 * @param {number}  opts.minSwaps    - Minimum swap count
 * @param {number}  opts.maxBundlePct - Filter if bundle rate > N%
 * @param {number}  opts.maxRugRatio  - Filter if rug ratio > N (0-1)
 * @param {number}  opts.limit        - Max results
 * @returns {Promise<Array>}
 */
export async function fetchTrending({
  timeframe = "1m",
  minVolume = 50_000,
  minSwaps = 100,
  maxBundlePct = 40,
  maxRugRatio = 0.5,
  limit = 20,
} = {}) {
  const url = `${GMGN_BASE}/defi/quotation/v1/rank/sol/swaps/${timeframe}?orderby=swaps&direction=desc&filters[]=renounced&filters[]=not_honeypot`;

  try {
    const data = await fetchJson(url);
    const rank = data.data?.rank || data.rank || [];

    return rank
      .filter(t => {
        const vol = t.volume || 0;
        const swaps = t.swaps || 0;
        const rug = t.rug_ratio || 0;
        const bundle = t.bundler_rate || t.bundle_pct || 0;
        return vol >= minVolume && swaps >= minSwaps && rug <= maxRugRatio && bundle <= maxBundlePct;
      })
      .slice(0, limit)
      .map(t => ({
        mint: t.address,
        symbol: t.symbol,
        name: t.name,
        price: t.price,
        mcap: t.market_cap,
        liquidity: t.liquidity,
        volume: t.volume,
        volume_1h: t.volume_1h,
        swaps: t.swaps,
        buys: t.buys,
        sells: t.sells,
        hot_level: t.hot_level,
        created_at: t.open_time,
        initial_mcap: t.base_market_cap,
        burn_ratio: t.burn_ratio,
        renounced: t.renounced,
        launchpad: t.launchpad,
        creator: t.creator,
        price_change_5m: t.price_change_5m,
        price_change_1h: t.price_change_1h,
        holder_count: t.holder_count,
        top_10_holder_pct: t.top_10_holder_rate ? t.top_10_holder_rate * 100 : null,
        rug_ratio: t.rug_ratio,
        bundler_pct: t.bundler_rate ? t.bundler_rate * 100 : null,
        ath_price: t.ath_price,
        // Signal source marker
        _source_trending: true,
      }));
  } catch (err) {
    log("signal_trending", `fetchTrending failed: ${err.message}`);
    return [];
  }
}
