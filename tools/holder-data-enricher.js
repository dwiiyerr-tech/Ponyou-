/**
 * Holder Data Enricher (ABC data pipeline)
 *
 * The ABC holder-analysis tools (dump monitor / entry-price / rug-pattern) were
 * wired into the management cycle and cast-net gate but never fed live data —
 * so they were a no-op. This module is the missing data layer: given a mint, it
 * returns { topHolders, recentSells, priceHistory } sourced from Helius (already
 * configured) + DexScreener/GeckoTerminal (free), with strict throttling so we
 * don't worsen Helius 429s.
 *
 * Throttle strategy (see memory: "Helius 429s are structural"):
 *   - Per-mint TTL cache (default 8min) — management runs every ~10min, so this
 *     yields ~1 fetch/snapshot per cycle while coalescing the entry-gate +
 *     exit-check calls that happen in the same cycle for the same mint.
 *   - Only runs for mints inside the beta cohort (same hash bucketing as
 *     holder-exit-checks.shouldRunBetaCheck) — non-cohort mints never fetch.
 *   - The expensive per-wallet sell fetch (C) is gated behind a cheap snapshot
 *     delta pre-check: it only fires when a top holder's share dropped or a
 *     holder vanished since the last snapshot ("dump suspected"). When the
 *     book is quiet, C costs zero Helius calls.
 *   - Respects the Helius circuit breaker from rug-signals.js.
 *
 * Everything is fail-soft: any error returns empty arrays so the management
 * cycle never breaks on enrichment.
 */

import {
  getTokenSecurityDetails,
  getTokenKlines,
  fetchHeliusTxns,
  _internalSmartMoney,
} from "./dexscreener.js";
import { getHolderHistory } from "./holder-dump-monitor.js";
import { heliusCircuitOpen, fetchShyftHolders, fetchShyftTokenSupply } from "./rug-signals.js";
import { getTopHolders as gmgnTopHolders, getWalletActivity as gmgnWalletActivity, normalizeTopHolder, isGmgnEnabled } from "./gmgn.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { recordCounter } from "../metrics.js";

// GMGN holder-enrich surface gate (key present AND feature flag on).
function gmgnHolderOn() {
  return isGmgnEnabled() && config.gmgn?.holderEnrich !== false;
}

const { parseSolanaSwap } = _internalSmartMoney;

const EMPTY = { topHolders: [], recentSells: [], holderTransactions: [], priceHistory: [], fromCache: false };

// Per-mint TTL cache. Keyed by mint → { ts, data }.
const _cache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000; // 8min < 10min management cadence → fresh each cycle
const CACHE_MAX = 500;

// How many top holders to probe for recent sells when a dump is suspected.
// Bounded to keep Helius usage predictable (<= this many calls per flagged mint).
const SELL_PROBE_HOLDERS = 5;
const SELL_LOOKBACK_MS = 10 * 60 * 1000; // only keep sells from the last 10min

function isFlagEnabled(cfg = {}) {
  return Boolean(
    cfg.dumpMonitor?.enabled ||
    cfg.entryPriceAnalysis?.enabled ||
    cfg.rugPatternDetector?.enabled
  );
}

// Mirrors holder-exit-checks.shouldRunBetaCheck so the enricher and the consumer
// agree on cohort membership without a circular import.
function inBetaCohort(mint, cfg = {}) {
  const maxPct = Math.max(
    cfg.dumpMonitor?.betaRolloutPct || 0,
    cfg.entryPriceAnalysis?.betaRolloutPct || 0,
    cfg.rugPatternDetector?.betaRolloutPct || 0
  );
  if (maxPct <= 0) return false;
  if (maxPct >= 100) return true;
  if (!mint || typeof mint !== "string") return false;
  let hash = 0;
  for (let i = 0; i < mint.length; i++) {
    hash = ((hash << 5) - hash + mint.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 100) < maxPct;
}

function setCache(mint, data) {
  _cache.set(mint, { ts: Date.now(), data });
  if (_cache.size > CACHE_MAX) {
    const entries = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of entries.slice(0, Math.floor(CACHE_MAX / 10))) _cache.delete(k);
  }
}

/**
 * Cheap pre-check: compare freshly-fetched top holders against the most recent
 * stored snapshot. Returns true if any tracked holder's share dropped >= 2 pts
 * or a previously-top holder vanished. Reads local snapshot file only (no RPC).
 */
