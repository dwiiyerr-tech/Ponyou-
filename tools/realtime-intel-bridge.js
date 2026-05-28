/**
 * Real-time Intel Bridge — connects rug-monitor's per-position events
 * to the intel detector layer (slow-rug + dev-wallet) so patterns build
 * from REAL-TIME samples, not just from N-minute management cycle samples.
 *
 * Why this exists:
 *   rug-monitor already does per-position Geyser + polling. It fires HIGH
 *   on a SINGLE big LP removal or dev sell. But it doesn't catch:
 *     - 3× 8% LP removals over 24h (each below HIGH threshold individually)
 *     - 5× small dev sells over 24h (gradual reduction)
 *     - LP drained 35% over 48h while price stayed flat
 *
 *   This bridge subscribes to ALL severities (LOW/MEDIUM/HIGH) from the
 *   rug-monitor, records each event as a sample for our pattern detectors,
 *   and re-evaluates after each sample. When the slow-rug or dev-wallet
 *   detector says HIGH severity, we trigger force-exit even though the
 *   rug-monitor alone wouldn't have.
 *
 * Detection lag improvement:
 *   Without bridge: pattern detected at next mgmt cycle = 1–5 min lag
 *   With bridge:    pattern detected within seconds of the triggering tx
 *
 * Honest scope:
 *   - We rely on the rug-monitor surfacing the events. If rug-monitor is
 *     disabled or its Geyser stream is dropped, this bridge is a no-op.
 *   - Sample data quality depends on what rug-monitor passes in `meta`.
 *     Some events provide `currentLp` / `currentBalance`; others don't.
 *     We skip silently when data is missing rather than logging errors.
 */

import { log } from "../logger.js";
import { recordLiquiditySample, evaluateSlowRug } from "./slow-rug-detector.js";
import { recordDevSnapshot, evaluateDevActivity } from "./dev-wallet-tracker.js";

/**
 * Wrap a base set of rug-monitor callbacks with intel-bridge hooks.
 *
 * @param {Object} args
 * @param {Object} args.baseCallbacks   The original rug-monitor callbacks
 *                                      ({onLow, onMedium, onHigh}). These
 *                                      are still called pass-through.
 * @param {Function} args.markForceExit Called as (positionKey, reason) when
 *                                      bridge-aggregated detectors elevate
 *                                      to HIGH severity. Should set
 *                                      pos.rug_force_exit + reason on the
 *                                      tracked state.
 * @param {Object} [args.deps]          Override detectors (testing).
 * @returns {Object} new callbacks to pass into createRugMonitor
 */
export function wrapRugMonitorCallbacks({ baseCallbacks = {}, markForceExit, deps = {} }) {
  const recLiq = deps.recordLiquiditySample || recordLiquiditySample;
  const evalSlowRug = deps.evaluateSlowRug || evaluateSlowRug;
  const recDev = deps.recordDevSnapshot || recordDevSnapshot;
  const evalDev = deps.evaluateDevActivity || evaluateDevActivity;
  const logger = deps.log || log;

  async function _handleLpEvent(positionKey, signalType, meta) {
    try {
      // rug-monitor passes meta.evidence for poll events, meta.evidence.evt
      // for Geyser events. Both can carry currentLp / current.
      const ev = meta?.evidence || {};
      const evt = ev?.evt || ev;
      const liquidity_usd = Number(evt?.lpUsd ?? evt?.currentLp ?? ev?.current ?? 0);
      const mint = meta?.mint || _extractMintFromKey(positionKey);
      if (!mint || !(liquidity_usd > 0)) return;
      await recLiq({ mint, liquidity_usd, price_usd: 0 });
      const slowRug = evalSlowRug(mint);
      if (slowRug.triggered && slowRug.severity === "high" && typeof markForceExit === "function") {
        const reason = `slow_rug_force_exit: ${slowRug.pattern}`;
        logger("intel_bridge", `🩸 slow-rug HIGH on ${positionKey} via real-time LP event → force exit`);
        markForceExit(positionKey, reason);
      }
    } catch (e) {
      logger("intel_bridge_err", `lp event ${positionKey}: ${e.message || e}`);
    }
  }

  async function _handleDevEvent(positionKey, signalType, meta) {
    try {
      const ev = meta?.evidence || {};
      // Geyser dev_sell evidence: { current: balance }
      // Poll dev_sell evidence:   { current, atEntry }
      const currentBalance = Number(ev?.current ?? 0);
      const mint = meta?.mint || _extractMintFromKey(positionKey);
      const devWallet = meta?.deployer_wallet || meta?.dev_wallet;
      const totalSupply = Number(meta?.total_supply ?? 0);
      if (!mint || !devWallet || !(totalSupply > 0)) return;
      await recDev({ mint, devWallet, devBalance: currentBalance, totalSupply });
      const devAct = evalDev(mint);
      if ((devAct.severity === "high" || devAct.severity === "critical") && typeof markForceExit === "function") {
        const reason = `dev_sell_force_exit: ${devAct.alert}`;
        logger("intel_bridge", `🩸 dev-wallet ${devAct.alert} on ${positionKey} via real-time event → force exit`);
        markForceExit(positionKey, reason);
      }
    } catch (e) {
      logger("intel_bridge_err", `dev event ${positionKey}: ${e.message || e}`);
    }
  }

  function _dispatch(severityLevel) {
    return (positionKey, signalType, meta) => {
      // Pass-through to existing callback first — preserves all existing
      // rug-monitor behavior (logs, telegram alerts, single-event HIGH
      // force exits, etc.).
      const baseFn = baseCallbacks[`on${severityLevel}`];
      if (typeof baseFn === "function") {
        try { baseFn(positionKey, signalType, meta); }
        catch (e) { logger("intel_bridge_err", `base ${severityLevel} callback threw: ${e.message || e}`); }
      }
      // Route to our pattern detectors. Run async without awaiting so
      // rug-monitor's event loop isn't blocked by I/O.
      const isLp = /lp/i.test(signalType);
      const isDev = /dev/i.test(signalType);
      if (isLp) { _handleLpEvent(positionKey, signalType, meta).catch(() => {}); }
      if (isDev) { _handleDevEvent(positionKey, signalType, meta).catch(() => {}); }
    };
  }

  return {
    onLow: _dispatch("Low"),
    onMedium: _dispatch("Medium"),
    onHigh: _dispatch("High"),
  };
}

/**
 * Position keys can be either a bare mint or "mint:wallet_address". Strip
 * the wallet portion if present so we can use it as the detector key.
 */
function _extractMintFromKey(positionKey) {
  if (!positionKey || typeof positionKey !== "string") return null;
  const sep = positionKey.indexOf(":");
  return sep > 0 ? positionKey.slice(0, sep) : positionKey;
}
