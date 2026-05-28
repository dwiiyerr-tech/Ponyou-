/**
 * Exit Timing Optimizer — choose better execution when an exit is signaled
 *
 * Common mistakes when a bot exits naively:
 *   - Dumps full size into thin liquidity → 10-30% slippage swallowed
 *   - Sells into a red candle while it's still falling → bad fills
 *   - Exits same block as 9 other wallets (cast-net same-block dumping)
 *
 * This optimizer is consulted at exit-trigger time to answer:
 *   1. Should we split the exit (size > N% of liquidity)?
 *   2. Should we delay briefly to catch a green candle / liquidity bump?
 *   3. How tight should our slippage tolerance be?
 *
 * Honest design choice:
 *   The optimizer NEVER suggests delaying a STOP-LOSS or RUG-FORCE exit.
 *   Those must dump immediately. It only optimizes profit-taking and
 *   trailing-stop exits where time is not urgent.
 */

const URGENT_REASONS = [
  "rug_force_exit", "hardStopLoss", "hardCutLoss",
  "pro_cutloss", "DEV_EMPTIED", "DEV_SOLD_5PCT",
  "DEV_DUMPING", "slow_rug_force_exit",
];

function isUrgent(exitReason) {
  if (!exitReason) return false;
  const s = String(exitReason).toLowerCase();
  return URGENT_REASONS.some((r) => s.includes(r.toLowerCase()));
}

/**
 * Build an execution plan for an exit trigger.
 *
 * @param {Object} args
 * @param {string} args.mint
 * @param {string} args.exitReason
 * @param {number} args.positionValueUsd — current USD value of the position being sold
 * @param {number} args.liquidityUsd     — pool liquidity in USD
 * @param {number} args.price1mPct       — most recent 1-minute price change %
 * @param {boolean} args.lastCandleGreen — true if last candle closed green
 *
 * @returns {{
 *   urgent: boolean,
 *   split: boolean,
 *   splitCount: number,
 *   splitDelayMs: number,
 *   delayBeforeFirstMs: number,
 *   slippagePct: number,
 *   reasons: string[],
 * }}
 */
export function planExit({
  mint,
  exitReason,
  positionValueUsd = 0,
  liquidityUsd = 0,
  price1mPct = 0,
  lastCandleGreen = null,
} = {}) {
  const reasons = [];
  const urgent = isUrgent(exitReason);

  // ── Size vs liquidity — decide split ───────────────────────────────
  const sizeRatio = liquidityUsd > 0 ? positionValueUsd / liquidityUsd : 0;
  let split = false;
  let splitCount = 1;
  let splitDelayMs = 0;
  if (sizeRatio >= 0.05) {
    split = true;
    // Each chunk should be ~4% of liquidity max
    splitCount = Math.min(5, Math.ceil(sizeRatio / 0.04));
    splitDelayMs = 8_000 + Math.floor(Math.random() * 8_000); // 8–16s
    reasons.push(`size ${(sizeRatio * 100).toFixed(1)}% of liquidity → split into ${splitCount} chunks`);
  }

  // ── Slippage tolerance ─────────────────────────────────────────────
  // Base 1%, raise on urgency and size, cap at 8%.
  let slippagePct = 1;
  if (urgent) slippagePct = Math.max(slippagePct, 5);
  if (sizeRatio >= 0.10) slippagePct = Math.max(slippagePct, 4);
  else if (sizeRatio >= 0.05) slippagePct = Math.max(slippagePct, 2.5);
  slippagePct = Math.min(8, slippagePct);

  // ── Timing — should we wait briefly for a better fill? ─────────────
  let delayBeforeFirstMs = 0;
  if (!urgent) {
    // If price is dumping right now (-3%+ in last minute) AND we're not
    // forced to exit, wait 15-30s for a bounce rather than dump into it.
    if (price1mPct <= -3) {
      delayBeforeFirstMs = 15_000 + Math.floor(Math.random() * 15_000);
      reasons.push(`price -${Math.abs(price1mPct).toFixed(1)}%/1m → wait ${Math.round(delayBeforeFirstMs/1000)}s for bounce`);
    }
    // If last candle was red and we're trailing-stop exiting, wait for
    // green candle confirmation. Cap delay at 90s — past that, just sell.
    else if (lastCandleGreen === false && /trailing|takeProfit|partialTP|roi/i.test(String(exitReason || ""))) {
      delayBeforeFirstMs = Math.min(90_000, 30_000);
      reasons.push("last candle red on trailing — wait 30s for green confirmation");
    }
  } else {
    reasons.push(`urgent exit (${exitReason}) — no delay`);
  }

  return {
    urgent,
    split,
    splitCount,
    splitDelayMs,
    delayBeforeFirstMs,
    slippagePct,
    reasons,
  };
}
