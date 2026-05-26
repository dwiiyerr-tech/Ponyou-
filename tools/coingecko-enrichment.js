/**
 * CoinGecko Enrichment — Market data + social/community stats
 *
 * Free tier: 10-30 calls/min, no API key required.
 * Provides:
 *   - Trending coins (global + Solana-specific)
 *   - Coin metadata (description, social links, community stats)
 *   - Exchange listings (CEX presence)
 *   - Developer data (github activity, commit frequency)
 *   - Market data (price, volume, market cap, supply)
 *
 * Used to enrich the screening pipeline with data that DexScreener
 * doesn't provide: social signals, developer activity, CEX listings.
 */

import { log } from "../logger.js";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const CACHE_TTL_MS = 120_000; // 2 min cache
const REQUEST_DELAY_MS = 2100; // rate limit: ~30 calls/min = 1 per 2s

let _lastRequestAt = 0;
let _trendingCache = null;
let _trendingCacheTime = 0;
let _coinCache = new Map();

async function rateLimitedFetch(url) {
  const now = Date.now();
  const elapsed = now - _lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS - elapsed));
  }
  _lastRequestAt = Date.now();
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    log("coingecko_warn", `Fetch failed: ${e.message}`);
    return null;
  }
}

/**
 * Get trending coins from CoinGecko.
 * Returns top 15 trending + top 7 Solana-specific.
 */
export async function getTrendingCoins() {
  if (_trendingCache && (Date.now() - _trendingCacheTime) < CACHE_TTL_MS) {
    return _trendingCache;
  }

  const data = await rateLimitedFetch(`${COINGECKO_BASE}/search/trending`);
  if (!data) return { trending: [], solana: [] };

  const coins = (data.coins || []).map(c => ({
    id: c.item?.id || null,
    name: c.item?.name || null,
    symbol: c.item?.symbol || null,
    market_cap_rank: c.item?.market_cap_rank || null,
    thumb: c.item?.thumb || null,
    score: c.item?.score || null, // CoinGecko trending rank
  }));

  _trendingCache = {
    trending: coins.slice(0, 15),
    solana: [], // populated by getSolanaMarkets
    cachedAt: new Date().toISOString(),
  };
  _trendingCacheTime = Date.now();
  return _trendingCache;
}

/**
 * Get Solana-specific market data from CoinGecko.
 * Returns top movers by volume and price change.
 */
export async function getSolanaMarkets() {
  const params = new URLSearchParams({
    vs_currency: "usd",
    category: "solana-ecosystem",
    order: "volume_desc",
    per_page: "20",
    page: "1",
    sparkline: "false",
    price_change_percentage: "1h,24h",
  });

  const data = await rateLimitedFetch(`${COINGECKO_BASE}/coins/markets?${params}`);
  if (!Array.isArray(data)) return [];

  const markets = data.map(c => ({
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    current_price: c.current_price || 0,
    market_cap: c.market_cap || 0,
    market_cap_rank: c.market_cap_rank || null,
    total_volume: c.total_volume || 0,
    price_change_1h: c.price_change_percentage_1h_in_currency || 0,
    price_change_24h: c.price_change_percentage_24h_in_currency || 0,
    high_24h: c.high_24h || 0,
    low_24h: c.low_24h || 0,
    circulating_supply: c.circulating_supply || 0,
    total_supply: c.total_supply || 0,
    max_supply: c.max_supply || 0,
    ath: c.ath || 0,
    ath_change_pct: c.ath_change_percentage || 0,
    atl: c.atl || 0,
  }));

  // Update trending cache if available
  if (_trendingCache && !_trendingCache.solana.length) {
    _trendingCache.solana = markets.slice(0, 7);
  }

  return markets;
}

/**
 * Full coin enrichment from CoinGecko.
 * Includes: description, social links, community stats, developer data,
 * exchange listings (CEX), and market data.
 */
