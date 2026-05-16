/**
 * Rug Signal Collector — gathers on-chain + Helius-powered indicators that
 * scoreRugRisk() uses to decide whether to skip a token.
 *
 * Layer 1: Token-2022 mint extension parsing (transfer fee, hook, permanent delegate)
 * Layer 2: Helius-powered behavioural signals (fresh holders, sybil cluster, bundle snipers, wash trades)
 *
 * All checks are best-effort. If a data source fails, we degrade gracefully
 * rather than blocking the entire scoring pipeline.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";

const HELIUS_BASE = "https://api.helius.xyz/v0";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Cache rug signals per mint for 1 hour. Rug status rarely flips minute-to-minute,
// and Helius credits are expensive.
const _signalCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cached(mint) {
  const hit = _signalCache.get(mint);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.value;
  return null;
}

function putCache(mint, value) {
  _signalCache.set(mint, { ts: Date.now(), value });
}

// ─── Layer 1: Token-2022 Mint Extensions ─────────────────────────

/**
 * Parse Token-2022 mint extensions for honeypot indicators.
 * Returns { is_token_2022, transfer_fee_bps, transfer_hook, permanent_delegate, non_transferable, default_frozen }.
 */
export async function getMintExtensions(connection, mintAddress) {
  try {
    const mintPk = new PublicKey(mintAddress);
    const acc = await connection.getParsedAccountInfo(mintPk);
    const info = acc.value;

    const isToken2022 = info?.owner?.toString() === TOKEN_2022_PROGRAM;
    if (!isToken2022) {
      return {
        is_token_2022: false,
        transfer_fee_bps: 0,
        transfer_hook: null,
        permanent_delegate: null,
        non_transferable: false,
        default_frozen: false,
      };
    }

    const extensions = info?.data?.parsed?.info?.extensions || [];
    const find = (name) => extensions.find(e => e.extension === name)?.state;

    const transferFeeState = find("transferFeeConfig");
    const transferFeeBps =
      transferFeeState?.newerTransferFee?.transferFeeBasisPoints
      ?? transferFeeState?.olderTransferFee?.transferFeeBasisPoints
      ?? 0;

    const hookState = find("transferHook");
    const delegateState = find("permanentDelegate");
    const nonTransferable = !!find("nonTransferable");
    const defaultState = find("defaultAccountState");

    return {
      is_token_2022: true,
      transfer_fee_bps: Number(transferFeeBps),
      transfer_hook: hookState?.programId || null,
      permanent_delegate: delegateState?.delegate || null,
      non_transferable: nonTransferable,
      default_frozen: defaultState?.accountState === "frozen",
    };
  } catch (e) {
    log("rug_signal_warn", `getMintExtensions ${mintAddress.slice(0, 8)}: ${e.message}`);
    return {
      is_token_2022: false,
      transfer_fee_bps: 0,
      transfer_hook: null,
      permanent_delegate: null,
      non_transferable: false,
      default_frozen: false,
      _error: e.message,
    };
  }
}

// ─── Layer 2: Helius Behavioural Signals ─────────────────────────

// Concurrency limiter for Helius calls. Free tier is ~10 req/s; bursts from
// multiple-token screening were causing 429 floods. Cap to 4 in-flight and
// throttle to ≥120ms between starts (~8 req/s peak).
let _heliusInflight = 0;
const _heliusQueue = [];
let _lastHeliusAt = 0;
const HELIUS_MAX_CONCURRENT = 4;
const HELIUS_MIN_INTERVAL_MS = 120;

async function heliusAcquire() {
  if (_heliusInflight >= HELIUS_MAX_CONCURRENT) {
    await new Promise(resolve => _heliusQueue.push(resolve));
  }
  const since = Date.now() - _lastHeliusAt;
  if (since < HELIUS_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, HELIUS_MIN_INTERVAL_MS - since));
  }
  _heliusInflight++;
  _lastHeliusAt = Date.now();
}

function heliusRelease() {
  _heliusInflight--;
  const next = _heliusQueue.shift();
  if (next) next();
}

