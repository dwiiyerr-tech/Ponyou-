/**
 * Optional Birdeye market-data integration.
 *
 * The agent runs without Birdeye. When BIRDEYE_API_KEY is present, discovery
 * and token metadata can be enriched with Birdeye liquidity, volume, trade,
 * and market-cap fields. Birdeye calls are fail-soft by design so DexScreener
 * remains the default public data layer.
 */

import { log } from "../logger.js";
import { classifyNarrative, summarizeNarrative } from "./narratives.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";

export function isBirdeyeEnabled(env = process.env) {
  return !!(env.BIRDEYE_API_KEY && env.BIRDEYE_API_KEY !== "dummy-birdeye-key");
}

function birdeyeHeaders() {
  return {
    "Accept": "application/json",
    "X-API-KEY": process.env.BIRDEYE_API_KEY,
    "x-chain": "solana",
  };
}

async function fetchBirdeye(path, params = {}, retries = 1) {
  if (!isBirdeyeEnabled()) return { disabled: true };

  const url = new URL(path, BIRDEYE_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));
    try {
      const res = await fetch(url, { headers: birdeyeHeaders(), signal: AbortSignal.timeout(8000) });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2500 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (error) {
      lastErr = error;
    }
  }
  throw lastErr || new Error("Birdeye fetch failed");
}

function pickList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data?.tokens)) return data.data.tokens;
  if (Array.isArray(data?.tokens)) return data.tokens;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeToken(raw = {}, timeframe = "1h") {
  const mint = raw.address || raw.mint || raw.tokenAddress || raw.token_address || raw.id;
  if (!mint) return null;

  const symbol = raw.symbol || raw.token_symbol || raw.name || mint.slice(0, 8);
  const name = raw.name || raw.token_name || symbol;
  const buys = firstNumber(raw.buy_1h, raw.buy1h, raw.buy24h, raw.buy_24h, raw.trade_1h_buy_count, 0) || 0;
  const sells = firstNumber(raw.sell_1h, raw.sell1h, raw.sell24h, raw.sell_24h, raw.trade_1h_sell_count, 0) || 0;
  const swaps = firstNumber(raw.trade_1h_count, raw.trade24h, raw.trade_24h_count, raw.txns24h, buys + sells, 0) || 0;
  const volume = firstNumber(raw.volume_1h_usd, raw.v1hUSD, raw.volume_24h_usd, raw.v24hUSD, raw.volume24h, raw.volume, 0) || 0;
  const narrativeTags = classifyNarrative({ symbol, name });

  return {
    mint,
    symbol,
    name,
    narrative: summarizeNarrative({ symbol, name }),
    narrative_tags: narrativeTags,
    price: firstNumber(raw.price, raw.priceUsd, raw.price_usd, raw.usdPrice, 0) || 0,
    mcap: firstNumber(raw.market_cap, raw.marketCap, raw.mc, raw.fdv, 0) || 0,
    liquidity: firstNumber(raw.liquidity, raw.liquidity_usd, raw.liquidityUsd, 0) || 0,
    volume,
    swaps,
    timeframe,
    hot_level: swaps > 100 ? 2 : swaps > 25 ? 1 : 0,
    launchpad: raw.launchpad || raw.dex || raw.dexId || null,
    creator: null,
    buys,
    sells,
    buy_vol: buys + sells > 0 ? volume * (buys / (buys + sells)) : 0,
    sell_vol: buys + sells > 0 ? volume * (sells / (buys + sells)) : 0,
    price_change_5m: firstNumber(raw.price_change_5m_percent, raw.priceChange5mPercent, raw.priceChange5m, 0) || 0,
    price_change_1h: firstNumber(raw.price_change_1h_percent, raw.priceChange1hPercent, raw.priceChange1h, 0) || 0,
    price_change_24h: firstNumber(raw.price_change_24h_percent, raw.priceChange24hPercent, raw.priceChange24h, 0) || 0,
    created_at: raw.created_at || raw.createdAt || null,
    pair_address: raw.pair_address || raw.pairAddress || null,
    dex: raw.dex || raw.dexId || null,
    initial_mcap: null,
    burn_ratio: null,
    renounced: null,
    is_honeypot: null,
    global_fees_sol: 0,
    birdeye: {
      source: "birdeye",
      liquidity: firstNumber(raw.liquidity, raw.liquidity_usd, raw.liquidityUsd, 0) || 0,
      volume_24h_usd: firstNumber(raw.volume_24h_usd, raw.v24hUSD, raw.volume24h, 0) || 0,
      trade_24h_count: firstNumber(raw.trade_24h_count, raw.trade24h, raw.txns24h, 0) || 0,
    },
  };
}

export async function discoverBirdeyeTokens({ timeframe = "1m", limit = 20 } = {}) {
  if (!isBirdeyeEnabled()) return { disabled: true, tokens: [] };

  try {
    const data = await fetchBirdeye("/defi/tokenlist", {
      sort_by: "v24hUSD",
      sort_type: "desc",
      offset: 0,
      limit: Math.min(Math.max(limit * 2, 20), 50),
      min_liquidity: 100,
      ui_amount_mode: "scaled",
    });
    const tokens = pickList(data)
      .map(entry => normalizeToken(entry, timeframe))
      .filter(Boolean)
      .slice(0, limit);

    log("discovery", "Birdeye: found " + tokens.length + " tokens");
    return { tokens, source: "birdeye" };
  } catch (error) {
    log("discovery_error", "Birdeye discoverTokens: " + error.message);
    return { error: error.message, tokens: [] };
  }
}

export async function getBirdeyeMarketData({ mint }) {
  if (!isBirdeyeEnabled() || !mint) return null;

  try {
    const data = await fetchBirdeye("/defi/v3/token/market-data", {
      address: mint,
      ui_amount_mode: "scaled",
    });
    const payload = data?.data || data;
    if (!payload || payload.disabled) return null;
    return normalizeToken({ ...payload, address: mint }, "1h")?.birdeye || null;
  } catch (error) {
    log("market_data_error", "Birdeye market-data " + String(mint).slice(0, 8) + ": " + error.message);
    return null;
  }
}

export async function enrichTokensWithBirdeye(tokens = []) {
  if (!isBirdeyeEnabled() || tokens.length === 0) return tokens;

  const enriched = [];
  for (const token of tokens) {
    const market = await getBirdeyeMarketData({ mint: token.mint });
    if (!market) {
      enriched.push(token);
      continue;
    }
    enriched.push({
      ...token,
      liquidity: market.liquidity || token.liquidity,
      volume: market.volume_24h_usd || token.volume,
      swaps: market.trade_24h_count || token.swaps,
      birdeye: market,
      data_sources: Array.from(new Set([...(token.data_sources || [token.source || "dexscreener"]), "birdeye"])),
    });
  }
  return enriched;
}
