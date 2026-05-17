/**
 * DexScreener API — Token discovery, security, market data.
 * Replaces GMGN discovery endpoints (no API key required).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";
import { listSmartWallets } from "../smart-wallets.js";
import { gatherRugSignals } from "./rug-signals.js";
import { classifyNarrative, summarizeNarrative } from "./narratives.js";

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

// Pick the right DexScreener txns bucket for the requested timeframe.
const TF_BUCKETS = {
  "5m":  "m5",
  "1h":  "h1",
  "6h":  "h6",
  "24h": "h24",
};
function tfBucket(tf) {
  // DexScreener has no <5m bucket; treat 1m as 5m for stats purposes.
  if (tf === "1m") return "m5";
  return TF_BUCKETS[tf] || "h1";
}

function mapPair(pair, boostAmount = 0, timeframe = "1h") {
  const b = tfBucket(timeframe);
  const buys  = pair.txns?.[b]?.buys  || 0;
  const sells = pair.txns?.[b]?.sells || 0;
  const total = buys + sells;
  const vol   = pair.volume?.[b] || 0;

  const narrativeTags = classifyNarrative({
    symbol: pair.baseToken.symbol,
    name:   pair.baseToken.name,
  });

  return {
    mint:             pair.baseToken.address,
    symbol:           pair.baseToken.symbol,
    name:             pair.baseToken.name,
    narrative:        summarizeNarrative({ symbol: pair.baseToken.symbol, name: pair.baseToken.name }),
    narrative_tags:   narrativeTags,
    price:            parseFloat(pair.priceUsd || 0),
    mcap:             pair.marketCap || pair.fdv || 0,
    liquidity:        pair.liquidity?.usd || 0,
    volume:           vol,
    swaps:            total,
    timeframe,
    hot_level:        boostAmount > 0 ? Math.min(3, Math.ceil(boostAmount / 200)) : 0,
    launchpad:        normalizeDex(pair.dexId),
    creator:          null,
    buys,
    sells,
    buy_vol:          total > 0 ? vol * (buys  / total) : 0,
    sell_vol:         total > 0 ? vol * (sells / total) : 0,
    price_change_5m:  pair.priceChange?.m5  || 0,
    price_change_1h:  pair.priceChange?.h1  || 0,
    price_change_24h: pair.priceChange?.h24 || 0,
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
        tokenMap.set(mint, mapPair(pair, boostMap.get(mint) || 0, timeframe));
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

    const holders = topAccounts.map(a => {
      const ui = parseFloat(a.uiAmount ?? a.uiAmountString ?? 0) || 0;
      return {
        address:     a.address,
        pct:         supplyUi > 0 ? (ui / supplyUi) * 100 : 0,
        is_contract: false,
        sol_balance: solBalances[a.address] ?? 0,
        funded_at:   null,
        token_amount: ui,
      };
    });

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

    // Resolve token-account → owner wallet for top holders (needed for Helius checks)
    let holderOwners = [];
    if (topAccounts.length > 0) {
      try {
        const parsedHolders = await connection.getMultipleParsedAccounts(
          topAccounts.map(a => new PublicKey(a.address))
        );
        holderOwners = parsedHolders.value
          .map(acc => acc?.data?.parsed?.info?.owner)
          .filter(Boolean);
      } catch (e) {
        log("security_warn", `Could not resolve holder owners: ${e.message}`);
      }
    }

    // Layer 1+2 rug signals (Token-2022 extensions + Helius-powered)
    const launchTs = dsPair?.pairCreatedAt ? Math.floor(dsPair.pairCreatedAt / 1000) : null;
    const enrichedSignals = await gatherRugSignals({
      mint,
      connection,
      holderOwners,
      launchTs,
      dsPair,
    });

    return {
      mint,
      security: sec,
      holders,
      rug_signals: {
        top10_concentration_pct: parseFloat(top10Pct.toFixed(2)),
        dust_holders:            dustHolders.length,
        is_renounced:            sec.renounced,
        is_honeypot:             null,
        freeze_authority:        !!sec.freeze_authority,
        mint_authority:          !!sec.mint_authority,
        creator_pct:             null,
        ...enrichedSignals,
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

// ─── OHLCV Candles (GeckoTerminal, no API key) ────────────────

const GT_BASE = "https://api.geckoterminal.com/api/v2";

const _poolCache = new Map(); // mint → { pool, ts }
const POOL_TTL_MS = 5 * 60_000;

// Rate-limit aware fetcher (GeckoTerminal free = 30/min).
// Serializes calls via a chained promise so concurrent callers can't both pass
// the gap check simultaneously.
let _gtLastCall = 0;
let _gtQueue = Promise.resolve();
const GT_MIN_GAP_MS = 2100; // ~28 req/min, leaves headroom

async function gtAcquireSlot() {
  // Atomic reservation: only one caller at a time runs the gap-await + stamp.
  let release;
  const next = new Promise((res) => (release = res));
  const prev = _gtQueue;
  _gtQueue = next;
  await prev;
  try {
    const gap = Date.now() - _gtLastCall;
    if (gap < GT_MIN_GAP_MS) await new Promise((r) => setTimeout(r, GT_MIN_GAP_MS - gap));
    _gtLastCall = Date.now();
  } finally {
    release();
  }
}

async function gtFetch(url, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await gtAcquireSlot();
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP 429`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr || new Error("GeckoTerminal fetch failed");
}

async function getTopPool(mint) {
  const cached = _poolCache.get(mint);
  if (cached && Date.now() - cached.ts < POOL_TTL_MS) return cached.pool;
  const data = await gtFetch(`${GT_BASE}/networks/solana/tokens/${mint}/pools?page=1`);
  const top = data.data?.[0]?.attributes?.address;
  if (top) _poolCache.set(mint, { pool: top, ts: Date.now() });
  return top || null;
}

function mapResolution(resolution) {
  // GeckoTerminal: timeframe=minute|hour|day, aggregate=N
  const m = { "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15],
              "30m": ["hour", 1], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };
  return m[resolution] || ["minute", 5];
}

export async function getTokenKlines({ mint, pair_address = null, resolution = "5m", limit = 100 }) {
  try {
    const pool = pair_address || await getTopPool(mint);
    if (!pool) {
      log("kline_warn", `No pool found for ${mint} on GeckoTerminal`);
      return { mint, resolution, candles: [], error: "No pool found" };
    }

    const [tf, agg] = mapResolution(resolution);
    const url = `${GT_BASE}/networks/solana/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=${Math.min(limit, 1000)}`;
    const data = await gtFetch(url);
    const list = data.data?.attributes?.ohlcv_list || [];

    return {
      mint, resolution,
      candles: list.map(c => ({
        time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      })).sort((a, b) => a.time - b.time),
    };
  } catch (e) {
    log("kline_warn", `GeckoTerminal kline failed for ${mint}: ${e.message}`);
    return { mint, resolution, candles: [], error: e.message };
  }
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

// ─── Smart Money (Helius-based) ───────────────────────────────

const HELIUS_BASE = "https://api.helius.xyz/v0";

async function fetchHeliusTxns(address, apiKey, limit = 50) {
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}&type=SWAP`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Helius ${res.status}`);
  return res.json();
}

function parseSolanaSwap(tx) {
  // Helius enriched transaction: tokenTransfers array
  const transfers = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];

  // Find the output token (what wallet received)
  const received = transfers.filter(t => t.toUserAccount && t.mint !== SOL_MINT);
  const sent = transfers.filter(t => t.fromUserAccount && t.mint !== SOL_MINT);

  if (received.length === 0 && sent.length === 0) return null;

  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    type: received.length > 0 ? "buy" : "sell",
    token_mint: received[0]?.mint || sent[0]?.mint,
    amount_usd: tx.fee ? tx.fee / 1e9 : 0, // rough proxy
  };
}

/**
 * Rank tracked smart wallets by recent P&L performance.
 * Requires valid HELIUS_API_KEY and wallets added via addSmartWallet().
 */
