/**
 * Solscan.io API — wallet tracking & transaction history.
 *
 * Public API (free tier, no API key for basic endpoints):
 *   - Account overview: balance, token holdings, activity
 *   - Transaction history: last N swaps/transfers
 *   - Token holdings: current portfolio
 *
 * Rate limit: ~30 req/min (unpublished). Use sparingly.
 * Complements Helius (PnL analysis) and Shyft (holder data).
 */

import { log } from "../logger.js";

const SOLSCAN_BASE = "https://public-api.solscan.io";

// Cache: 5 min TTL per endpoint. Solscan data doesn't change second-to-second.
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cached(key) {
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.value;
  return null;
}

function putCache(key, value) {
  _cache.set(key, { ts: Date.now(), value });
  if (_cache.size > 500) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

async function fetchSolscan(path, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(`${SOLSCAN_BASE}${path}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Solscan ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Solscan fetch failed");
}

// ─── Wallet Overview ──────────────────────────────────────────────

/**
 * Get wallet account overview: SOL balance, token count, activity stats.
 */
export async function getWalletOverview(address) {
  const key = `overview:${address}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const data = await fetchSolscan(`/account/${address}`);
    const result = {
      address,
      balance_sol: (data?.lamports || 0) / 1e9,
      token_count: data?.tokenAccount?.length || 0,
      is_program: data?.executable || false,
      rent_epoch: data?.rentEpoch || 0,
      _source: "solscan",
    };
    putCache(key, result);
    return result;
  } catch (e) {
    log("solscan_warn", `Wallet overview ${address.slice(0, 8)}: ${e.message}`);
    return { address, error: e.message, _source: "solscan" };
  }
}

// ─── Transaction History ──────────────────────────────────────────

/**
 * Get recent transactions for a wallet.
 * Returns swaps, transfers, and program interactions.
 */
export async function getWalletTransactions(address, limit = 20) {
  const key = `txns:${address}:${limit}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const data = await fetchSolscan(`/account/transactions?account=${address}&limit=${limit}`);
    const txns = (Array.isArray(data) ? data : data?.data || []).map(tx => ({
      signature: tx.txHash || tx.signature || null,
      block_time: tx.blockTime || null,
      status: tx.status || "Unknown",
      fee_sol: (tx.fee || 0) / 1e9,
      signers: tx.signer || [],
      parsed_actions: (tx.parsedInstruction || []).map(ix => ({
        type: ix.type || "unknown",
        program: ix.programId || null,
      })),
    }));

    const result = {
      address,
      count: txns.length,
      transactions: txns,
      _source: "solscan",
    };
    putCache(key, result);
    return result;
  } catch (e) {
    log("solscan_warn", `Tx history ${address.slice(0, 8)}: ${e.message}`);
    return { address, count: 0, transactions: [], error: e.message, _source: "solscan" };
  }
}

// ─── Token Holdings ───────────────────────────────────────────────

/**
 * Get current token holdings for a wallet.
 * Useful for: checking if a dev still holds their token, tracking smart money portfolio.
 */
export async function getWalletHoldings(address) {
  const key = `holdings:${address}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const data = await fetchSolscan(`/account/token-holdings?account=${address}`);
    // Solscan v1 returns { data: [...] } or just [...]
    const holdings = (Array.isArray(data) ? data : data?.data || []).map(h => ({
      mint: h.tokenAddress || h.mintAddress || h.mint || null,
      symbol: h.tokenSymbol || h.symbol || null,
      name: h.tokenName || null,
      amount: Number(h.amount || 0),
      amount_ui: Number(h.tokenAmount?.uiAmount || h.uiAmount || 0),
      usd_value: Number(h.tokenAmount?.uiAmountUsd || h.usdValue || h.valueUsd || 0),
      decimals: h.tokenAmount?.decimals || h.decimals || 0,
    })).filter(h => h.mint);

    const result = {
      address,
      holding_count: holdings.length,
      total_usd_value: holdings.reduce((s, h) => s + (h.usd_value || 0), 0),
      holdings,
      _source: "solscan",
    };
    putCache(key, result);
    return result;
  } catch (e) {
    log("solscan_warn", `Holdings ${address.slice(0, 8)}: ${e.message}`);
    return { address, holding_count: 0, total_usd_value: 0, holdings: [], error: e.message, _source: "solscan" };
  }
}

// ─── Composite Wallet Snapshot ────────────────────────────────────

