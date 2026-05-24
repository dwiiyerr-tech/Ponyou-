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
const SHYFT_BASE = "https://api.shyft.to/sol/v1";
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

function putDegradedCache(mint, value) {
  const degradedTtlMs = 5 * 60 * 1000;
  _signalCache.set(mint, {
    ts: Date.now() - (CACHE_TTL_MS - degradedTtlMs),
    value,
  });
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

// ─── Helius rate limiter + circuit breaker ────────────────────
//
// Rate limiter: slots spaced HELIUS_MIN_INTERVAL_MS apart, max HELIUS_MAX_CONCURRENT
// in-flight. Each acquirer claims a future slot synchronously so concurrent
// callers are serialised rather than thundering-herding.
//
// Circuit breaker: after HELIUS_CB_THRESHOLD consecutive 429s the circuit opens
// for HELIUS_CB_COOLDOWN_MS. During that window heliusAcquire() throws immediately
// so callers gracefully skip Helius enrichment rather than piling up retries.
// A single successful response resets the consecutive counter and closes the circuit.

const HELIUS_MAX_CONCURRENT   = 2;
const HELIUS_MIN_INTERVAL_MS  = 1500;   // ~0.67 req/s — well under free-tier burst
const HELIUS_CB_THRESHOLD     = 3;      // consecutive 429s before opening
const HELIUS_CB_COOLDOWN_MS   = 5 * 60 * 1000; // 5-minute cooldown

let _heliusInflight      = 0;
const _heliusQueue       = [];
let _heliusNextSlot      = 0;
let _helius429Streak     = 0;
let _heliusCBOpenUntil   = 0;           // epoch ms; 0 = circuit closed

export function heliusCircuitOpen() {
  return Date.now() < _heliusCBOpenUntil;
}

export function helius429Hit() {
  _helius429Streak++;
  if (_helius429Streak >= HELIUS_CB_THRESHOLD && !heliusCircuitOpen()) {
    _heliusCBOpenUntil = Date.now() + HELIUS_CB_COOLDOWN_MS;
    log("helius_cb", `Circuit OPEN — ${_helius429Streak} consecutive 429s. Pausing Helius calls for 5 min.`);
  }
}

export function heliusSuccess() {
  if (_helius429Streak > 0) _helius429Streak = 0;
  if (heliusCircuitOpen()) {
    _heliusCBOpenUntil = 0;
    log("helius_cb", "Circuit CLOSED — Helius responding normally.");
  }
}

export async function heliusAcquire() {
  if (heliusCircuitOpen()) throw new Error("Helius circuit open");

  // Wait for an inflight slot.
  while (_heliusInflight >= HELIUS_MAX_CONCURRENT) {
    await new Promise(resolve => _heliusQueue.push(resolve));
  }
  _heliusInflight++;

  // Claim a unique time-slot synchronously before any await.
  const now = Date.now();
  const slot = Math.max(now, _heliusNextSlot);
  _heliusNextSlot = slot + HELIUS_MIN_INTERVAL_MS;
  if (slot > now) {
    await new Promise(r => setTimeout(r, slot - now));
  }

  // Re-check after sleeping — circuit may have opened while we waited.
  if (heliusCircuitOpen()) {
    _heliusInflight--;
    const next = _heliusQueue.shift();
    if (next) next();
    throw new Error("Helius circuit open");
  }
}

export function heliusRelease() {
  _heliusInflight--;
  const next = _heliusQueue.shift();
  if (next) next();
}

async function fetchHeliusTxns(address, apiKey, limit = 30, type = null) {
  const t = type ? `&type=${type}` : "";
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}${t}`;

  await heliusAcquire();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 429) {
      helius429Hit();
      throw new Error("Helius 429");
    }
    if (!res.ok) throw new Error(`Helius ${res.status}`);
    heliusSuccess();
    return await res.json();
  } finally {
    heliusRelease();
  }
}

export async function fetchShyftHolders(mint, apiKey, limit = 20) {
  try {
    const url = `${SHYFT_BASE}/token/holders?network=mainnet-beta&token_address=${mint}&size=${limit}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Shyft holders ${res.status}`);

    const body = await res.json();
    const holders = Array.isArray(body?.result)
      ? body.result
      : Array.isArray(body?.result?.holders)
        ? body.result.holders
        : Array.isArray(body?.holders)
          ? body.holders
          : [];

    return holders
      .map(h => ({
        owner: h.owner || h.owner_address || h.address || h.wallet || h.holder,
        amount: Number(h.amount ?? h.balance ?? h.quantity ?? h.ui_amount ?? 0),
      }))
      .filter(h => h.owner);
  } catch (e) {
    log("rug_signal_warn", `shyftHolders ${mint.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

function getShyftTxTimestamp(tx) {
  const raw = tx.timestamp ?? tx.blockTime ?? tx.block_time ?? tx.time;
  if (Number.isFinite(Number(raw))) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export async function getFreshFundedCountShyft(mint, apiKey) {
  try {
    const holders = await fetchShyftHolders(mint, apiKey);
    let fresh = 0;
    let scanned = 0;
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 3600);

    for (const holder of holders) {
      try {
        const url = `${SHYFT_BASE}/transaction/history?network=mainnet-beta&account=${holder.owner}&tx_num=10`;
        const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`Shyft tx history ${res.status}`);

        const body = await res.json();
        const txns = Array.isArray(body?.result)
          ? body.result
          : Array.isArray(body?.result?.transactions)
            ? body.result.transactions
            : Array.isArray(body?.transactions)
              ? body.transactions
              : [];
        if (!txns.length) continue;

        scanned++;
        const firstTs = getShyftTxTimestamp(txns[0]);
        if (firstTs && firstTs >= sevenDaysAgo) fresh++;
      } catch (e) {
        log("rug_signal_warn", `shyftFreshFunded ${holder.owner.slice(0, 8)}: ${e.message}`);
      }
    }

    return { fresh_funded_holders: fresh, scanned, _source: "shyft" };
  } catch (e) {
    return { fresh_funded_holders: 0, scanned: 0, _source: "shyft", _error: e.message };
  }
}

/**
 * For each top holder, find their earliest SOL receive (= account funding).
 * Count holders funded within `maxAgeHours` of token launch.
 */
export async function getFreshFundedCount(holderOwners, apiKey, launchTs, maxAgeHours = 24) {
  if (!apiKey || !holderOwners.length) return { fresh_funded_holders: 0, scanned: 0 };

  let fresh = 0;
  let scanned = 0;
  let errorCount = 0;
  let lastError = null;
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
    } catch (e) {
      errorCount++;
      lastError = e.message;
      log("rug_signal_warn", `freshFunded ${owner.slice(0, 8)}: ${e.message}`);
    }
  }
  return {
    fresh_funded_holders: fresh,
    scanned,
    _error_count: errorCount,
    _error: lastError,
  };
}