export async function getSmartMoneyRank({ timeframe = "24h" } = {}) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || apiKey === "dummy-helius-key") {
    return { timeframe, wallets: [], note: "Set HELIUS_API_KEY in .env to enable smart money tracking" };
  }

  const wallets = listSmartWallets();
  if (wallets.length === 0) {
    return { timeframe, wallets: [], note: "No wallets tracked. Use add_smart_wallet tool to add wallets." };
  }

  const cutoff = Date.now() / 1000 - (timeframe === "24h" ? 86400 : timeframe === "7d" ? 604800 : 3600);
  const results = [];

  for (const wallet of wallets.slice(0, 10)) { // cap at 10 to avoid rate limits
    try {
      const txns = await fetchHeliusTxns(wallet.address, apiKey, 50);
      const recentTxns = txns.filter(tx => tx.timestamp >= cutoff);
      const swaps = recentTxns.map(parseSolanaSwap).filter(Boolean);

      const buys = swaps.filter(s => s.type === "buy");
      const sells = swaps.filter(s => s.type === "sell");

      results.push({
        address: wallet.address,
        label: wallet.label,
        swap_count: swaps.length,
        buy_count: buys.length,
        sell_count: sells.length,
        unique_tokens: new Set(swaps.map(s => s.token_mint)).size,
      });
    } catch (e) {
      log("smart_money_warn", `Helius fetch for ${wallet.address.slice(0, 8)}: ${e.message}`);
    }
  }

  results.sort((a, b) => b.swap_count - a.swap_count);
  return { timeframe, wallets: results, source: "helius" };
}