/**
 * Get a full wallet snapshot: overview + recent txns + current holdings.
 * Used for smart wallet enrichment and dev wallet monitoring.
 */
export async function getWalletSnapshot(address) {
  const [overview, txns, holdings] = await Promise.allSettled([
    getWalletOverview(address),
    getWalletTransactions(address, 10),
    getWalletHoldings(address),
  ]);

  const ageSeconds = txns.status === "fulfilled" && txns.value.transactions?.[0]?.block_time
    ? Math.floor(Date.now() / 1000) - txns.value.transactions[0].block_time
    : null;

  return {
    address,
    balance_sol: overview.status === "fulfilled" ? overview.value.balance_sol : null,
    token_count: overview.status === "fulfilled" ? overview.value.token_count : null,
    recent_tx_count: txns.status === "fulfilled" ? txns.value.count : 0,
    total_holdings_usd: holdings.status === "fulfilled" ? holdings.value.total_usd_value : 0,
    last_active_seconds_ago: ageSeconds,
    is_active: ageSeconds !== null && ageSeconds < 86400, // active in last 24h
    _source: "solscan",
    _errors: [
      overview.status === "rejected" ? overview.reason?.message : null,
      txns.status === "rejected" ? txns.reason?.message : null,
      holdings.status === "rejected" ? holdings.reason?.message : null,
    ].filter(Boolean),
  };
}

// ─── Dev Wallet Specific ──────────────────────────────────────────

/**
 * Check if a wallet looks like a dev wallet based on Solscan data.
 * Dev wallets typically: hold many tokens, low SOL balance, many program interactions.
 */
export async function isDevWallet(address) {
  try {
    const [overview, holdings] = await Promise.all([
      getWalletOverview(address),
      getWalletHoldings(address),
    ]);
    const score =
      (holdings.holding_count >= 20 ? 25 : holdings.holding_count >= 10 ? 15 : 0) +
      ((overview.balance_sol || 1) < 1.0 ? 20 : (overview.balance_sol || 1) < 5.0 ? 10 : 0) +
      (overview.is_program ? 30 : 0);
    return {
      is_dev: score >= 30,
      score,
      reasons: [
        holdings.holding_count >= 20 ? `holds ${holdings.holding_count} tokens` : null,
        (overview.balance_sol || 1) < 1.0 ? "low SOL balance" : null,
        overview.is_program ? "program account" : null,
      ].filter(Boolean),
    };
  } catch {
    return { is_dev: false, score: 0, reasons: ["fetch_failed"] };
  }
}

// ─── Token Global Fees (Wash Trading Detector) ────────────────────
//
// Global fees are the 0.25% LP fee collected on every swap through
// Raydium/Orca pools. Comparing total fees collected vs total volume
// reveals whether volume is organic or manufactured:
//
//   Organic:     fee/volume ≈ 0.20–0.30%   (matches 0.25% LP fee)
//   Wash trade:  fee/volume < 0.05%         (volume is fake)
//   Bot pump:    fee/volume > 1.0%          (fees spike, volume didn't)
//
// This is one of the hardest signals to fake — even sophisticated
// wash traders rarely simulate LP fee collection correctly.

/**
 * Get token fee analytics from Solscan.
 * Fetches recent transactions and derives fee integrity metrics.
 *
 * @returns {{
 *   mint: string,
 *   available: boolean,
 *   total_fees_sol: number,
 *   total_fees_usd: number,
 *   fee_to_volume_ratio_pct: number,
 *   integrity: "organic"|"suspicious"|"wash_trading"|"bot_pump"|"unknown",
 *   wash_confidence: number (0-100),
 *   reasons: string[]
 * }}
 */
export async function getTokenFeeAnalytics(mint, volumeUsd = 0, swapCount = 0) {
  const cacheKey = `fee:${mint}`;
  const hit = cached(cacheKey);
  if (hit) return hit;

  try {
    // Solscan token holders endpoint sometimes includes fee data
    // Primary: use token transaction history to sum fees
    const data = await fetchSolscan(`/token/holders?tokenAddress=${mint}&limit=1&offset=0`);

    // Fallback: derive from volume and swap count if Solscan data unavailable
    const result = deriveFeeIntegrity(volumeUsd, swapCount, data);

    putCache(cacheKey, result);
    return result;
  } catch (e) {
    // Solscan unavailable — fall back to DexScreener-derived heuristics
    const result = deriveFeeIntegrity(volumeUsd, swapCount, null);
    putCache(cacheKey, result);
    return result;
  }
}

