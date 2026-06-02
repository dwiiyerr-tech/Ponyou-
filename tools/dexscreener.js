/**
 * DexScreener API — Token discovery, security, market data.
 * Replaces GMGN discovery endpoints (no API key required).
 */

import { PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";
import { getSharedConnection } from "./solana-rpc.js";
import { listSmartWallets } from "../smart-wallets.js";
import { recordSmartWalletSnapshot, summarizeSmartWalletHistory } from "../smart-wallet-history.js";
import { analyzeHolderStructure } from "../holder-memory.js";
import { detectBundledLaunch, gatherRugSignals, heliusAcquire, heliusRelease, heliusCircuitOpen } from "./rug-signals.js";
import { classifyNarrative, summarizeNarrative } from "./narratives.js";
import { createCachedFetcher } from "../cache-util.js";
import { discoverBirdeyeTokens, enrichTokensWithBirdeye, isBirdeyeEnabled } from "./birdeye.js";
import { getWalletActivity, getTokenSignals, isGmgnEnabled } from "./gmgn.js";

const DS_BASE = "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
// Jupiter retired token.jup.ag and quote-api.jup.ag in 2025.
const JUPITER_TOKEN_API = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
const JUPITER_QUOTE_API = "https://lite-api.jup.ag/swap/v1";

// Quality floor for discovery pre-filter — rejects obvious dust/scams
// before they reach the trash filter, saving API calls and cycles.
const MIN_DISCOVERY_LIQUIDITY = 500;   // $500 minimum pool liquidity
const MIN_DISCOVERY_SWAPS = 1;         // at least 1 swap
const MIN_DISCOVERY_MCAP = 1000;       // $1,000 minimum market cap

// Raw-RPC reads here (getTokenSecurityDetails is ~5 RPC/mint) route through the
// shared, rate-limited connection so a wide screening batch can't burst the
// Helius endpoint into 429s. See tools/solana-rpc.js.
function getSolanaConnection() {
  return getSharedConnection();
}

async function fetchDS(url, retries = 2) {
  let lastErr;
  let saw429 = false;
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
        // DS-2: remember 429 separately so the final throw can name it
        // even when the 429 branch never set lastErr.
        saw429 = true;
        lastErr = new Error("HTTP 429 rate-limited by DexScreener");
        await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  if (saw429 && !lastErr) lastErr = new Error("HTTP 429 rate-limited by DexScreener (exhausted retries)");
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
    // Step 1: Discovery sources — prioritize NEW tokens over BOOSTED tokens.
    // token-profiles/latest = real new tokens (organic), includes pump.fun launches
    // token-boosts/top = paid promotion (mostly garbage), use as supplement only
    const [boostData, profileData, pumpFunData] = await Promise.allSettled([
      fetchDS(`${DS_BASE}/token-boosts/top/v1`),
      fetchDS(`${DS_BASE}/token-profiles/latest/v1`),
      discoverPumpFunTokens(), // pump.fun ecosystem via DexScreener
    ]);

    const tokenSet = new Map(); // mint → { boostAmount, source }

    // Priority 1: New token profiles (organic, includes pump.fun launches)
    if (profileData.status === "fulfilled") {
      const profiles = Array.isArray(profileData.value) ? profileData.value : [];
      for (const p of profiles.filter(p => p.chainId === "solana").slice(0, 30)) {
        if (!tokenSet.has(p.tokenAddress)) {
          tokenSet.set(p.tokenAddress, { boost: 0, source: "profile" });
        }
      }
    }

    // Priority 2: pump.fun ecosystem tokens
    if (pumpFunData.status === "fulfilled" && Array.isArray(pumpFunData.value)) {
      for (const pf of pumpFunData.value.slice(0, 15)) {
        if (!tokenSet.has(pf.mint)) {
          tokenSet.set(pf.mint, { boost: 50, source: "pumpfun" }); // pump.fun tokens get priority boost
        } else {
          // Already in list — mark as pump.fun and boost priority
          const existing = tokenSet.get(pf.mint);
          existing.boost = Math.max(existing.boost, 50);
          existing.source = "pumpfun+" + existing.source;
        }
      }
    }

    // Priority 3: Boosted tokens (paid promotion — supplement only)
    if (boostData.status === "fulfilled") {
      const boosts = Array.isArray(boostData.value) ? boostData.value : [];
      for (const b of boosts.filter(b => b.chainId === "solana").slice(0, 20)) {
        if (!tokenSet.has(b.tokenAddress)) {
          tokenSet.set(b.tokenAddress, { boost: b.totalAmount || b.amount || 0, source: "boosted" });
        }
      }
    }

    if (tokenSet.size === 0) {
      log("discovery_error", "DexScreener: no tokens from any source");
      if (isBirdeyeEnabled()) return discoverBirdeyeTokens({ timeframe, limit });
      return { error: "No tokens found", tokens: [] };
    }

    // Step 2: Fetch full pair data for collected addresses
    const addresses = [...tokenSet.keys()].slice(0, 30).join(",");
    const tokenData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${addresses}`);
    const pairs = (tokenData.pairs || []).filter(p => p.chainId === "solana");

    if (!pairs.length) {
      if (isBirdeyeEnabled()) return discoverBirdeyeTokens({ timeframe, limit });
      return { error: "No pair data from DexScreener", tokens: [] };
    }

    // Step 3: Deduplicate by mint + enrich with pump.fun priority
    const tokenMap = new Map();
    for (const pair of pairs) {
      const mint = pair.baseToken.address;
      if (mint === SOL_MINT) continue;
      const liq = pair.liquidity?.usd || 0;
      const meta = tokenSet.get(mint) || { boost: 0, source: "unknown" };
      if (!tokenMap.has(mint) || liq > (tokenMap.get(mint).liquidity || 0)) {
        const token = mapPair(pair, meta.boost, timeframe);
        token._discovery_source = meta.source;
        token._is_pumpfun = meta.source.includes("pumpfun") || (pair.dexId || "").toLowerCase().includes("pump");
        // pump.fun tokens get hot_level boost for being from the primary memecoin launchpad
        if (token._is_pumpfun && token.hot_level < 2) token.hot_level = 2;
        tokenMap.set(mint, token);
      }
    }

    let tokens = [...tokenMap.values()]
      .sort((a, b) => {
        // Pump.fun tokens first, then by swaps
        if (a._is_pumpfun && !b._is_pumpfun) return -1;
        if (!a._is_pumpfun && b._is_pumpfun) return 1;
        return (b.swaps || 0) - (a.swaps || 0);
      });

    // ── Quality pre-filter: reject dust/scams at discovery level ──
    const rawCount = tokens.length;
    tokens = tokens.filter(t => t.liquidity >= MIN_DISCOVERY_LIQUIDITY && t.swaps >= MIN_DISCOVERY_SWAPS && t.mcap >= MIN_DISCOVERY_MCAP);
    if (tokens.length < rawCount) {
      log("discovery", `Quality pre-filter: ${tokens.length}/${rawCount} passed (min liq $${MIN_DISCOVERY_LIQUIDITY}, swaps ${MIN_DISCOVERY_SWAPS}, mcap $${MIN_DISCOVERY_MCAP})`);
    }
    const pumpFunCount = tokens.filter(t => t._is_pumpfun).length;
    if (pumpFunCount > 0) log("discovery", `pump.fun ecosystem: ${pumpFunCount} tokens`);

    // ── Jupiter strict-list enrichment ──
    const jupiterTokens = await discoverJupiterTokens().catch(() => []);
    if (jupiterTokens.length > 0) {
      tokens = mergeTokenLists(tokens, jupiterTokens);
    }

    tokens = tokens.slice(0, limit);

    if (isBirdeyeEnabled()) {
      const [birdeyeDiscovery, enriched] = await Promise.all([
        discoverBirdeyeTokens({ timeframe, limit }).catch(error => ({ error: error.message, tokens: [] })),
        enrichTokensWithBirdeye(tokens).catch(() => tokens),
      ]);
      tokens = mergeTokenLists(enriched, birdeyeDiscovery.tokens || [])
        .sort((a, b) => (b.swaps || 0) - (a.swaps || 0))
        .slice(0, limit);
    }

    log("discovery", "DexScreener" + (isBirdeyeEnabled() ? " + Birdeye" : "") + (jupiterTokens.length > 0 ? " + Jupiter" : "") + ": found " + tokens.length + " tokens");
    return { tokens, source: isBirdeyeEnabled() ? "dexscreener+birdeye" : "dexscreener" };
  } catch (error) {
    log("discovery_error", "DexScreener discoverTokens: " + error.message);
    if (isBirdeyeEnabled()) return discoverBirdeyeTokens({ timeframe, limit });
    return { error: error.message, tokens: [] };
  }
}

// ─── Jupiter Discovery ───────────────────────────────────────
// Supplementary source: Jupiter strict-list verified tokens with
// on-chain liquidity. Higher signal, lower noise than trending feeds.

async function discoverJupiterTokens() {
  try {
    const res = await fetch(JUPITER_TOKEN_API, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const tokens = await res.json();
    if (!Array.isArray(tokens) || tokens.length === 0) return [];

    // New API returns mint as `id` and is already verified-tagged
    const solanaTokens = tokens.slice(0, 50);
    if (solanaTokens.length === 0) return [];

    const mintStr = solanaTokens.map(t => t.id || t.address).filter(Boolean).slice(0, 30).join(",");
    const pairData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mintStr}`).catch(() => null);
    if (!pairData?.pairs) return [];

    const solPairs = pairData.pairs.filter(p => p.chainId === "solana");
    const result = [];
    for (const pair of solPairs) {
      const mint = pair.baseToken.address;
      if (mint === SOL_MINT) continue;
      const liq = pair.liquidity?.usd || 0;
      if (liq < MIN_DISCOVERY_LIQUIDITY) continue;
      result.push(mapPair(pair, 0, "24h"));
    }
    return result;
  } catch {
    return [];
  }
}

