/**
 * Geyser Exit Monitor - real-time emergency exit trigger.
 *
 * Watches Geyser transaction events for open positions and fires an
 * onEmergencyExit callback when a liquidity-removal or severe price-drop
 * pattern is detected on-chain before the polling cycle catches it.
 *
 * Integration: call attachExitMonitor(geyserStream, openPositions, callbacks)
 * from index.js after startGeyserStream(). Non-blocking - returns cleanup fn.
 */

import { log } from "./logger.js";
import { recordCounter } from "./metrics.js";

// Thresholds
const LARGE_TOKEN_REMOVAL = 1_000_000;  // >1M tokens removed in one tx = likely rug
const PRICE_DROP_THRESHOLD_PCT = -30;    // -30% price drop in single event = emergency
const SUSPICIOUS_SELL_CLUSTER = 5;       // N sells in rapid succession = warning
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Attach real-time exit monitoring to an existing GeyserStream instance.
 *
 * @param {object} geyserStream  GeyserStream instance (from geyser.js)
 * @param {()=>object[]} getPositions  Fn returning current open positions array.
 *   Each position: { mint, entry_price, ... }
 * @param {object} callbacks
 *   - onEmergencyExit(mint, reason, detail)  Called when exit signal fires
 *   - onSuspiciousActivity(mint, reason, detail)  Called for softer warnings
 * @returns {()=>void}  Cleanup function - call to detach the monitor
 */
// Sentinel so we never re-wrap an already-monitored stream and create an
// infinite chain on double-attach. Stored on the monitor function itself.
const MONITOR_SENTINEL = Symbol("ponyouExitMonitorWrapped");

