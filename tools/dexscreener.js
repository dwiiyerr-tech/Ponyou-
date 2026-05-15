/**
 * DexScreener API — Token discovery, security, market data.
 * Replaces GMGN discovery endpoints (no API key required).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";

const DS_BASE = "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function fetchDS(url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1200 * i));
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("DexScreener fetch failed");
}

function normalizeDex(dexId = "") {
  const d = dexId.toLowerCase();
  if (d.includes("pump")) return "pump.fun";
  if (d.includes("raydium")) return "raydium";
  if (d.includes("orca")) return "orca";
  if (d.includes("meteora")) return "meteora";
  if (d.includes("bonk") || d.includes("letsbonk")) return "letsbonk.fun";
  return dexId || null;
}

function mapPair(pair, boostAmount = 0) {
  const h1Buys  = pair.txns?.h1?.buys  || 0;
  const h1Sells = pair.txns?.h1?.sells || 0;
  const h1Total = h1Buys + h1Sells;
  const h1Vol   = pair.volume?.h1 || 0;

  return {
    mint:             pair.baseToken.address,
    symbol:           pair.baseToken.symbol,
    name:             pair.baseToken.name,
    price:            parseFloat(pair.priceUsd || 0),
    mcap:             pair.marketCap || pair.fdv || 0,
    liquidity:        pair.liquidity?.usd || 0,
    volume:           h1Vol,
    swaps:            h1Total,
    hot_level:        boostAmount > 0 ? Math.min(3, Math.ceil(boostAmount / 200)) : 0,
    launchpad:        normalizeDex(pair.dexId),
    creator:          null,
    buys:             h1Buys,
    sells:            h1Sells,
    buy_vol:          h1Total > 0 ? h1Vol * (h1Buys  / h1Total) : 0,
    sell_vol:         h1Total > 0 ? h1Vol * (h1Sells / h1Total) : 0,
    price_change_5m:  pair.priceChange?.m5  || 0,
    price_change_1h:  pair.priceChange?.h1  || 0,
    created_at:       pair.pairCreatedAt ? Math.floor(pair.pairCreatedAt / 1000) : null,
    pair_address:     pair.pairAddress,
    dex:              pair.dexId,
    // Fields GMGN had but DexScreener doesn't provide
    initial_mcap:     null,
    burn_ratio:       null,
    renounced:        null,
    is_honeypot:      null,
    global_fees_sol:  0,
  };
}

// ─── Discovery ────────────────────────────────────────────────

export async function discoverTokens({ timeframe = "1m", limit = 20 } = {}) {
  try {
    // Step 1: Get trending tokens (boosted) + latest new profiles on Solana
    const [boostData, profileData] = await Promise.allSettled([
      fetchDS(`${DS_BASE}/token-boosts/top/v1`),
      fetchDS(`${DS_BASE}/token-profiles/latest/v1`),
    ]);

    const boostMap = new Map();

    if (boostData.status === "fulfilled") {
      const boosts = Array.isArray(boostData.value) ? boostData.value : [];
      for (const b of boosts.filter(b => b.chainId === "solana").slice(0, 30)) {
        boostMap.set(b.tokenAddress, b.totalAmount || b.amount || 0);
      }
    }

    if (profileData.status === "fulfilled") {
      const profiles = Array.isArray(profileData.value) ? profileData.value : [];
      for (const p of profiles.filter(p => p.chainId === "solana").slice(0, 20)) {
        if (!boostMap.has(p.tokenAddress)) boostMap.set(p.tokenAddress, 0);
      }
    }

    if (boostMap.size === 0) {
      log("discovery_error", "DexScreener: no tokens from boosts/profiles");
      return { error: "No tokens found", tokens: [] };
    }

    // Step 2: Fetch full pair data for collected addresses
    const addresses = [...boostMap.keys()].slice(0, 30).join(",");
    const tokenData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${addresses}`);
    const pairs = (tokenData.pairs || []).filter(p => p.chainId === "solana");

    if (!pairs.length) {
      return { error: "No pair data from DexScreener", tokens: [] };
    }

    // Step 3: Deduplicate by mint — keep highest-liquidity pair per token
    const tokenMap = new Map();
    for (const pair of pairs) {
      const mint = pair.baseToken.address;
      if (mint === SOL_MINT) continue;
      const liq = pair.liquidity?.usd || 0;
      if (!tokenMap.has(mint) || liq > (tokenMap.get(mint).liquidity || 0)) {
        tokenMap.set(mint, mapPair(pair, boostMap.get(mint) || 0));
      }
    }

    const tokens = [...tokenMap.values()]
      .sort((a, b) => (b.swaps || 0) - (a.swaps || 0))
      .slice(0, limit);

    log("discovery", `DexScreener: found ${tokens.length} tokens`);
    return { tokens, source: "dexscreener" };
  } catch (error) {
    log("discovery_error", `DexScreener discoverTokens: ${error.message}`);
    return { error: error.message, tokens: [] };
  }
}

// ─── Security & Holders ───────────────────────────────────────

export async function getTokenSecurityDetails({ mint }) {
  try {
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );
    const mintPubkey = new PublicKey(mint);

    // Parallel: mint account info + largest token accounts
    const [mintInfoResult, largestResult] = await Promise.allSettled([
      connection.getParsedAccountInfo(mintPubkey),
      connection.getTokenLargestAccounts(mintPubkey),
    ]);

    const mintData = mintInfoResult.status === "fulfilled"
      ? (mintInfoResult.value.value?.data?.parsed?.info || {})
      : {};

    const topAccounts = largestResult.status === "fulfilled"
      ? (largestResult.value.value?.slice(0, 15) || [])
      : [];

    const supply     = parseFloat(mintData.supply || 0);
    const decimals   = mintData.decimals ?? 9;
    const supplyUi   = supply / Math.pow(10, decimals);

    // Fetch SOL balances for holder wallets (best-effort)
    let solBalances = {};
    if (topAccounts.length > 0) {
      try {
        const holderKeys = topAccounts.map(a => new PublicKey(a.address));
        const infos = await connection.getMultipleAccountsInfo(holderKeys);
        infos.forEach((acc, i) => {
          solBalances[holderKeys[i].toString()] = acc ? acc.lamports / 1e9 : 0;
        });
      } catch {}
    }

    const holders = topAccounts.map(a => ({
      address:    a.address,
      pct:        supplyUi > 0 ? (a.uiAmount / supplyUi) * 100 : 0,
      is_contract: false,
      sol_balance: solBalances[a.address] ?? 0,
      funded_at:   null,
      token_amount: a.uiAmount,
    }));

    const top10Pct    = holders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    const dustHolders = holders.filter(h => (h.sol_balance || 0) < 0.2);

    const sec = {
      freeze_authority: mintData.freezeAuthority   || null,
      mint_authority:   mintData.mintAuthority      || null,
      renounced:        !mintData.mintAuthority && !mintData.freezeAuthority,
      decimals,
      supply: supplyUi,
    };

    // Also try DexScreener for extra token info
    let dsPair = null;
    try {
      const ds = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mint}`);
      const pairs = (ds.pairs || []).filter(p => p.chainId === "solana");
      if (pairs.length) {
        dsPair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      }
    } catch {}

    return {
      mint,
      security: sec,
      holders,
      rug_signals: {
        top10_concentration_pct: parseFloat(top10Pct.toFixed(2)),
        fresh_funded_holders:    0,  // requires tx history (Helius)
        dust_holders:            dustHolders.length,
        is_renounced:            sec.renounced,
        is_honeypot:             null,
        freeze_authority:        !!sec.freeze_authority,
        mint_authority:          !!sec.mint_authority,
        creator_pct:             null,
      },
      // Bonus DexScreener data if available
      dex_info: dsPair ? {
        liquidity_usd: dsPair.liquidity?.usd,
        mcap: dsPair.marketCap || dsPair.fdv,
        dex: dsPair.dexId,
      } : null,
    };
  } catch (error) {
    log("security_error", `getTokenSecurityDetails ${mint}: ${error.message}`);
    return { mint, error: error.message, security: {}, holders: [], rug_signals: {} };
  }
}

// ─── OHLCV Candles ────────────────────────────────────────────

export async function getTokenKlines({ mint, resolution = "5m", limit = 100 }) {
  // Birdeye (if key available)
  const birdeyeKey = process.env.BIRDEYE_API_KEY;
  if (birdeyeKey) {
    try {
      const typeMap = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H" };
      const type    = typeMap[resolution] || "5m";
      const secsMap = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 };
      const timeTo  = Math.floor(Date.now() / 1000);
      const timeFrom = timeTo - (secsMap[resolution] || 300) * limit;

      const res = await fetch(
        `https://public-api.birdeye.so/defi/ohlcv?address=${mint}&type=${type}&time_from=${timeFrom}&time_to=${timeTo}`,
        { headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana" } }
      );
      if (res.ok) {
        const data = await res.json();
        const items = data.data?.items || [];
        return {
          mint, resolution,
          candles: items.map(c => ({
            time: c.unixTime,
            open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v,
          })).sort((a, b) => a.time - b.time),
        };
      }
    } catch (e) {
      log("kline_warn", `Birdeye kline failed: ${e.message}`);
    }
  }

  log("kline_warn", `No kline source for ${mint}. Set BIRDEYE_API_KEY for candle data.`);
  return { mint, resolution, candles: [], error: "No kline source. Set BIRDEYE_API_KEY." };
}

// ─── Market Info ──────────────────────────────────────────────

export async function getTokenMarketInfo({ mint }) {
  try {
    const data = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mint}`);
    const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) return { mint, error: "Token not found on DexScreener" };

    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      mint,
      price:            parseFloat(pair.priceUsd || 0),
      mcap:             pair.marketCap || pair.fdv || 0,
      volume_24h:       pair.volume?.h24 || 0,
      liquidity:        pair.liquidity?.usd || 0,
      holders:          null,
      swaps_24h:        (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
      price_change_5m:  pair.priceChange?.m5,
      price_change_1h:  pair.priceChange?.h1,
      price_change_24h: pair.priceChange?.h24,
      launchpad:        normalizeDex(pair.dexId),
    };
  } catch (error) {
    log("market_info_error", error.message);
    return { mint, error: error.message };
  }
}

// ─── Trending Narratives ──────────────────────────────────────

export async function getTrendingNarratives() {
  try {
    const data = await fetchDS(`${DS_BASE}/token-boosts/top/v1`);
    const solBoosts = (Array.isArray(data) ? data : []).filter(b => b.chainId === "solana");
    return {
      narratives: solBoosts.slice(0, 10).map(b => ({
        tag:         b.tokenAddress?.slice(0, 8),
        description: b.description || "",
        boost:       b.totalAmount || 0,
        links:       b.links || [],
      })),
    };
  } catch (error) {
    log("narrative_error", error.message);
    return { error: error.message, narratives: [] };
  }
}

// ─── Smart Money stubs (not available via DexScreener) ───────

export async function getSmartMoneyRank({ timeframe = "24h" } = {}) {
  log("smart_money_warn", "Smart money ranking not available via DexScreener. Use GMGN or premium data source.");
  return { timeframe, wallets: [], note: "Not available — requires premium data source" };
}

export async function getSmartMoneyInflow({ timeframe = "1h" } = {}) {
  log("smart_money_warn", "Smart money inflow not available via DexScreener.");
  return { timeframe, tokens: [], note: "Not available — requires premium data source" };
}
