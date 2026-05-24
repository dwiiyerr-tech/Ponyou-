/**
 * DexScreener API — Token discovery, security, market data.
 * Replaces GMGN discovery endpoints (no API key required).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";
import { listSmartWallets } from "../smart-wallets.js";
import { recordSmartWalletSnapshot, summarizeSmartWalletHistory } from "../smart-wallet-history.js";
import { analyzeHolderStructure } from "../holder-memory.js";
import { detectBundledLaunch, gatherRugSignals, heliusAcquire, heliusRelease, heliusCircuitOpen } from "./rug-signals.js";
import { classifyNarrative, summarizeNarrative } from "./narratives.js";
import { discoverBirdeyeTokens, enrichTokensWithBirdeye, isBirdeyeEnabled } from "./birdeye.js";

const DS_BASE = "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

let _connection = null;
function getSolanaConnection() {
  if (!_connection) {
    _connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );
  }
  return _connection;
}

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
        signal: AbortSignal.timeout(8000),
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

function mergeTokenLists(primary = [], secondary = []) {
  const tokenMap = new Map();
  for (const token of primary) {
    if (!token?.mint) continue;
    tokenMap.set(token.mint, {
      ...token,
      data_sources: Array.from(new Set([...(token.data_sources || []), token.source || "dexscreener"])),
    });
  }
  for (const token of secondary) {
    if (!token?.mint) continue;
    const existing = tokenMap.get(token.mint);
    if (!existing) {
      tokenMap.set(token.mint, {
        ...token,
        data_sources: Array.from(new Set([...(token.data_sources || []), "birdeye"])),
      });
      continue;
    }
    tokenMap.set(token.mint, {
      ...existing,
      price: existing.price || token.price,
      mcap: existing.mcap || token.mcap,
      liquidity: existing.liquidity || token.liquidity,
      volume: Math.max(existing.volume || 0, token.volume || 0),
      swaps: Math.max(existing.swaps || 0, token.swaps || 0),
      birdeye: token.birdeye || existing.birdeye,
      data_sources: Array.from(new Set([...(existing.data_sources || []), "birdeye"])),
    });
  }
  return [...tokenMap.values()];
}

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
      if (isBirdeyeEnabled()) return discoverBirdeyeTokens({ timeframe, limit });
      return { error: "No tokens found", tokens: [] };
    }

    // Step 2: Fetch full pair data for collected addresses
    const addresses = [...boostMap.keys()].slice(0, 30).join(",");
    const tokenData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${addresses}`);
    const pairs = (tokenData.pairs || []).filter(p => p.chainId === "solana");

    if (!pairs.length) {
      if (isBirdeyeEnabled()) return discoverBirdeyeTokens({ timeframe, limit });
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

    let tokens = [...tokenMap.values()]
      .sort((a, b) => (b.swaps || 0) - (a.swaps || 0))
      .slice(0, limit);

    if (isBirdeyeEnabled()) {
      const [birdeyeDiscovery, enriched] = await Promise.all([
        discoverBirdeyeTokens({ timeframe, limit }).catch(error => ({ error: error.message, tokens: [] })),
        enrichTokensWithBirdeye(tokens).catch(() => tokens),
      ]);
      tokens = mergeTokenLists(enriched, birdeyeDiscovery.tokens || [])
        .sort((a, b) => (b.swaps || 0) - (a.swaps || 0))
        .slice(0, limit);
    }

    log("discovery", "DexScreener" + (isBirdeyeEnabled() ? " + Birdeye" : "") + ": found " + tokens.length + " tokens");
    return { tokens, source: isBirdeyeEnabled() ? "dexscreener+birdeye" : "dexscreener" };
  } catch (error) {
    log("discovery_error", "DexScreener discoverTokens: " + error.message);
    if (isBirdeyeEnabled()) return discoverBirdeyeTokens({ timeframe, limit });
    return { error: error.message, tokens: [] };
  }
}

// ─── Security & Holders ───────────────────────────────────────

export async function getTokenSecurityDetails({ mint }) {
  try {
    const connection = getSolanaConnection();
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

    let holders = topAccounts.map(a => {
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
        const holderOwnerByIndex = parsedHolders.value
          .map(acc => acc?.data?.parsed?.info?.owner || null);
        const tokenAccountOwners = {};
        holderOwnerByIndex.forEach((owner, i) => {
          tokenAccountOwners[topAccounts[i]?.address] = owner;
        });

        const uniqueOwnerAddresses = [...new Set(holderOwnerByIndex.filter(Boolean))];
        if (uniqueOwnerAddresses.length > 0) {
          const ownerKeys = uniqueOwnerAddresses.map(address => new PublicKey(address));
          const ownerInfos = await connection.getMultipleAccountsInfo(ownerKeys);
          ownerInfos.forEach((acc, i) => {
            solBalances[ownerKeys[i].toString()] = acc ? acc.lamports / 1e9 : 0;
          });

          holders = holders.map(h => {
            const ownerAddress = tokenAccountOwners[h.address];
            return {
              ...h,
              sol_balance: ownerAddress ? (solBalances[ownerAddress] ?? 0) : 0,
            };
          });
        } else {
          holders = holders.map(h => ({ ...h, sol_balance: 0 }));
        }

        holderOwners = holderOwnerByIndex.filter(Boolean);
      } catch (e) {
        log("security_warn", `Could not resolve holder owners: ${e.message}`);
      }
    }

    const top10Pct    = holders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    const dustHolders = holders.filter(h => (h.sol_balance || 0) < 0.2);
    const bundledLaunch = detectBundledLaunch({ holders });

    // Layer 1+2 rug signals (Token-2022 extensions + Helius-powered)
    const launchTs = dsPair?.pairCreatedAt ? Math.floor(dsPair.pairCreatedAt / 1000) : null;
    const enrichedSignals = await gatherRugSignals({
      mint,
      connection,
      holderOwners,
      launchTs,
      dsPair,
    });
    const holderAnalysis = analyzeHolderStructure({
      rugSignals: {
        top10_concentration_pct: parseFloat(top10Pct.toFixed(2)),
        dust_holders: dustHolders.length,
        ...bundledLaunch,
        ...enrichedSignals,
      },
      holders,
      token: {
        mcap: dsPair?.marketCap || dsPair?.fdv || 0,
        hot_level: dsPair ? Math.min(3, Math.ceil((dsPair.boosts?.active || 0) / 200)) : 0,
        narrative_tags: dsPair ? classifyNarrative({
          symbol: dsPair.baseToken?.symbol,
          name: dsPair.baseToken?.name,
        }) : [],
      },
    });

    return {
      mint,
      security: sec,
      holders,
      holder_analysis: holderAnalysis,
      rug_signals: {
        top10_concentration_pct: parseFloat(top10Pct.toFixed(2)),
        dust_holders:            dustHolders.length,
        ...bundledLaunch,
        is_renounced:            sec.renounced,
        is_honeypot:             null,
        freeze_authority:        !!sec.freeze_authority,
        mint_authority:          !!sec.mint_authority,
        creator_pct:             null,
        max_holder_pct:          holderAnalysis.max_holder_pct,
        hidden_wallet_control_score: holderAnalysis.hidden_wallet_control_score,
        holder_structure_risk:   holderAnalysis.holder_structure_risk,
        context_allows_concentration: holderAnalysis.context_allows_concentration,
        holder_context_note:     holderAnalysis.summary,
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
    return {
      mint,
      error: error.message,
      security: {},
      holders: [],
      rug_signals: {
        _collector_error: error.message,
        _helius_used: !!(process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY !== "dummy-helius-key"),
        _helius_expected: !!(process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY !== "dummy-helius-key"),
      },
    };
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
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
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
const SMART_MONEY_TF_SECONDS = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

async function fetchHeliusTxns(address, apiKey, limit = 50) {
  if (heliusCircuitOpen()) throw new Error("Helius circuit open — smart money degraded");
  await heliusAcquire();
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}&type=SWAP`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Helius ${res.status}`);
    return res.json();
  } finally {
    heliusRelease();
  }
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function extractTokenAmount(transfer = {}) {
  return numberOrZero(
    transfer.tokenAmount?.uiAmount ??
    transfer.tokenAmount?.uiAmountString ??
    transfer.tokenAmount ??
    transfer.amount
  );
}

function parseSolanaSwap(tx) {
  const feePayer = tx.feePayer;
  const transfers = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];

  const received = transfers.filter(t =>
    t.toUserAccount === feePayer &&
    t.mint !== SOL_MINT
  );
  const sent = transfers.filter(t =>
    t.fromUserAccount === feePayer &&
    t.mint !== SOL_MINT
  );

  const solOut = nativeTransfers
    .filter(t => t.fromUserAccount === feePayer)
    .reduce((sum, t) => sum + numberOrZero(t.amount), 0) / 1e9;

  const solIn = nativeTransfers
    .filter(t => t.toUserAccount === feePayer)
    .reduce((sum, t) => sum + numberOrZero(t.amount), 0) / 1e9;

  if (received.length === 0 && sent.length === 0) return null;

  const tokenTransfer = received[0] || sent[0];
  const tokenAmount = extractTokenAmount(tokenTransfer);
  const type = received.length > 0 ? "buy" : "sell";
  const solValue = type === "buy" ? solOut : solIn;

  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    type,
    token_mint: tokenTransfer?.mint,
    token_amount: tokenAmount,
    sol_value: solValue,
    unit_price_sol: tokenAmount > 0 ? solValue / tokenAmount : 0,
    fee_lamports: numberOrZero(tx.fee),
  };
}

function analyzeSmartWalletPerformance(swaps = []) {
  if (!Array.isArray(swaps) || swaps.length === 0) {
    return {
      trade_count: 0,
      realized_pnl_sol: 0,
      winrate: 0,
      avg_hold_minutes: 0,
      unique_tokens: 0,
      buy_count: 0,
      sell_count: 0,
      open_positions: 0,
      conviction_score: 0,
      buy_pressure: 0.5,
      last_trade_at: null,
    };
  }

  const sorted = [...swaps]
    .filter(s => s?.token_mint && s?.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);
  const byMint = new Map();
  for (const swap of sorted) {
    if (!byMint.has(swap.token_mint)) byMint.set(swap.token_mint, []);
    byMint.get(swap.token_mint).push(swap);
  }

  let realizedPnlSol = 0;
  let wins = 0;
  let losses = 0;
  let totalHoldSeconds = 0;
  let completedTrades = 0;
  let openPositions = 0;

  for (const mintSwaps of byMint.values()) {
    const buyQueue = [];

    for (const swap of mintSwaps) {
      if (swap.type === "buy" && swap.token_amount > 0 && swap.sol_value > 0) {
        buyQueue.push({
          remaining: swap.token_amount,
          cost_per_token: swap.sol_value / swap.token_amount,
          ts: swap.timestamp,
        });
        continue;
      }

      if (swap.type !== "sell" || swap.token_amount <= 0 || swap.sol_value <= 0 || buyQueue.length === 0) {
        continue;
      }

      let remainingToMatch = swap.token_amount;
      let matchedCost = 0;
      let matchedAmount = 0;
      let earliestBuyTs = null;
      const sellPricePerToken = swap.sol_value / swap.token_amount;

      while (remainingToMatch > 0 && buyQueue.length > 0) {
        const head = buyQueue[0];
        const take = Math.min(head.remaining, remainingToMatch);
        matchedCost += take * head.cost_per_token;
        matchedAmount += take;
        earliestBuyTs = earliestBuyTs || head.ts;
        head.remaining -= take;
        remainingToMatch -= take;
        if (head.remaining <= 1e-9) buyQueue.shift();
      }

      if (matchedAmount > 0) {
        const proceeds = matchedAmount * sellPricePerToken;
        const pnl = proceeds - matchedCost;
        realizedPnlSol += pnl;
        completedTrades += 1;
        if (pnl > 0) wins += 1;
        else losses += 1;
        if (earliestBuyTs) totalHoldSeconds += Math.max(0, swap.timestamp - earliestBuyTs);
      }
    }

    if (buyQueue.length > 0) openPositions += 1;
  }

  const buyCount = sorted.filter(s => s.type === "buy").length;
  const sellCount = sorted.filter(s => s.type === "sell").length;
  const winrate = completedTrades > 0 ? wins / completedTrades : 0;
  const avgHoldMinutes = completedTrades > 0 ? totalHoldSeconds / completedTrades / 60 : 0;
  const uniqueTokens = byMint.size;
  const buyPressure = buyCount + sellCount > 0 ? buyCount / (buyCount + sellCount) : 0.5;
  const diversificationPenalty = completedTrades > 0 ? Math.min(1.2, uniqueTokens / completedTrades) : 1.2;
  const convictionScore = Math.max(0, Math.min(100,
    Math.round(
      winrate * 45 +
      Math.min(20, completedTrades * 2) +
      Math.max(0, 20 - diversificationPenalty * 10) +
      Math.max(0, Math.min(15, buyPressure * 15))
    )
  ));

  return {
    trade_count: completedTrades,
    realized_pnl_sol: Number(realizedPnlSol.toFixed(4)),
    winrate: Number(winrate.toFixed(3)),
    avg_hold_minutes: Number(avgHoldMinutes.toFixed(1)),
    unique_tokens: uniqueTokens,
    buy_count: buyCount,
    sell_count: sellCount,
    open_positions: openPositions,
    conviction_score: convictionScore,
    buy_pressure: Number(buyPressure.toFixed(3)),
    last_trade_at: sorted[sorted.length - 1]?.timestamp || null,
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

  const cutoff = Date.now() / 1000 - (SMART_MONEY_TF_SECONDS[timeframe] || SMART_MONEY_TF_SECONDS["24h"]);
  const results = [];

  for (const wallet of wallets.slice(0, 10)) { // cap at 10 to avoid rate limits
    try {
      const txns = await fetchHeliusTxns(wallet.address, apiKey, 50);
      const recentTxns = txns.filter(tx => tx.timestamp >= cutoff);
      const swaps = recentTxns.map(parseSolanaSwap).filter(Boolean);
      const performance = analyzeSmartWalletPerformance(swaps);
      await recordSmartWalletSnapshot(wallet.address, { ...performance, timeframe });
      const history = summarizeSmartWalletHistory(wallet.address, { timeframe, limit: 12 });

      results.push({
        address: wallet.address,
        label: wallet.label,
        follow_mode: wallet.follow_mode || wallet.selection?.follow_mode || "shadow",
        selection_score: wallet.selection?.score ?? null,
        swap_count: swaps.length,
        ...performance,
        history,
      });
    } catch (e) {
      log("smart_money_warn", `Helius fetch for ${wallet.address.slice(0, 8)}: ${e.message}`);
    }
  }

  results.sort((a, b) =>
    (b.realized_pnl_sol - a.realized_pnl_sol) ||
    (b.winrate - a.winrate) ||
    ((b.history?.stability_score || 0) - (a.history?.stability_score || 0)) ||
    (b.conviction_score - a.conviction_score) ||
    (b.swap_count - a.swap_count)
  );
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
  const tokenAccum = new Map(); // mint → { wallets: Set, buy_count, sell_count, weighted_buy_score }

  for (const wallet of wallets.slice(0, 10)) {
    try {
      const txns = await fetchHeliusTxns(wallet.address, apiKey, 30);
      const history = summarizeSmartWalletHistory(wallet.address, { timeframe: "24h", limit: 12 });
      const walletWeight =
        1 +
        ((wallet.selection?.score || 0) / 100) +
        ((history.stability_score || 0) / 150);
      const recentSwaps = txns
        .filter(tx => tx.timestamp >= cutoff)
        .map(parseSolanaSwap)
        .filter(Boolean);

      for (const swap of recentSwaps) {
        if (!swap.token_mint) continue;
        if (!tokenAccum.has(swap.token_mint)) {
          tokenAccum.set(swap.token_mint, { wallets: new Set(), buy_count: 0, sell_count: 0, weighted_buy_score: 0 });
        }
        const entry = tokenAccum.get(swap.token_mint);
        entry.wallets.add(wallet.address);
        if (swap.type === "buy") {
          entry.buy_count++;
          entry.weighted_buy_score += walletWeight;
        } else entry.sell_count++;
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
      weighted_buy_score: Number(data.weighted_buy_score.toFixed(3)),
    }))
    .filter(t => t.buy_count > t.sell_count) // only net buyers
    .sort((a, b) => b.weighted_buy_score - a.weighted_buy_score || b.wallet_count - a.wallet_count || b.buy_count - a.buy_count)
    .slice(0, 20);

  return { timeframe, tokens, source: "helius", wallets_tracked: wallets.length };
}

export const _internalSmartMoney = {
  parseSolanaSwap,
  analyzeSmartWalletPerformance,
};