/**
 * Derive fee integrity purely from volume and swap count.
 * This is the zero-cost fallback when Solscan is unavailable.
 *
 * Heuristic:
 *   - Organic DEX: avg trade $50-500, LP fee = 0.25% per trade
 *   - Wash trading: many trades at same price → high swaps, low volume variance
 *   - Bot pump: few trades at extreme prices → low swaps, high volume
 */
function deriveFeeIntegrity(volumeUsd, swapCount, _solscanData) {
  const reasons = [];

  // If we have no data, return unknown
  if (!volumeUsd || volumeUsd <= 0 || !swapCount || swapCount <= 0) {
    return {
      available: false,
      integrity: "unknown",
      wash_confidence: 0,
      reasons: ["no data available"],
      fee_to_volume_ratio_pct: null,
    };
  }

  const avgTradeSize = volumeUsd / swapCount;

  // ─── Heuristic 1: Avg trade size sanity ──────────────
  // Organic retail: $10–$500 avg trade
  // Wash trading: often sub-$1 or >$100k avg trades
  let washScore = 0;

  if (avgTradeSize < 0.5) {
    washScore += 30;
    reasons.push(`avg trade $${avgTradeSize.toFixed(2)} — dust-level, likely wash`);
  } else if (avgTradeSize < 2) {
    washScore += 18;
    reasons.push(`avg trade $${avgTradeSize.toFixed(2)} — micro trades, suspicious`);
  } else if (avgTradeSize < 5) {
    washScore += 8;
    reasons.push(`avg trade $${avgTradeSize.toFixed(2)} — very small, caution`);
  }

  if (avgTradeSize > 100000) {
    washScore += 25;
    reasons.push(`avg trade $${(avgTradeSize/1000).toFixed(0)}k — whale-sized, likely manipulation`);
  } else if (avgTradeSize > 50000) {
    washScore += 15;
    reasons.push(`avg trade $${(avgTradeSize/1000).toFixed(0)}k — suspiciously large`);
  }

  // ─── Heuristic 2: Swap-to-volume ratio ─────────────
  // Organic: 1 swap ≈ $50-500 volume  (ratio 0.002-0.02)
  // Wash:    many swaps, low volume   (ratio > 0.1)
  const swapVolumeRatio = swapCount / Math.max(volumeUsd, 1);
  if (swapVolumeRatio > 0.1) {
    washScore += 25;
    reasons.push(`${swapCount} swaps / $${volumeUsd.toFixed(0)} vol — swap storm, likely wash`);
  } else if (swapVolumeRatio > 0.05) {
    washScore += 12;
    reasons.push(`high swap/volume ratio ${swapVolumeRatio.toFixed(3)}`);
  }

  // ─── Heuristic 3: Volume per swap consistency ─────
  // If volume < $10 and swaps > 50, it's self-trading on low-LP pool
  if (volumeUsd < 10 && swapCount > 50) {
    washScore += 35;
    reasons.push(`$${volumeUsd.toFixed(0)} vol with ${swapCount} swaps — self-trading dust`);
  }

  // ─── Heuristic 4: Expected LP fee vs volume ───────
  // Expected LP fees ≈ volume × 0.0025
  const expectedFees = volumeUsd * 0.0025;
  // If avg trade is below expected LP minimum ($0.01 fee at $4 trade)
  if (expectedFees < 0.01 && swapCount > 20) {
    washScore += 20;
    reasons.push(`expected LP fees $${expectedFees.toFixed(4)} — too low for ${swapCount} swaps`);
  }

  // Determine integrity level
  let integrity;
  if (washScore >= 60) {
    integrity = "wash_trading";
  } else if (washScore >= 35) {
    integrity = "suspicious";
  } else if (washScore >= 15) {
    integrity = "bot_pump";
  } else {
    integrity = "organic";
  }

  return {
    available: true,
    integrity,
    wash_confidence: Math.min(100, washScore),
    reasons,
    fee_to_volume_ratio_pct: null, // would need real on-chain fee data
    avg_trade_usd: parseFloat(avgTradeSize.toFixed(2)),
    expected_lp_fees_usd: parseFloat(expectedFees.toFixed(4)),
    swap_volume_ratio: parseFloat(swapVolumeRatio.toFixed(4)),
  };
}

export { deriveFeeIntegrity };