/**
 * Detect sybil cluster: top holders sharing a common funding source.
 * Returns the largest cluster size (e.g. 4 = "4 of top holders funded by same wallet").
 */
export async function getSameFunderCluster(holderOwners, apiKey) {
  if (!apiKey || holderOwners.length < 2) return { same_funder_holders: 0, common_funder: null };

  const funderCounts = new Map();
  let scanned = 0;
  let errorCount = 0;
  let lastError = null;

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
    } catch (e) {
      errorCount++;
      lastError = e.message;
      log("rug_signal_warn", `sameFunder ${owner.slice(0, 8)}: ${e.message}`);
    }
  }

  let maxCluster = 0;
  let commonFunder = null;
  for (const [funder, count] of funderCounts.entries()) {
    if (count > maxCluster) { maxCluster = count; commonFunder = funder; }
  }
  return {
    same_funder_holders: maxCluster,
    common_funder: commonFunder,
    scanned,
    _error_count: errorCount,
    _error: lastError,
  };
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
        t => t.mint === mint && t.toUserAccount
      );
      if (buys.length === 0) continue;

      // Bundle heuristic: >1 distinct receiver of the target mint in one tx is
      // unusual for organic swaps (router → user is 1 receiver). Treat such txs
      // as bundle-buyer activity.
      const distinctReceivers = new Set(buys.map(b => b.toUserAccount));
      const isBundleTx = distinctReceivers.size > 1;

      for (const b of buys) {
        bundleBuyers.add(b.toUserAccount);
        const amt = b.tokenAmount || 0;
        totalEarlyTokenAmount += amt;
        if (isBundleTx) bundleTokenAmount += amt;
      }
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

