/**
 * Rug Signal Collector — gathers on-chain + behavioural indicators that
 * scoreRugRisk() uses to decide whether to skip a token.
 *
 * Layer 1: Token-2022 mint extension parsing (transfer fee, hook, permanent delegate)
 * Layer 2a: GMGN-powered signals (bundler/sniper/rat tags — primary when key available)
 * Layer 2b: Helius-powered signals (fresh holders, sybil cluster, bundle snipers — fallback)
 *
 * All checks are best-effort. If a data source fails, we degrade gracefully
 * rather than blocking the entire scoring pipeline.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";
import { getTopHolders as gmgnTopHolders, getTokenSecurity as gmgnTokenSecurity, normalizeTopHolder, isGmgnEnabled, gmgnCircuitOpen } from "./gmgn.js";
import { config } from "../config.js";

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

const HELIUS_MAX_CONCURRENT   = 1;      // Reduced to 1 for free tier stability
const HELIUS_MIN_INTERVAL_MS  = 2500;   // Increased to 2.5s (~0.4 req/s) for free tier
const HELIUS_CB_THRESHOLD     = 2;      // Reduced threshold to 2 consecutive 429s
const HELIUS_CB_COOLDOWN_MS   = 10 * 60 * 1000; // Increased to 10-minute cooldown

let _heliusInflight      = 0;
const _heliusQueue       = [];
let _heliusNextSlot      = 0;
let _helius429Streak     = 0;
let _heliusCBOpenUntil   = 0;           // epoch ms; 0 = circuit closed
let _heliusReopens       = 0;           // persists across cooldowns; reset only on genuine recovery

export function heliusCircuitOpen() {
  return Date.now() < _heliusCBOpenUntil;
}

export function helius429Hit() {
  _helius429Streak++;
  if (_helius429Streak >= HELIUS_CB_THRESHOLD && !heliusCircuitOpen()) {
    // Exponential backoff keyed on persistent re-open count (not the per-window
    // streak, which resets on the first probe success). When Helius is structurally
    // rate-limited the breaker re-opens every cooldown; escalating off _heliusReopens
    // pins it to the max cap instead of restarting from the minimum each time.
    _heliusReopens++;
    const cooldown = Math.min(HELIUS_CB_COOLDOWN_MS * (2 ** (_heliusReopens - 1)), 30 * 60 * 1000);
    _heliusCBOpenUntil = Date.now() + cooldown;
    log("helius_cb", `Circuit OPEN — ${_helius429Streak} consecutive 429s (re-open #${_heliusReopens}). Pausing Helius calls for ${Math.round(cooldown / 60000)} min.`);
  }
}

export function heliusSuccess() {
  if (_helius429Streak > 0) _helius429Streak = 0;
  if (heliusCircuitOpen()) {
    _heliusCBOpenUntil = 0;
    _heliusReopens = 0;   // genuine recovery — clear escalation so future backoff restarts small
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

/**
 * Fetch a token's circulating supply from Shyft (UI-scaled). Needed to turn
 * Shyft's per-holder `amount` into a % -of-supply figure for the dump monitor.
 * Returns 0 when unavailable so callers can fall back to an RPC supply source.
 */