// ─── pump.fun Discovery ─────────────────────────────────────
// pump.fun is the primary Solana memecoin launchpad. Since their
// API is Cloudflare-protected from servers, we discover pump.fun
// tokens indirectly via DexScreener's search endpoint, filtering
// for pairs on pumpswap (pump.fun's native DEX).

const PUMPFUN_DEX_IDS = ["pumpswap", "pump.fun", "pumpfun", "pump"];

async function discoverPumpFunTokens() {
  try {
    // Search DexScreener for Solana pairs — the search returns
    // tokens across all DEXes. We then filter for pump.fun ecosystem.
    const results = await Promise.allSettled([
      fetchDS(`${DS_BASE}/latest/dex/search?q=sol`).catch(() => null),
      fetchDS(`${DS_BASE}/latest/dex/search?q=ai`).catch(() => null),
    ]);

    const seenMints = new Set();
    const pumpFunPairs = [];

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value?.pairs) continue;
      const pairs = result.value.pairs.filter(p => p.chainId === "solana");
      for (const pair of pairs) {
        const dexId = (pair.dexId || "").toLowerCase();
        const isPumpFun = PUMPFUN_DEX_IDS.some(id => dexId.includes(id));
        if (!isPumpFun) continue;
        const mint = pair.baseToken.address;
        if (mint === SOL_MINT || seenMints.has(mint)) continue;
        seenMints.add(mint);
        const liq = pair.liquidity?.usd || 0;
        if (liq < MIN_DISCOVERY_LIQUIDITY) continue;
        const token = mapPair(pair, 50, "1m");
        token._discovery_source = "pumpfun";
        token._is_pumpfun = true;
        token.hot_level = Math.max(token.hot_level, 2);
        pumpFunPairs.push(token);
      }
    }

    // Also try to discover from token profiles that mention pump.fun
    const profileRes = await fetchDS(`${DS_BASE}/token-profiles/latest/v1`).catch(() => null);
    if (profileRes && Array.isArray(profileRes)) {
      const profileMints = profileRes
        .filter(p => p.chainId === "solana")
        .map(p => p.tokenAddress)
        .filter(m => !seenMints.has(m))
        .slice(0, 20);
      if (profileMints.length > 0) {
        const mintStr = profileMints.join(",");
        const pairData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mintStr}`).catch(() => null);
        if (pairData?.pairs) {
          for (const pair of pairData.pairs.filter(p => p.chainId === "solana")) {
            const dexId = (pair.dexId || "").toLowerCase();
            const isPumpFun = PUMPFUN_DEX_IDS.some(id => dexId.includes(id));
            if (!isPumpFun) continue;
            const mint = pair.baseToken.address;
            if (mint === SOL_MINT || seenMints.has(mint)) continue;
            seenMints.add(mint);
            const liq = pair.liquidity?.usd || 0;
            if (liq < MIN_DISCOVERY_LIQUIDITY) continue;
            const token = mapPair(pair, 50, "1m");
            token._discovery_source = "pumpfun-profile";
            token._is_pumpfun = true;
            token.hot_level = Math.max(token.hot_level, 2);
            pumpFunPairs.push(token);
          }
        }
      }
    }

    return pumpFunPairs;
  } catch {
    return [];
  }
}

// ─── Security & Holders ───────────────────────────────────────

async function _getTokenSecurityDetailsUncached({ mint, chain = "sol" }) {
  // EVM chains: skip the entire Solana-RPC holder/mint analysis (PublicKey,
  // getParsedAccountInfo, getTokenLargestAccounts all assume a Solana mint).
  // GMGN security + holder tags become the primary rug signal for EVM.
  if (chain !== "sol") {
    try {
      const enrichedSignals = await gatherRugSignals({ mint, connection: null, holderOwners: [], launchTs: null, dsPair: null, chain });
      return {
        mint,
        chain,
        security: { renounced: null, freeze_authority: null, mint_authority: null },
        holders: [],
        holder_analysis: null,
        rug_signals: {
          is_honeypot: null,
          ...enrichedSignals, // GMGN security + holder tags (chain-aware)
        },
        dex_info: null,
      };
    } catch (error) {
      log("security_error", `getTokenSecurityDetails ${mint} (${chain}): ${error.message}`);
      return { mint, chain, error: error.message, security: {}, holders: [], rug_signals: { _collector_error: error.message } };
    }
  }
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
        owner:       null, // resolved below when owner lookup succeeds
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
              owner: ownerAddress || null,
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
      chain: "sol",
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

// getTokenSecurityDetails is the heaviest Helius consumer (~5 RPC/mint) and is
// called for the same mint across the screening, management, and enrichment
// paths within the same window. Wrap it with a TTL cache + in-flight de-dup so
// those repeats collapse into one RPC burst. TTL (3min) < screening cadence
// (5min) → still fresh each cycle. Errors aren't cached (they carry `.error`),
// so transient 429s retry. Cache keyed by mint only.
const SECURITY_TTL_MS = 3 * 60_000;
export const getTokenSecurityDetails = createCachedFetcher(
  _getTokenSecurityDetailsUncached,
  { ttlMs: SECURITY_TTL_MS, key: ({ mint, chain = "sol" } = {}) => `${chain}:${mint || ""}` }
);

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
  // DS-6: cache the result EITHER way so an unknown mint doesn't get
  // re-queried on every kline / market-info call. `pool: null` signals
  // a confirmed not-found; callers downstream already handle null.
  _poolCache.set(mint, { pool: top || null, ts: Date.now() });
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

// DS-5: shadow-watchlist + heartbeat callers can hit this per-mint at
// short intervals, racking up dozens of redundant DexScreener fetches
// every cycle. Cache the result for a short window so duplicate queries
// in the same management/heartbeat sweep coalesce. TTL kept short so
// the price reading stays fresh enough for rug detection.
const _marketInfoCache = new Map(); // mint → { ts, info }
const MARKET_INFO_TTL_MS = 30_000;  // 30s — shorter than any caller's poll cadence
const MARKET_INFO_CACHE_MAX = 500;  // hard cap to bound memory

function _cacheMarketInfo(mint, info) {
  _marketInfoCache.set(mint, { ts: Date.now(), info });
  if (_marketInfoCache.size > MARKET_INFO_CACHE_MAX) {
    // Drop oldest ~10% on overflow.
    const entries = [..._marketInfoCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of entries.slice(0, Math.floor(MARKET_INFO_CACHE_MAX / 10))) {
      _marketInfoCache.delete(k);
    }
  }
}

export async function getTokenMarketInfo({ mint }) {
  const cached = _marketInfoCache.get(mint);
  if (cached && Date.now() - cached.ts < MARKET_INFO_TTL_MS) return cached.info;
  try {
    const data = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mint}`);
    const pairs = (data.pairs || []).filter(p => p.chainId === "solana");
    if (!pairs.length) {
      const miss = { mint, error: "Token not found on DexScreener" };
      // Cache the not-found too so we don't hammer DS for unknown mints —
      // but shorter TTL so it can recover quickly once indexed.
      _cacheMarketInfo(mint, miss);
      return miss;
    }

    const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const info = {
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
    _cacheMarketInfo(mint, info);
    return info;
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

export async function fetchHeliusTxns(address, apiKey, limit = 50) {
  if (heliusCircuitOpen()) throw new Error("Helius circuit open — smart money degraded");
  await heliusAcquire();
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}&type=SWAP`;
  // DS-3: retry transient failures up to 2 attempts. Helius returns 5xx /
  // 429 under load; a single shot was hostile to the surrounding smart-
  // money flow (every transient blip nuked the whole batch).
  const MAX_ATTEMPTS = 3;
  let lastErr;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Helius ${res.status}`);
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 800 * attempt)); // 0.8s, 1.6s
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) throw new Error(`Helius ${res.status}`);
        return res.json();
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 800 * attempt));
          continue;
        }
        throw lastErr;
      }
    }
  } finally {
    heliusRelease();
  }
  throw lastErr || new Error("Helius fetch failed");
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
 * GMGN primary (wallet activity without Helius quota), Helius fallback.
 */