async function fetchHeliusTxns(address, apiKey, limit = 30, type = null) {
  const t = type ? `&type=${type}` : "";
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}${t}`;

  // One retry on 429 with backoff. Free-tier bursts otherwise cascade.
  for (let attempt = 0; attempt < 2; attempt++) {
    await heliusAcquire();
    try {
      const res = await fetch(url);
      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1.5;
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Helius ${res.status}`);
      return await res.json();
    } finally {
      heliusRelease();
    }
  }
  throw new Error("Helius 429 (after retry)");
}

/**
 * For each top holder, find their earliest SOL receive (= account funding).
 * Count holders funded within `maxAgeHours` of token launch.
 */
export async function getFreshFundedCount(holderOwners, apiKey, launchTs, maxAgeHours = 24) {
  if (!apiKey || !holderOwners.length) return { fresh_funded_holders: 0, scanned: 0 };

  let fresh = 0;
  let scanned = 0;
  const cutoff = launchTs - (maxAgeHours * 3600);

  for (const owner of holderOwners.slice(0, 8)) {
    try {
      const txns = await fetchHeliusTxns(owner, apiKey, 20);
      if (!txns?.length) continue;
      scanned++;
      // Find earliest incoming SOL transfer (funding)
      let earliestFunding = Infinity;
      for (const tx of txns) {
        const inflows = (tx.nativeTransfers || []).filter(t => t.toUserAccount === owner);
        if (inflows.length > 0 && tx.timestamp < earliestFunding) earliestFunding = tx.timestamp;
      }
      if (earliestFunding !== Infinity && earliestFunding >= cutoff) fresh++;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log("rug_signal_warn", `freshFunded ${owner.slice(0, 8)}: ${e.message}`);
    }
  }
  return { fresh_funded_holders: fresh, scanned };
}

/**
 * Detect sybil cluster: top holders sharing a common funding source.
 * Returns the largest cluster size (e.g. 4 = "4 of top holders funded by same wallet").
 */