function dumpSuspected(mint, freshHolders) {
  try {
    const prev = getHolderHistory(mint, 1)?.[0];
    const prevHolders = prev?.holders;
    if (!Array.isArray(prevHolders) || prevHolders.length === 0) return false;

    const prevMap = new Map(prevHolders.filter((h) => h.address).map((h) => [h.address, h]));
    const freshAddrs = new Set(freshHolders.map((h) => h.address).filter(Boolean));

    for (const h of freshHolders) {
      const p = prevMap.get(h.address);
      if (p && (Number(p.pct) || 0) - (Number(h.pct) || 0) >= 2) return true;
    }
    for (const addr of prevMap.keys()) {
      if (!freshAddrs.has(addr)) return true; // a top holder disappeared
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Probe recent sells for a token from each top holder's activity.
 * GMGN wallet activity primary (no Helius quota), Helius tx parsing fallback.
 */
async function probeRecentSells(mint, topHolders) {
  const owners = [...new Set(topHolders.map((h) => h.wallet).filter(Boolean))].slice(0, SELL_PROBE_HOLDERS);
  if (owners.length === 0) return [];

  const cutoffSec = (Date.now() - SELL_LOOKBACK_MS) / 1000;
  const sells = [];

  // ── GMGN path ──────────────────────────────────────────────────────────────
  if (gmgnHolderOn()) {
    for (const owner of owners) {
      try {
        const activity = await gmgnWalletActivity(owner, 20);
        const trades = Array.isArray(activity) ? activity : (activity?.trades ?? activity?.swaps ?? []);
        for (const t of trades) {
          const ts = Number(t.timestamp ?? t.time ?? 0);
          if (ts < cutoffSec) continue;
          const tradeType = (t.type ?? t.side ?? "").toLowerCase();
          if (tradeType !== "sell") continue;
          const tradeMint = t.token_address || t.token_mint || t.mint;
          if (tradeMint !== mint) continue;
          sells.push({
            address: owner,
            amountUsd: Number(t.sol_amount ?? t.value ?? 0),
            amount: Number(t.token_amount ?? t.amount ?? 0),
            timestamp: new Date(ts * 1000).toISOString(),
            txSignature: t.signature || t.tx_hash || null,
          });
        }
      } catch (e) {
        log("holder_enrich_warn", `GMGN sell probe ${owner.slice(0, 8)}: ${e.message}`);
      }
    }
    if (sells.length > 0) return sells;
  }

  // ── Helius fallback ────────────────────────────────────────────────────────
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || apiKey === "dummy-helius-key") return [];
  if (heliusCircuitOpen()) return [];

  for (const owner of owners) {
    try {
      const txns = await fetchHeliusTxns(owner, apiKey, 25);
      if (!Array.isArray(txns)) continue;
      for (const tx of txns) {
        if (!tx?.timestamp || tx.timestamp < cutoffSec) continue;
        const swap = parseSolanaSwap(tx);
        if (!swap || swap.type !== "sell") continue;
        if (swap.token_mint !== mint) continue;
        sells.push({
          address: owner,
          amountUsd: swap.sol_value,
          amount: swap.token_amount,
          timestamp: new Date(swap.timestamp * 1000).toISOString(),
          txSignature: swap.signature,
        });
      }
    } catch (e) {
      log("holder_enrich_warn", `sell probe ${owner.slice(0, 8)}: ${e.message}`);
      if (heliusCircuitOpen()) break;
    }
  }
  return sells;
}

/**
 * Build a price-history series for the entry-price (B) fallback from free
 * sources (GeckoTerminal klines via dexscreener.js). Returns [{timestamp, priceUsd}].
 */
async function fetchPriceHistory(mint) {
  try {
    const kl = await getTokenKlines({ mint, resolution: "5m", limit: 30 });
    const candles = kl?.candles || [];
    return candles
      .map((c) => ({ timestamp: c.time, priceUsd: Number(c.close) }))
      .filter((p) => Number.isFinite(p.priceUsd) && p.priceUsd > 0);
  } catch {
    return [];
  }
}

/**
 * Fetch top holders for a mint.
 * Priority: GMGN (richest data: smart/KOL/rat/bundler tags) → Shyft → Helius RPC.
 * All paths key holders by owner wallet so dump-monitor snapshots compare like-for-like.
 * Returns [{address, wallet, balance, pct, tags?}].
 */
async function fetchTopHolders(mint) {
  // Layer 0: GMGN — most data-rich, offloads Helius completely when available.
  if (gmgnHolderOn()) {
    try {
      const raw = await gmgnTopHolders(mint, 20);
      if (Array.isArray(raw) && raw.length > 0) {
        recordCounter("holder_enrich_source_gmgn");
        return raw.slice(0, 20).map(normalizeTopHolder);
      }
    } catch (e) {
      log("holder_enrich_warn", `gmgn top holders ${mint.slice(0, 8)}: ${e.message}`);
    }
  }

  const shyftKey = process.env.SHYFT_API_KEY;
  if (shyftKey && shyftKey !== "dummy-shyft-key") {
    try {
      const [holders, supply] = await Promise.all([
        fetchShyftHolders(mint, shyftKey, 10),
        fetchShyftTokenSupply(mint, shyftKey),
      ]);
      // Need both a holder list and a supply to compute a stable % -of-supply.
      // Without supply, pct would be 0 and pollute the dump-delta math, so we
      // fall through to the Helius path (which carries its own pct) instead.
      if (Array.isArray(holders) && holders.length > 0 && supply > 0) {
        recordCounter("holder_enrich_source_shyft");
        return holders.slice(0, 10).map((h) => {
          const bal = Number(h.amount) || 0;
          return {
            address: h.owner, // owner wallet — stable snapshot key
            wallet: h.owner,
            balance: bal,
            pct: Math.max(0, Math.min(100, (bal / supply) * 100)),
          };
        });
      }
    } catch (e) {
      log("holder_enrich_warn", `shyft holders ${mint.slice(0, 8)}: ${e.message}`);
    }
  }

  // Fallback: Helius RPC via getTokenSecurityDetails (already carries pct + owner).
  const sec = await getTokenSecurityDetails({ mint });
  if (!Array.isArray(sec?.holders)) return [];
  recordCounter("holder_enrich_source_helius");
  return sec.holders
    .filter((h) => h.address)
    .slice(0, 10)
    .map((h) => ({
      address: h.owner || h.address, // prefer owner so the key matches the Shyft path
      wallet: h.owner || null,
      balance: Number(h.token_amount) || 0,
      pct: Number(h.pct) || 0,
    }));
}

/**
 * Main entry point. Returns ABC-ready data for a mint, or empty arrays when the
 * feature is disabled / the mint is out of cohort / fetching fails.
 *
 * @param {Object} args
 * @param {string} args.mint
 * @param {number} [args.currentPrice]
 * @param {Object} [args.featureFlags]  config.holderAnalysis
 */
export async function enrichHolderData({ mint, currentPrice = 0, featureFlags = {} } = {}) {
  const cfg = featureFlags || {};
  if (!mint || typeof mint !== "string" || mint.length < 32) return { ...EMPTY };
  if (!isFlagEnabled(cfg)) return { ...EMPTY };
  if (!inBetaCohort(mint, cfg)) return { ...EMPTY };

  const cached = _cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.data, fromCache: true };
  }

  const result = { topHolders: [], recentSells: [], holderTransactions: [], priceHistory: [], fromCache: false };

  // ── A) top holders (Shyft-first, Helius fallback; both carry pct) ──
  try {
    result.topHolders = await fetchTopHolders(mint);
  } catch (e) {
    recordCounter("holder_enrich_holders_error");
    log("holder_enrich_warn", `holders fetch ${mint.slice(0, 8)}: ${e.message}`);
  }

  // ── B) price history (free) for the underwater-holder fallback ──
  if (cfg.entryPriceAnalysis?.enabled) {
    result.priceHistory = await fetchPriceHistory(mint);
  }

  // ── C) recent per-wallet sells — only when a dump is already suspected ──
  if (cfg.rugPatternDetector?.enabled && result.topHolders.length > 0) {
    if (dumpSuspected(mint, result.topHolders)) {
      recordCounter("holder_enrich_sell_probe");
      result.recentSells = await probeRecentSells(mint, result.topHolders);
    }
  }

  setCache(mint, result);
  return result;
}

/** Test/diagnostic helper. */
export function _resetHolderEnricherCache() {
  _cache.clear();
}