export async function getSmartMoneyRank({ timeframe = "24h" } = {}) {
  const wallets = listSmartWallets();
  if (wallets.length === 0) {
    return { timeframe, wallets: [], note: "No wallets tracked. Use add_smart_wallet tool to add wallets." };
  }

  const results = [];

  // ── GMGN path ──────────────────────────────────────────────────────────────
  if (isGmgnEnabled()) {
    for (const wallet of wallets.slice(0, 15)) {
      try {
        const activity = await getWalletActivity(wallet.address, 30);
        const swaps = Array.isArray(activity) ? activity : (activity?.trades ?? activity?.swaps ?? []);
        const cutoffSec = Date.now() / 1000 - (SMART_MONEY_TF_SECONDS[timeframe] || SMART_MONEY_TF_SECONDS["24h"]);
        const recent = swaps.filter(s => Number(s.timestamp ?? s.time ?? 0) >= cutoffSec);
        const performance = analyzeSmartWalletPerformance(recent.map(s => ({
          type: s.type === "buy" || s.side === "buy" ? "buy" : "sell",
          token_mint: s.token_address || s.token_mint || s.mint,
          sol_value: Number(s.sol_amount ?? s.value ?? 0),
          token_amount: Number(s.token_amount ?? s.amount ?? 0),
          timestamp: Number(s.timestamp ?? s.time ?? 0),
          price_usd: Number(s.price_usd ?? 0),
        })).filter(s => s.token_mint));

        await recordSmartWalletSnapshot(wallet.address, { ...performance, timeframe });
        const history = summarizeSmartWalletHistory(wallet.address, { timeframe, limit: 12 });

        results.push({
          address: wallet.address,
          label: wallet.label,
          follow_mode: wallet.follow_mode || wallet.selection?.follow_mode || "shadow",
          selection_score: wallet.selection?.score ?? null,
          swap_count: recent.length,
          ...performance,
          history,
        });
      } catch (e) {
        log("smart_money_warn", `GMGN rank for ${wallet.address.slice(0, 8)}: ${e.message}`);
      }
    }
    if (results.length > 0) {
      results.sort((a, b) =>
        (b.realized_pnl_sol - a.realized_pnl_sol) || (b.winrate - a.winrate) ||
        ((b.history?.stability_score || 0) - (a.history?.stability_score || 0)) ||
        (b.conviction_score - a.conviction_score) || (b.swap_count - a.swap_count)
      );
      return { timeframe, wallets: results, source: "gmgn" };
    }
  }

  // ── Helius fallback ────────────────────────────────────────────────────────
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || apiKey === "dummy-helius-key") {
    return { timeframe, wallets: [], note: "Set GMGN_API_KEY or HELIUS_API_KEY to enable smart money tracking" };
  }

  const cutoff = Date.now() / 1000 - (SMART_MONEY_TF_SECONDS[timeframe] || SMART_MONEY_TF_SECONDS["24h"]);
  for (const wallet of wallets.slice(0, 10)) {
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
      log("smart_money_warn", `Helius rank for ${wallet.address.slice(0, 8)}: ${e.message}`);
    }
  }
  results.sort((a, b) =>
    (b.realized_pnl_sol - a.realized_pnl_sol) || (b.winrate - a.winrate) ||
    ((b.history?.stability_score || 0) - (a.history?.stability_score || 0)) ||
    (b.conviction_score - a.conviction_score) || (b.swap_count - a.swap_count)
  );
  return { timeframe, wallets: results, source: "helius" };
}