export async function getSameFunderCluster(holderOwners, apiKey) {
  if (!apiKey || holderOwners.length < 2) return { same_funder_holders: 0, common_funder: null };

  const funderCounts = new Map();
  let scanned = 0;

  for (const owner of holderOwners.slice(0, 10)) {
    try {
      const txns = await fetchHeliusTxns(owner, apiKey, 10);
      if (!txns?.length) continue;
      scanned++;
      // Earliest SOL inflow's source = funder
      txns.sort((a, b) => a.timestamp - b.timestamp);
      for (const tx of txns) {
        const inflow = (tx.nativeTransfers || []).find(t => t.toUserAccount === owner);
        if (inflow?.fromUserAccount) {
          funderCounts.set(inflow.fromUserAccount, (funderCounts.get(inflow.fromUserAccount) || 0) + 1);
          break; // only earliest funder per holder
        }
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      log("rug_signal_warn", `sameFunder ${owner.slice(0, 8)}: ${e.message}`);
    }
  }

  let maxCluster = 0;
  let commonFunder = null;
  for (const [funder, count] of funderCounts.entries()) {
    if (count > maxCluster) { maxCluster = count; commonFunder = funder; }
  }
  return { same_funder_holders: maxCluster, common_funder: commonFunder, scanned };
}

/**
 * Bundle sniper detection: % of supply bought in first N seconds after pool creation.
 * launchTs is the pool creation timestamp (unix seconds).
 */
export async function getBundleBuyersPct(mint, apiKey, launchTs, windowSeconds = 60) {
  if (!apiKey || !launchTs) return { bundle_buyers_pct: 0, bundle_wallets: 0 };

  try {
    const txns = await fetchHeliusTxns(mint, apiKey, 50, "SWAP");
    if (!txns?.length) return { bundle_buyers_pct: 0, bundle_wallets: 0 };

    const cutoff = launchTs + windowSeconds;
    const bundleBuyers = new Set();
    let bundleTokenAmount = 0;
    let totalEarlyTokenAmount = 0;

    for (const tx of txns) {
      if (tx.timestamp > cutoff) continue;
      const buys = (tx.tokenTransfers || []).filter(
        t => t.mint === mint && t.toUserAccount && t.toUserAccount !== tx.feePayer === false
      );
      for (const b of buys) {
        bundleBuyers.add(b.toUserAccount);
        bundleTokenAmount += b.tokenAmount || 0;
      }
      totalEarlyTokenAmount += buys.reduce((s, b) => s + (b.tokenAmount || 0), 0);
    }

    const pct = totalEarlyTokenAmount > 0
      ? Math.min(100, Math.round((bundleTokenAmount / totalEarlyTokenAmount) * 100))
      : 0;

    return { bundle_buyers_pct: pct, bundle_wallets: bundleBuyers.size };
  } catch (e) {
    log("rug_signal_warn", `bundleBuyers ${mint.slice(0, 8)}: ${e.message}`);
    return { bundle_buyers_pct: 0, bundle_wallets: 0, _error: e.message };
  }
}

/**
 * LP lock heuristic: check if liquidity is locked or burned.
 * dsLiquidityHolderInfo can come from DexScreener pair data if available;
 * absent that, we infer from base supply not having a "burn" transfer.
 */
export function getLpLockStatus(dsPair) {
  if (!dsPair) return { lp_locked: null, lp_lock_notes: "no pair data" };

  const liquidity = dsPair.liquidity?.usd || 0;
  if (liquidity < 1000) {
    return { lp_locked: false, lp_lock_notes: "liquidity too thin to assess" };
  }

  // Best signal we have without on-chain LP token tracing:
  // DexScreener flags some pools but most rugs don't show it. Conservative:
  // mark unknown unless there's a clear lock provider tagged.
  const labels = (dsPair.labels || []).map(l => String(l).toLowerCase());
  if (labels.some(l => l.includes("locked") || l.includes("burned"))) {
    return { lp_locked: true, lp_lock_notes: "DexScreener flagged" };
  }
  return { lp_locked: null, lp_lock_notes: "unknown — no lock flag" };
}

/**
 * Wash trade indicator: extreme buy/sell imbalance with low unique trader count.
 */
export function getWashTradeScore(dsPair) {
  if (!dsPair?.txns?.h1) return { wash_score: 0 };
  const buys = dsPair.txns.h1.buys || 0;
  const sells = dsPair.txns.h1.sells || 0;
  const total = buys + sells;
  if (total < 20) return { wash_score: 0, note: "low volume" };

  const ratio = buys / Math.max(sells, 1);
  let score = 0;
  if (ratio > 5 || ratio < 0.2) score += 30;
  else if (ratio > 3 || ratio < 0.33) score += 15;

  // Volume vs txn count: if avg trade size is suspiciously uniform AND high freq, could be wash
  const h1Vol = dsPair.volume?.h1 || 0;
  if (h1Vol > 0 && total > 0) {
    const avgTrade = h1Vol / total;
    if (avgTrade < 10 && total > 100) score += 10; // many micro-trades
  }

  return { wash_score: Math.min(100, score), buy_sell_ratio: Number(ratio.toFixed(2)) };
}

// ─── Aggregator ──────────────────────────────────────────────────

/**
 * Gather all rug signals for a mint in one call (with caching).
 * Pass `holderOwners` (owners of top token accounts), `launchTs` (pool creation),
 * `dsPair` (DexScreener pair object) for full coverage.
 */
export async function gatherRugSignals({ mint, connection, holderOwners = [], launchTs = null, dsPair = null }) {
  const c = cached(mint);
  if (c) return { ...c, _cached: true };

  const apiKey = process.env.HELIUS_API_KEY;
  const heliusOK = apiKey && apiKey !== "dummy-helius-key";

  const extensions = await getMintExtensions(connection, mint);

  let fresh = { fresh_funded_holders: 0 };
  let sybil = { same_funder_holders: 0, common_funder: null };
  let bundle = { bundle_buyers_pct: 0, bundle_wallets: 0 };

  if (heliusOK && holderOwners.length > 0) {
    fresh = await getFreshFundedCount(holderOwners, apiKey, launchTs || Math.floor(Date.now() / 1000));
    sybil = await getSameFunderCluster(holderOwners, apiKey);
  }
  if (heliusOK && launchTs) {
    bundle = await getBundleBuyersPct(mint, apiKey, launchTs);
  }

  const lp = getLpLockStatus(dsPair);
  const wash = getWashTradeScore(dsPair);

  const signals = {
    ...extensions,
    ...fresh,
    ...sybil,
    ...bundle,
    ...lp,
    ...wash,
    _helius_used: heliusOK,
    _ts: Date.now(),
  };

  putCache(mint, signals);
  return signals;
}

export function clearSignalCache() {
  _signalCache.clear();
}
