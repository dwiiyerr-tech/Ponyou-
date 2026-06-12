/**
 * Fast-Exit Sentinel — closes the exit EXECUTION gap (experiment #24).
 *
 * The cf-exit evaluator measured a +41.9pp gap between actual exits and the
 * nominal policy replayed on the same price paths; the residual (post
 * position_key fix) component is the 2-minute management cadence: on a fast
 * memecoin dump, the next price check lands 2-5pp past the stop.
 *
 * Design constraint (the whole point): this module NEVER sells. It watches
 * open positions on a tight interval and, when a position's PnL breaches its
 * strategy stop (or a hard-drop floor), it WAKES the management cycle early.
 * Every exit still flows through the canonical engine — accounting, lessons,
 * darwin and attribution stay on the single proven path, and runManagementCycle's
 * busy-guard makes an overlapping wake a no-op.
 *
 * Cost: one batched DexScreener call per tick, and only while positions are
 * open. Flag-gated via config.fastExit (default OFF).
 */

import { log } from "../logger.js";
import { recordCounter } from "../metrics.js";

const DEFAULT_INTERVAL_SEC = 20;
const DEFAULT_HARD_DROP_PCT = -35;   // breach regardless of strategy SL
const TRIGGER_DEBOUNCE_MS = 60_000;  // at most one early wake per minute

let _timer = null;
let _lastTriggerTs = 0;
let _ticking = false;

/**
 * Evaluate one tick. Pure given deps — tests inject everything.
 * Returns { checked, breached: [{mint, pnl_pct, threshold, reason}], triggered }.
 */
export async function sentinelTick({
  getOpenPositions,
  fetchPrices,
  getStrategyById = () => null,
  triggerCycle,
  config = {},
  now = Date.now(),
} = {}) {
  const positions = (getOpenPositions() || []).filter((p) => !p.closed);
  if (positions.length === 0) return { checked: 0, breached: [], triggered: false };

  const mints = positions.map((p) => String(p.position_key || p.position || "").split("::")[0]).filter(Boolean);
  const prices = await fetchPrices(mints);
  const hardDrop = Number(config.hardDropPct ?? DEFAULT_HARD_DROP_PCT);

  const breached = [];
  for (const p of positions) {
    const mint = String(p.position_key || p.position || "").split("::")[0];
    const entry = Number(p.signal_snapshot?.entry_price) || 0;
    const price = prices.get(mint);
    if (!entry || !price) continue; // no data — never guess on exits

    const pnl = ((price / entry) - 1) * 100;
    // Strategy SL is a negative decimal (e.g. -0.12); config triggerPnlPct
    // overrides, hard-drop floor applies regardless.
    const stratSl = getStrategyById(p.strategy_used)?.stoploss;
    const threshold = Number(
      config.triggerPnlPct
      ?? (Number.isFinite(stratSl) && stratSl < 0 ? stratSl * 100 : -12)
    );
    if (pnl <= threshold || pnl <= hardDrop) {
      breached.push({
        mint,
        symbol: p.pool_name || mint.slice(0, 8),
        pnl_pct: Number(pnl.toFixed(2)),
        threshold: Math.max(threshold, hardDrop) === threshold && pnl <= threshold ? threshold : hardDrop,
        reason: pnl <= hardDrop ? "hard_drop" : "strategy_sl",
      });
    }
  }

  let triggered = false;
  if (breached.length > 0 && now - _lastTriggerTs >= TRIGGER_DEBOUNCE_MS) {
    _lastTriggerTs = now;
    triggered = true;
    recordCounter("fast_exit_sentinel_triggers");
    log("fast_exit",
      `Sentinel breach: ${breached.map((b) => `${b.symbol} ${b.pnl_pct}% (${b.reason} ≤ ${b.threshold})`).join(", ")} — waking management cycle early`);
    try { await triggerCycle(); } catch (e) { log("fast_exit_error", `early cycle failed: ${e.message}`); }
  }

  return { checked: positions.length, breached, triggered };
}

/**
 * Start the sentinel loop. Deps are injected from index.js so this module
 * stays import-light (no state.js/strategies.js coupling at load time).
 */
export function startFastExitSentinel({ getOpenPositions, fetchPrices, getStrategyById, triggerCycle, config = {} } = {}) {
  if (_timer) return false;
  if (!config.enabled) {
    log("fast_exit", "Sentinel disabled (config.fastExit.enabled=false)");
    return false;
  }
  const intervalMs = Math.max(10, Number(config.intervalSec) || DEFAULT_INTERVAL_SEC) * 1000;
  _timer = setInterval(async () => {
    if (_ticking) return; // a slow price fetch must not stack ticks
    _ticking = true;
    try {
      await sentinelTick({ getOpenPositions, fetchPrices, getStrategyById, triggerCycle, config });
    } catch (e) {
      log("fast_exit_error", `tick failed: ${e.message}`);
    } finally {
      _ticking = false;
    }
  }, intervalMs);
  _timer.unref?.(); // never keep the process alive on its own
  log("fast_exit", `Sentinel ON — every ${intervalMs / 1000}s while positions are open (exp #24)`);
  return true;
}

export function stopFastExitSentinel() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function _resetSentinelForTests() {
  stopFastExitSentinel();
  _lastTriggerTs = 0;
  _ticking = false;
}