export async function enrichCoin({ coinId, symbol = null, retryOnSymbol = true } = {}) {
  if (!coinId && !symbol) return null;

  // Check cache
  const cacheKey = coinId || `symbol:${symbol?.toLowerCase()}`;
  if (_coinCache.has(cacheKey)) {
    const cached = _coinCache.get(cacheKey);
    if (Date.now() - cached.ts < CACHE_TTL_MS * 5) return cached.data;
  }

  let data;
  if (coinId) {
    data = await rateLimitedFetch(
      `${COINGECKO_BASE}/coins/${coinId}?localization=false&tickers=true&community_data=true&developer_data=true`
    );
  }

  // If coinId not found, try search by symbol
  if (!data && retryOnSymbol && symbol) {
    const searchResult = await rateLimitedFetch(`${COINGECKO_BASE}/search?query=${encodeURIComponent(symbol)}`);
    if (searchResult?.coins?.length > 0) {
      const found = searchResult.coins.find(c =>
        c.symbol?.toLowerCase() === symbol?.toLowerCase()
      ) || searchResult.coins[0];
      if (found?.id) {
        data = await rateLimitedFetch(
          `${COINGECKO_BASE}/coins/${found.id}?localization=false&tickers=true&community_data=true&developer_data=true`
        );
      }
    }
  }

  if (!data) return null;

  // Normalize and cache
  const enriched = {
    id: data.id,
    symbol: data.symbol,
    name: data.name,
    description: (data.description?.en || "").slice(0, 500),
    // Social signals
    social: {
      twitter_followers: data.community_data?.twitter_followers || 0,
      reddit_subscribers: data.community_data?.reddit_subscribers || 0,
      reddit_avg_posts_48h: data.community_data?.reddit_average_posts_48h || 0,
      telegram_channel_user_count: data.community_data?.telegram_channel_user_count || 0,
      community_score: data.community_score || 0, // 0-1 CoinGecko community score
    },
    // Developer signals
    developer: {
      github_stars: data.developer_data?.stars || 0,
      github_forks: data.developer_data?.forks || 0,
      github_subscribers: data.developer_data?.subscribers || 0,
      total_issues: data.developer_data?.total_issues || 0,
      closed_issues: data.developer_data?.closed_issues || 0,
      commit_count_4w: data.developer_data?.commit_count_4_weeks || 0,
      developer_score: data.developer_score || 0, // 0-1 CoinGecko developer score
    },
    // Market data
    market: {
      market_cap_rank: data.market_cap_rank || null,
      market_cap_usd: data.market_data?.market_cap?.usd || 0,
      total_volume_usd: data.market_data?.total_volume?.usd || 0,
      price_usd: data.market_data?.current_price?.usd || 0,
      price_change_24h: data.market_data?.price_change_percentage_24h || 0,
      price_change_7d: data.market_data?.price_change_percentage_7d || 0,
      price_change_30d: data.market_data?.price_change_percentage_30d || 0,
      ath_usd: data.market_data?.ath?.usd || 0,
      ath_date: data.market_data?.ath_date?.usd || null,
      atl_usd: data.market_data?.atl?.usd || 0,
      circulating_supply: data.market_data?.circulating_supply || 0,
    },
    // CEX listings (exchange tickers)
    cex_listings: (data.tickers || [])
      .filter(t => t.market?.identifier === "cex" || t.market?.name?.toLowerCase().includes("exchange"))
      .slice(0, 10)
      .map(t => ({
        exchange: t.market?.name || "unknown",
        pair: `${t.base}/${t.target}`,
        volume_24h: t.volume || 0,
      })),
    cex_count: (data.tickers || []).filter(t =>
      t.market?.identifier === "cex" || t.market?.name?.toLowerCase().includes("exchange")
    ).length,
    categories: data.categories || [],
    _enriched_at: new Date().toISOString(),
  };

  _coinCache.set(cacheKey, { data: enriched, ts: Date.now() });

  log("coingecko", `Enriched ${enriched.symbol}: social=${enriched.social.community_score}, dev=${enriched.developer.developer_score}, CEX=${enriched.cex_count}`);

  return enriched;
}

/**
 * Quick social velocity signal from CoinGecko data.
 * This fills the socialVelocity gap in the community detector.
 */
export function coinGeckoToSocialVelocity(enriched) {
  if (!enriched) return null;

  const social = enriched.social || {};
  const dev = enriched.developer || {};

  // Compute velocity score from available signals
  let score = 0;
  if (social.community_score > 0.5) score += 0.3;
  if (social.twitter_followers > 10000) score += 0.3;
  if (social.twitter_followers > 50000) score += 0.2;
  if (social.telegram_channel_user_count > 5000) score += 0.2;
  if (dev.commit_count_4w > 10) score += 0.2;
  if (dev.developer_score > 0.5) score += 0.2;

  return {
    velocity_score: Math.min(1, score),
    source: "coingecko",
    twitter_followers: social.twitter_followers,
    telegram_users: social.telegram_channel_user_count,
    community_score: social.community_score,
    dev_activity: dev.commit_count_4w > 0 ? "active" : "inactive",
    cex_count: enriched.cex_count || 0,
  };
}

/**
 * Get exchange listings count for a coin.
 * Used by migration detector (fills the cexListings gap).
 */
export function getCexListings(enriched) {
  if (!enriched?.cex_listings) return [];
  return enriched.cex_listings.map(l => l.exchange).filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Clear all caches (for testing).
 */
export function _clearCoinGeckoCache() {
  _trendingCache = null;
  _trendingCacheTime = 0;
  _coinCache.clear();
}