export function attachExitMonitor(geyserStream, getPositions, {
  onEmergencyExit = () => {},
  onSuspiciousActivity = () => {},
} = {}) {
  if (!geyserStream) return () => {};

  const readPositions = typeof getPositions === "function" ? getPositions : () => [];
  let originalOnEvent = typeof geyserStream.onEvent === "function"
    ? geyserStream.onEvent
    : () => {};

  // GEM-5 / re-entry guard: if the current onEvent is already a monitor
  // wrapper, peel it back to its `__originalOnEvent` so re-attaching
  // never produces wrapper-of-wrapper-of-wrapper recursion.
  if (originalOnEvent && originalOnEvent[MONITOR_SENTINEL]) {
    log("geyser_exit_warn", "attachExitMonitor: stream already wrapped — peeling previous wrapper");
    originalOnEvent = originalOnEvent.__originalOnEvent || (() => {});
  }

  // Track sell-cluster counts per mint (reset every 60s)
  const sellCounts = new Map();
  const sellResetInterval = setInterval(() => sellCounts.clear(), 60_000);

  const monitorOnEvent = async (event) => {
    // Pass through to original handler first so existing consumers keep priority.
    try {
      await Promise.resolve(originalOnEvent(event));
    } catch (e) {
      recordCounter("geyser_exit_original_handler_error");
      log("geyser_exit_error", `Original onEvent failed: ${e?.message || e}`);
    }

    if (event?.kind !== "swap") return;

    let positions;
    try {
      positions = readPositions();
    } catch (e) {
      recordCounter("geyser_exit_positions_error");
      log("geyser_exit_error", `Position getter failed: ${e?.message || e}`);
      return;
    }
    if (!positions?.length) return;

    // Check each open position.
    for (const pos of positions) {
      const mint = pos?.mint;
      if (!mint) continue;

      // Detect if this event involves our token being sold out of liquidity pool.
      const isSellEvent = event.token_in === mint;
      const isLiquidityRemoval = event.token_out === WSOL_MINT
        && event.token_in === mint
        && event.amount_in != null;

      if (isSellEvent) {
        const count = (sellCounts.get(mint) || 0) + 1;
        sellCounts.set(mint, count);

        if (count >= SUSPICIOUS_SELL_CLUSTER) {
          recordCounter("geyser_exit_suspicious");
          log("geyser_exit", `Suspicious sell cluster on ${mint.slice(0, 8)}: ${count} sells in 60s`);
          try {
            onSuspiciousActivity(mint, "sell_cluster", `${count} sell events in 60s window`);
          } catch (e) {
            recordCounter("geyser_exit_callback_error");
            log("geyser_exit_error", `Suspicious callback failed: ${e?.message || e}`);
          }
        }
      }

      // Heuristic: a single large dump of our token into the pool against
      // SOL (i.e. token_in=mint, token_out=wSOL) is an exit signal — the
      // bigger the in-amount, the bigger the dump. `amount_in` here is the
      // tokens being SOLD; the variable was previously named `tokenOut`
      // which inverted the mental model.
      if (isLiquidityRemoval) {
        const tokensDumped = Number(event.amount_in);
        const totalSupply = Number(
          pos?.total_supply ??
          pos?.supply ??
          pos?.signal_snapshot?.total_supply ??
          pos?.signal_snapshot?.supply ??
          pos?.signal_snapshot?.token_details?.total_supply ??
          0
        );
        const dumpThreshold = (Number.isFinite(totalSupply) && totalSupply > 0)
          ? totalSupply * 0.01
          : LARGE_TOKEN_REMOVAL;

        if (Number.isFinite(tokensDumped) && tokensDumped > dumpThreshold) {
          recordCounter("geyser_exit_emergency");
          log("geyser_exit", `EMERGENCY: large dump on ${mint.slice(0, 8)}: ${tokensDumped.toLocaleString()} tokens sold in single tx (threshold ${dumpThreshold.toLocaleString()})`);
          try {
            onEmergencyExit(mint, "liquidity_removal", `${tokensDumped.toLocaleString()} tokens dumped in single tx (threshold ${dumpThreshold.toLocaleString()})`);
          } catch (e) {
            recordCounter("geyser_exit_callback_error");
            log("geyser_exit_error", `Emergency callback failed: ${e?.message || e}`);
          }
        }
      }
    }
  };

  // Mark the wrapper so future attaches detect and peel it correctly.
  monitorOnEvent[MONITOR_SENTINEL] = true;
  monitorOnEvent.__originalOnEvent = originalOnEvent;

  geyserStream.onEvent = monitorOnEvent;

  // Cleanup: restore original handler.
  return () => {
    clearInterval(sellResetInterval);
    if (geyserStream.onEvent === monitorOnEvent) {
      geyserStream.onEvent = originalOnEvent;
    }
  };
}

/**
 * Simple price-drop detector for use with periodic price feeds.
 * Call this when you have a new price sample - it will fire onEmergencyExit
 * if the drop from entry is severe enough.
 *
 * This is NOT Geyser-dependent - works alongside polling as a safety net.
 *
 * @param {object} pos  Open position { mint, entry_price }
 * @param {number} currentPrice  Current price in same units as entry_price
 * @param {Function} onEmergencyExit  Callback (mint, reason, detail)
 * @returns {boolean}  true if emergency exit was triggered
 */
export function checkPriceDrop(pos, currentPrice, onEmergencyExit) {
  const entryPrice = Number(pos?.entry_price);
  const price = Number(currentPrice);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;
  if (!Number.isFinite(price) || price <= 0) return false;

  const pctChange = ((price - entryPrice) / entryPrice) * 100;
  if (pctChange <= PRICE_DROP_THRESHOLD_PCT) {
    recordCounter("geyser_exit_price_drop");
    log("geyser_exit", `EMERGENCY price drop on ${String(pos?.mint || "").slice(0, 8)}: ${pctChange.toFixed(1)}% from entry`);
    try {
      onEmergencyExit(pos?.mint, "price_drop", `${pctChange.toFixed(1)}% drop from entry price ${entryPrice}`);
    } catch (e) {
      recordCounter("geyser_exit_callback_error");
      log("geyser_exit_error", `Price-drop callback failed: ${e?.message || e}`);
    }
    return true;
  }
  return false;
}