/**
 * Detect which tokens tracked smart wallets are buying right now.
 * GMGN token signals primary (direct signal feed), wallet activity + Helius as fallbacks.
 * Returns tokens sorted by number of smart wallets accumulating.
 */
export async function getSmartMoneyInflow({ timeframe = "1h" } = {}) {
  // ── GMGN signal path — direct smart money signal feed (fastest, no Helius) ──
  if (isGmgnEnabled()) {
    try {
      const signals = await getTokenSignals(); // all supported signal types
      const list = Array.isArray(signals) ? signals
        : Array.isArray(signals?.tokens) ? signals.tokens : [];
      if (list.length > 0) {
        const tokens = list.map(s => {
          // Real GMGN signal rows expose token_address + signal_times (how many
          // times the signal fired = strength proxy), not wallet_count/score.
          const strength = Number(s.signal_times ?? s.wallet_count ?? s.smart_money_count ?? 1) || 1;
          return {
            mint: s.token_address || s.address || s.mint,
            symbol: s.symbol,
            price: Number(s.price ?? s.cur_data?.price ?? 0),
            unique_wallets: strength,
            buy_count: Number(s.buy_count ?? 1),
            sell_count: Number(s.sell_count ?? 0),
            buy_ratio: Number(s.buy_ratio ?? 1),
            weighted_buy_score: strength,
            top_wallet_label: s.top_wallet_label || null,
          };
        }).filter(t => t.mint);
        if (tokens.length > 0) {
          return { timeframe, tokens, source: "gmgn_signal", wallets_tracked: 0 };
        }
      }
    } catch (e) {
      log("smart_money_warn", `GMGN signal inflow: ${e.message}`);
    }

    // GMGN wallet activity path — check each tracked wallet's recent buys
    const wallets = listSmartWallets();
    if (wallets.length > 0) {
      const cutoff = Date.now() / 1000 - (timeframe === "1h" ? 3600 : timeframe === "6h" ? 21600 : 86400);
      const tokenAccum = new Map();

      for (const wallet of wallets.slice(0, 12)) {
        try {
          const activity = await getWalletActivity(wallet.address, 30);
          const trades = Array.isArray(activity) ? activity : (activity?.trades ?? activity?.swaps ?? []);
          const history = summarizeSmartWalletHistory(wallet.address, { timeframe: "24h", limit: 12 });
          const walletWeight = 1 + ((wallet.selection?.score || 0) / 100) + ((history.stability_score || 0) / 150);

          for (const t of trades) {
            const ts = Number(t.timestamp ?? t.time ?? 0);
            if (ts < cutoff) continue;
            const mint = t.token_address || t.token_mint || t.mint;
            if (!mint) continue;
            if (!tokenAccum.has(mint)) tokenAccum.set(mint, { wallets: new Set(), buy_count: 0, sell_count: 0, weighted_buy_score: 0, symbol: t.symbol });
            const entry = tokenAccum.get(mint);
            entry.wallets.add(wallet.address);
            if (t.type === "buy" || t.side === "buy") { entry.buy_count++; entry.weighted_buy_score += walletWeight; }
            else entry.sell_count++;
          }
        } catch (e) {
          log("smart_money_warn", `GMGN inflow wallet ${wallet.address.slice(0, 8)}: ${e.message}`);
        }
      }

      const tokens = [...tokenAccum.entries()]
        .map(([mint, d]) => ({
          mint, symbol: d.symbol,
          unique_wallets: d.wallets.size,
          buy_count: d.buy_count, sell_count: d.sell_count,
          buy_ratio: d.buy_count / (d.buy_count + d.sell_count || 1),
          weighted_buy_score: Number(d.weighted_buy_score.toFixed(3)),
          top_wallet_label: null,
        }))
        .filter(t => t.buy_count > t.sell_count)
        .sort((a, b) => b.weighted_buy_score - a.weighted_buy_score || b.unique_wallets - a.unique_wallets)
        .slice(0, 20);

      if (tokens.length > 0) {
        return { timeframe, tokens, source: "gmgn_activity", wallets_tracked: wallets.length };
      }
    }
  }

  // ── Helius fallback ────────────────────────────────────────────────────────
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || apiKey === "dummy-helius-key") {
    return { timeframe, tokens: [], note: "Set GMGN_API_KEY or HELIUS_API_KEY to enable smart money inflow" };
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