function parseHolderTimestampMs(value) {
  if (value == null) return null;
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function holderSupplyValue(holder = {}, pctMode = false) {
  if (pctMode) return Number(holder.pct ?? holder.percentage ?? holder.percent ?? 0) || 0;
  return Number(holder.balance ?? holder.amount ?? holder.quantity ?? holder.ui_amount ?? 0) || 0;
}

export function detectBundledLaunch({ holders = [], creationWindowMs = 60 * 60 * 1000 } = {}) {
  const list = Array.isArray(holders) ? holders : [];
  const groups = new Map();

  for (const holder of list) {
    const funder = holder?.funded_by;
    if (!funder) continue;
    const fundedAt = parseHolderTimestampMs(holder.funded_at);
    if (!Number.isFinite(fundedAt)) continue;
    if (!groups.has(funder)) groups.set(funder, []);
    groups.get(funder).push(fundedAt);
  }

  let bundledScore = 0;
  for (const times of groups.values()) {
    times.sort((a, b) => a - b);
    let left = 0;
    for (let right = 0; right < times.length; right++) {
      while (times[right] - times[left] > creationWindowMs) left++;
      bundledScore = Math.max(bundledScore, right - left + 1);
    }
  }

  const pctMode = list.some(h => Number.isFinite(Number(h?.pct ?? h?.percentage ?? h?.percent)));
  const values = list
    .map(holder => holderSupplyValue(holder, pctMode))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
  const top20 = values.slice(0, 20).reduce((sum, value) => sum + value, 0);
  const total = pctMode ? 100 : values.reduce((sum, value) => sum + value, 0);
  const top20Pct = total > 0 ? Number(((top20 / total) * 100).toFixed(2)) : 0;

  return {
    bundled: bundledScore > 5,
    bundled_score: bundledScore,
    supply_concentrated: top20Pct > 60,
    top20_pct: top20Pct,
  };
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
  const heliusExpected = !!(heliusOK && (holderOwners.length > 0 || launchTs));

  const extensions = await getMintExtensions(connection, mint);

  const dexscreenerOnly = process.env.SCREENING_MODE === "dexscreener";

  let fresh = { fresh_funded_holders: 0 };
  let sybil = { same_funder_holders: 0, common_funder: null };
  let bundle = { bundle_buyers_pct: 0, bundle_wallets: 0 };
  let heliusDegraded = false;
  let heliusReason = null;
  let heliusErrorCount = 0;
  let shyftFallbackUsed = false;
  let shyftReason = null;

  if (dexscreenerOnly) {
    // DexScreener-only mode — skip all Helius/Shyft wallet analysis.
    // Only DexScreener-derived metrics (LP lock, wash trade, holder conc).
    heliusDegraded = false;
    heliusReason = "dexscreener_only_mode";
  } else if (heliusExpected && heliusCircuitOpen()) {
    // Try Shyft fallback first.
    const shyftKey = process.env.SHYFT_API_KEY;
    if (shyftKey && holderOwners.length > 0) {
      let shyftError = null;
      try {
        const shyftResult = await getFreshFundedCountShyft(mint, shyftKey);
        shyftError = shyftResult?._error ? new Error(shyftResult._error) : null;
        if (shyftResult == null || shyftResult === 0 || Number(shyftResult?.fresh_funded_holders || 0) === 0 || shyftError) {
          heliusDegraded = true;
          heliusReason = "Helius circuit open, Shyft fallback degraded";
          shyftReason = shyftError?.message || "empty_response";
        } else {
          fresh = shyftResult;
          shyftFallbackUsed = true;
          heliusReason = "helius_circuit_open:shyft_fallback_used";
          log("rug_signal_info", `Shyft fallback: fresh_funded=${fresh.fresh_funded_holders}`);
        }
      } catch (e) {
        shyftError = e;
        heliusDegraded = true;
        heliusReason = `Helius circuit open, Shyft fallback failed: ${e.message}`;
        shyftReason = shyftError?.message || "empty_response";
      }
    } else {
      heliusDegraded = true;
      heliusReason = "Helius circuit open, no Shyft key configured";
    }
  }

  if (!dexscreenerOnly && !shyftFallbackUsed && !heliusDegraded && heliusOK && holderOwners.length > 0) {
    fresh = await getFreshFundedCount(holderOwners, apiKey, launchTs || Math.floor(Date.now() / 1000));
    sybil = await getSameFunderCluster(holderOwners, apiKey);
    heliusErrorCount += Number(fresh?._error_count || 0) + Number(sybil?._error_count || 0);
    heliusReason = fresh?._error || sybil?._error || heliusReason;
    if ((Number(fresh?._error_count || 0) > 0 && Number(fresh?.scanned || 0) === 0) ||
        (Number(sybil?._error_count || 0) > 0 && Number(sybil?.scanned || 0) === 0)) {
      heliusDegraded = true;
    }
  }
  if (!dexscreenerOnly && !shyftFallbackUsed && !heliusDegraded && heliusOK && launchTs) {
    bundle = await getBundleBuyersPct(mint, apiKey, launchTs);
    if (bundle?._error) {
      heliusDegraded = true;
      heliusReason = bundle._error;
      heliusErrorCount += 1;
    }
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
    _helius_used: dexscreenerOnly ? false : heliusOK,
    _helius_expected: dexscreenerOnly ? false : heliusExpected,
    _helius_degraded: heliusDegraded,
    _data_quality: dexscreenerOnly ? "dexscreener" : (heliusDegraded ? "degraded" : "full"),
    _helius_reason: heliusReason,
    _shyft_reason: shyftReason,
    _helius_error_count: heliusErrorCount,
    _ts: Date.now(),
  };

  if (heliusDegraded) {
    putDegradedCache(mint, signals);
  } else {
    putCache(mint, signals);
  }
  return signals;
}

export function clearSignalCache() {
  _signalCache.clear();
}