/**
 * Detect which tokens tracked smart wallets are buying right now.
 * Returns tokens sorted by number of smart wallets accumulating.
 */
export async function getSmartMoneyInflow({ timeframe = "1h" } = {}) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || apiKey === "dummy-helius-key") {
    return { timeframe, tokens: [], note: "Set HELIUS_API_KEY in .env to enable smart money inflow" };
  }

  const wallets = listSmartWallets();
  if (wallets.length === 0) {
    return { timeframe, tokens: [], note: "No wallets tracked. Use add_smart_wallet tool to add wallets." };
  }

  const cutoff = Date.now() / 1000 - (timeframe === "1h" ? 3600 : timeframe === "6h" ? 21600 : 86400);
  const tokenAccum = new Map(); // mint → { wallets: Set, buy_count, sell_count }

  for (const wallet of wallets.slice(0, 10)) {
    try {
      const txns = await fetchHeliusTxns(wallet.address, apiKey, 30);
      const recentSwaps = txns
        .filter(tx => tx.timestamp >= cutoff)
        .map(parseSolanaSwap)
        .filter(Boolean);

      for (const swap of recentSwaps) {
        if (!swap.token_mint) continue;
        if (!tokenAccum.has(swap.token_mint)) {
          tokenAccum.set(swap.token_mint, { wallets: new Set(), buy_count: 0, sell_count: 0 });
        }
        const entry = tokenAccum.get(swap.token_mint);
        entry.wallets.add(wallet.address);
        if (swap.type === "buy") entry.buy_count++;
        else entry.sell_count++;
      }
    } catch (e) {
      log("smart_money_warn", `Helius inflow for ${wallet.address.slice(0, 8)}: ${e.message}`);
    }
  }

  const tokens = [...tokenAccum.entries()]
    .map(([mint, data]) => ({
      mint,
      wallet_count: data.wallets.size,
      buy_count: data.buy_count,
      sell_count: data.sell_count,
      buy_pressure: data.buy_count / (data.buy_count + data.sell_count || 1),
    }))
    .filter(t => t.buy_count > t.sell_count) // only net buyers
    .sort((a, b) => b.wallet_count - a.wallet_count || b.buy_count - a.buy_count)
    .slice(0, 20);

  return { timeframe, tokens, source: "helius", wallets_tracked: wallets.length };
}