export async function fetchShyftTokenSupply(mint, apiKey) {
  try {
    const url = `${SHYFT_BASE}/token/get_info?network=mainnet-beta&token_address=${mint}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Shyft token info ${res.status}`);
    const body = await res.json();
    const r = body?.result || body || {};
    const supply = Number(r.current_supply ?? r.supply ?? r.total_supply ?? 0);
    return Number.isFinite(supply) && supply > 0 ? supply : 0;
  } catch (e) {
    log("rug_signal_warn", `shyftTokenSupply ${mint.slice(0, 8)}: ${e.message}`);
    return 0;
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
      // "Fresh funded" = wallet first funded around launch (insider/sybil prep),
      // not a normal buyer whose first-ever funding came well after launch.
      // Bound the window to [launch-maxAgeHours, launch+maxAgeHours].
      const upper = launchTs + (maxAgeHours * 3600);
      if (earliestFunding !== Infinity && earliestFunding >= cutoff && earliestFunding <= upper) fresh++;
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
/**
 * Normalize GMGN /token/security into stable booleans/numbers. GMGN returns a
 * mix of strings ("0.05"), 0/1 ints, and nulls; only treat EXPLICIT positives as
 * signals (null = unknown, never a flag). Tax fields are ratios (0.05 = 5%); a
 * value > 1 is interpreted as a raw percent. VERIFIED live 2026-05-31.
 */
export function normalizeGmgnSecurity(sec) {
  if (!sec || typeof sec !== "object") return null;
  const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const frac = (v) => { const n = numOr(v); return n == null ? null : (n > 1 ? n / 100 : n); };
  return {
    // T3-10: GMGN may return boolean-flags as strings ("1"/"0") or booleans.
    // Use Number() coercion so "1", 1, and true all register correctly.
    honeypot:        Number(sec.honeypot) === 1 || sec.is_honeypot === true,
    cannot_sell:     Number(sec.can_not_sell) === 1,
    blacklist:       Number(sec.blacklist) === 1 || sec.is_blacklist === true,
    // Only flag when EXPLICITLY not renounced (false); null/true are not a risk.
    mint_not_renounced:   sec.renounced_mint === false,
    freeze_not_renounced: sec.renounced_freeze_account === false,
    buy_tax:         frac(sec.buy_tax),
    sell_tax:        frac(sec.sell_tax),
    top10_rate:      frac(sec.top_10_holder_rate),
    lp_locked:       sec.lock_summary?.is_locked === true,
    burn_ratio:      frac(sec.burn_ratio),
    hide_risk:       sec.hide_risk === true,
    _source: "gmgn",
  };
}

export async function gatherRugSignals({ mint, connection, holderOwners = [], launchTs = null, dsPair = null, chain = "sol" }) {
  const c = cached(`${chain}:${mint}`);
  if (c) return { ...c, _cached: true };

  // Solana-only data paths (Token-2022 mint extensions, Helius/Shyft holder
  // analysis, RugCheck) don't apply to EVM chains. For non-sol, GMGN security +
  // holder tags become the PRIMARY rug signal; the Solana-RPC layers are skipped.
  const isSol = chain === "sol";

  const apiKey = process.env.HELIUS_API_KEY;
  const heliusApiFlag = process.env.HELIUS_API_ENABLED;
  const heliusApiEnabled = heliusApiFlag === "true" ? true : heliusApiFlag !== "false";
  const heliusFallbackFlag = process.env.HELIUS_FALLBACK;
  const heliusFallbackAllowed = heliusFallbackFlag === "true"
    ? true
    : heliusFallbackFlag === "false"
      ? false
      : config.gmgn?.heliusFallback !== false;
  // Helius is Solana-only — never available for EVM chains.
  const heliusFallbackEnabled = isSol && heliusApiEnabled && heliusFallbackAllowed;
  const heliusOK = heliusFallbackEnabled && apiKey && apiKey !== "dummy-helius-key";
  const heliusExpected = !!(heliusOK && (holderOwners.length > 0 || launchTs));

  // Token-2022 extension parsing is a Solana mint concept — skip for EVM.
  const extensions = isSol ? await getMintExtensions(connection, mint) : {};

  const dexscreenerOnly = process.env.SCREENING_MODE === "dexscreener";
  const gmgnCircuitIsOpen = gmgnCircuitOpen();
  const gmgnRugSignalsEnabled = !dexscreenerOnly && isGmgnEnabled() && !gmgnCircuitIsOpen && config.gmgn?.rugSignals !== false;

  let fresh = { fresh_funded_holders: 0 };
  let sybil = { same_funder_holders: 0, common_funder: null };
  let bundle = { bundle_buyers_pct: 0, bundle_wallets: 0 };
  let heliusDegraded = false;
  let heliusReason = null;
  let heliusErrorCount = 0;
  let shyftFallbackUsed = false;
  let shyftReason = null;
  let gmgnUsed = false;
  let gmgnError = false; // true only when GMGN threw — empty response = token not indexed, not an error
  let gmgnSecurity = null;
  let criticalRugTelemetryDegraded = false;
  let criticalRugTelemetryReason = null;

  // T2-3: For EVM chains, GMGN is the SOLE rug-signal source — there is no
  // Helius fallback for Base/BSC/Eth. If the GMGN circuit is open, we have
  // zero rug data and the token must be treated as unverifiable, not clean.
  if (!isSol && gmgnCircuitIsOpen) {
    criticalRugTelemetryDegraded = true;
    criticalRugTelemetryReason = "GMGN circuit open — EVM rug telemetry unavailable (no Helius fallback for non-SOL)";
    log("rug_telemetry_block", `${mint.slice(0, 8)} chain=${chain} telemetry_block=true reason="${criticalRugTelemetryReason}"`);
  }

  // ── Layer 2a: GMGN-powered signals (primary — no rate-limit cost on Helius) ──
  // GMGN top-holder tags encode exactly what Helius txn-parsing was computing:
  //   bundler → wallet funded by same parent in short window (fresh + sybil)
  //   sniper  → wallet bought in first seconds after pool creation (bundle buyer)
  //   rat     → known pump-and-dump wallet (extra fresh-funded signal)
  //
  // Empty response (gmgnHolders.length === 0) means the token is not yet indexed
  // by GMGN — common for fresh/micro-cap mints. This is NOT a failure; fall through
  // to dexscreener-only scoring. criticalRugTelemetryDegraded is only raised when
  // GMGN actually throws (auth failure, network error, etc.).
  if (gmgnRugSignalsEnabled) {
    try {
      const gmgnHolders = await gmgnTopHolders(mint, 20, chain);
      if (Array.isArray(gmgnHolders) && gmgnHolders.length > 0) {
        const norm = gmgnHolders.map(normalizeTopHolder);
        const bundlers = norm.filter(h => h.tags.bundler);
        const snipers  = norm.filter(h => h.tags.sniper);
        const rats     = norm.filter(h => h.tags.rat);

        // fresh_funded: bundlers + rats are wallets created/funded close to launch
        fresh = { fresh_funded_holders: bundlers.length + rats.length, scanned: norm.length, _source: "gmgn" };
        // same_funder: bundlers are clustered by common funder by definition
        sybil = { same_funder_holders: bundlers.length, common_funder: null, scanned: norm.length, _source: "gmgn" };
        // bundle_buyers: snipers bought in the first window after launch
        const snipedPct = snipers.reduce((sum, h) => sum + (Number(h.pct) || 0), 0);
        bundle = { bundle_buyers_pct: Math.min(100, Math.round(snipedPct)), bundle_wallets: snipers.length, _source: "gmgn" };

        gmgnUsed = true;
        heliusReason = "gmgn_primary";
      } else if (gmgnHolders === null) {
        // gmgnFetch returns null for network/auth/rate-limit failures (it never throws).
        // null = actual failure; empty array = token not yet indexed by GMGN (not an error).
        gmgnError = true;
      }
      // empty array: token not in GMGN index yet — fall through to dexscreener-only
    } catch (e) {
      gmgnError = true;
      log("rug_signal_warn", `GMGN rug signals ${mint.slice(0, 8)}: ${e.message}`);
    }
    // GMGN security audit — rich rug fields (honeypot, sellability, renounce
    // status, trade tax). Additive: feeds scoreRugRisk's gmgn_security block.
    // Best-effort; never blocks the holder-signal path above.
    try {
      gmgnSecurity = normalizeGmgnSecurity(await gmgnTokenSecurity(mint, chain));
    } catch (e) {
      log("rug_signal_warn", `GMGN security ${mint.slice(0, 8)}: ${e.message}`);
    }
  }

  // ── Layer 2b: Helius fallback (only when GMGN unavailable or returned empty) ──
  if (!dexscreenerOnly && !gmgnUsed && heliusFallbackEnabled) {
    if (heliusExpected && heliusCircuitOpen()) {
      // Helius circuit open — try Shyft fallback for fresh-funded check only
      const shyftKey = process.env.SHYFT_API_KEY;
      if (shyftKey && holderOwners.length > 0) {
        try {
          const shyftResult = await getFreshFundedCountShyft(mint, shyftKey);
          const shyftErr = shyftResult?._error ? new Error(shyftResult._error) : null;
          if (!shyftErr && shyftResult?.fresh_funded_holders != null) {
            fresh = shyftResult;
            shyftFallbackUsed = true;
            heliusReason = "helius_circuit_open:shyft_fallback_used";
          } else {
            heliusDegraded = true;
            heliusReason = "Helius circuit open, Shyft fallback degraded";
            shyftReason = shyftErr?.message || "empty_response";
          }
        } catch (e) {
          heliusDegraded = true;
          heliusReason = `Helius circuit open, Shyft fallback failed: ${e.message}`;
          shyftReason = e.message;
        }
      } else {
        heliusDegraded = true;
        heliusReason = "Helius circuit open, no Shyft key configured";
      }
    }

    if (!shyftFallbackUsed && !heliusDegraded && heliusOK && holderOwners.length > 0) {
      fresh = await getFreshFundedCount(holderOwners, apiKey, launchTs || Math.floor(Date.now() / 1000));
      sybil = await getSameFunderCluster(holderOwners, apiKey);
      heliusErrorCount += Number(fresh?._error_count || 0) + Number(sybil?._error_count || 0);
      heliusReason = fresh?._error || sybil?._error || heliusReason;
      if ((Number(fresh?._error_count || 0) > 0 && Number(fresh?.scanned || 0) === 0) ||
          (Number(sybil?._error_count || 0) > 0 && Number(sybil?.scanned || 0) === 0)) {
        heliusDegraded = true;
      }
    }
    if (!shyftFallbackUsed && !heliusDegraded && heliusOK && launchTs) {
      bundle = await getBundleBuyersPct(mint, apiKey, launchTs);
      if (bundle?._error) {
        heliusDegraded = true;
        heliusReason = bundle._error;
        heliusErrorCount += 1;
      }
    }
  }

  if (!dexscreenerOnly && !gmgnUsed && !heliusFallbackEnabled) {
    heliusDegraded = true;
    heliusReason = "Helius API fallback disabled";
  }

  // Only raise criticalRugTelemetryDegraded when GMGN actually failed (threw an error).
  // An empty response means the token is not yet in GMGN's index — normal for fresh/micro-cap
  // mints — and should fall through to dexscreener-only scoring, not block the token.
  if (gmgnRugSignalsEnabled && gmgnError) {
    if (!heliusFallbackEnabled) {
      criticalRugTelemetryDegraded = true;
      criticalRugTelemetryReason = "GMGN rug signals failed and Helius fallback disabled";
    } else if (!heliusOK) {
      criticalRugTelemetryDegraded = true;
      criticalRugTelemetryReason = "GMGN rug signals failed and Helius fallback not configured";
    } else if (heliusDegraded) {
      criticalRugTelemetryDegraded = true;
      criticalRugTelemetryReason = "GMGN rug signals failed; " + (heliusReason || "fallback degraded");
    }
    if (criticalRugTelemetryDegraded) {
      heliusDegraded = true;
      heliusReason = criticalRugTelemetryReason;
      log("rug_telemetry_block", `${mint.slice(0, 8)} telemetry_block=true reason="${criticalRugTelemetryReason}"`);
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
    chain,
    gmgn_security: gmgnSecurity,
    _gmgn_used: gmgnUsed,
    _helius_used: dexscreenerOnly ? false : (!gmgnUsed && heliusOK),
    _helius_expected: dexscreenerOnly ? false : heliusExpected,
    _helius_degraded: heliusDegraded,
    _critical_rug_telemetry_expected: gmgnRugSignalsEnabled || heliusExpected,
    _critical_rug_telemetry_degraded: criticalRugTelemetryDegraded,
    _critical_rug_telemetry_reason: criticalRugTelemetryReason,
    _data_quality: dexscreenerOnly ? "dexscreener" : gmgnUsed ? "gmgn" : (heliusDegraded ? "degraded" : "full"),
    _helius_reason: heliusReason,
    _shyft_reason: shyftReason,
    _helius_error_count: heliusErrorCount,
    _ts: Date.now(),
  };

  if (heliusDegraded) {
    putDegradedCache(`${chain}:${mint}`, signals);
  } else {
    putCache(`${chain}:${mint}`, signals);
  }
  return signals;
}

export function clearSignalCache() {
  _signalCache.clear();
}
