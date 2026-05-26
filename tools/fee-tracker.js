/**
 * Fee Tracker — Complete fee accounting for every trade.
 *
 * Tracks all Solana trading costs:
 *   1. DEX swap fees (Raydium, Orca, Meteora, pump.fun, etc.)
 *   2. Platform fees (pump.fun 1%, other launchpads)
 *   3. Token account rent (creation + reclamation)
 *   4. Priority fees + Jito tips (gas)
 *   5. Slippage (expected vs actual execution price)
 *   6. MEV / sandwich loss detection
 *   7. RPC simulation costs
 *
 * Integrated into PnL calculation: True PnL = gross PnL - Σ(all fees).
 */

import { log } from "../logger.js";

// ─── DEX Fee Registry ────────────────────────────────────

const DEX_FEE_BPS = {
  raydium: 25,         // Raydium standard: 0.25%
  "raydium clmm": 25,
  "raydium cpmm": 25,
  orca: 30,            // Orca typical: 0.30%
  whirlpool: 30,       // Orca Whirlpool
  meteora: 4,          // Meteora DLMM: 0.04% dynamic (base)
  "meteora dlmm": 4,
  pumpswap: 100,       // pump.fun PumpSwap: 1%
  "pump.fun": 100,
  pumpfun: 100,
  pump: 100,
  "bonkswap": 30,      // BonkSwap
  "letsbonk.fun": 30,
  phoenix: 20,         // Phoenix: 0.20%
  lifinity: 20,        // Lifinity
  saber: 20,           // Saber
  aldrin: 30,          // Aldrin
  serum: 25,           // Serum
  cropper: 20,         // Cropper
  unknown: 25,         // Conservative default
};

const PLATFORM_FEE_BPS = {
  "pump.fun": 100,     // pump.fun charges 1% on every trade
  pumpswap: 100,
  pumpfun: 100,
  pump: 100,
  "letsbonk.fun": 50,  // BonkSwap platform fee: 0.5%
  bonkswap: 50,
};

const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;  // ~0.002 SOL per token account
const AVG_RPC_SIM_COST_SOL = 0.000005;      // ~0.000005 SOL per simulateTransaction

// ─── Fee Breakdown Structure ─────────────────────────────

function emptyFeeBreakdown() {
  return {
    dex_fee_sol: 0,
    dex_fee_bps: 0,
    dex_name: null,
    platform_fee_sol: 0,
    platform_fee_bps: 0,
    platform_name: null,
    priority_fee_sol: 0,
    jito_tip_sol: 0,
    tx_fee_sol: 0,
    token_account_rent_sol: 0,
    slippage_sol: 0,
    slippage_bps: 0,
    mev_loss_sol: 0,
    rpc_sim_cost_sol: 0,
    total_fee_sol: 0,

    // Debug / diagnostics
    expected_price: 0,
    actual_price: 0,
    price_impact_pct: 0,
    sandwich_detected: false,
    fee_breakdown_note: "",
  };
}

// ─── DEX Detection ───────────────────────────────────────

export function resolveDex(dexId) {
  if (!dexId) return "unknown";
  const d = String(dexId).toLowerCase();
  // PumpSwap aliases
  if (d.includes("pump")) return "pump.fun";
  // Raydium aliases
  if (d.includes("raydium")) {
    if (d.includes("clmm")) return "raydium clmm";
    if (d.includes("cpmm")) return "raydium cpmm";
    return "raydium";
  }
  // Orca aliases
  if (d.includes("orca")) return "orca";
  if (d.includes("whirlpool")) return "whirlpool";
  // Meteora
  if (d.includes("meteora")) return "meteora dlmm";
  // BonkSwap
  if (d.includes("bonk") || d.includes("letsbonk")) return "letsbonk.fun";
  // Exact match
  if (DEX_FEE_BPS[d]) return d;
  return "unknown";
}

export function getDexFeeBps(dexId) {
  return DEX_FEE_BPS[resolveDex(dexId)] || 25;
}

export function getPlatformFeeBps(dexId) {
  const key = resolveDex(dexId);
  return PLATFORM_FEE_BPS[key] || 0;
}

// ─── Fee Calculation ────────────────────────────────────

/**
 * Calculate DEX swap fee for a trade.
 * @param {number} tradeAmountSol - SOL value of the trade
 * @param {string} dexId - DEX identifier
 * @returns {{ dex_fee_sol: number, dex_fee_bps: number, dex_name: string }}
 */
export function calcDexFee(tradeAmountSol, dexId = "unknown") {
  const dexName = resolveDex(dexId);
  const bps = getDexFeeBps(dexId);
  const fee = tradeAmountSol * (bps / 10000);
  return { dex_fee_sol: fee, dex_fee_bps: bps, dex_name: dexName };
}

/**
 * Calculate platform fee (pump.fun 1%, etc.) on a trade.
 * pump.fun charges on BOTH buy and sell sides.
 */
export function calcPlatformFee(tradeAmountSol, dexId = "unknown") {
  const dexName = resolveDex(dexId);
  const bps = getPlatformFeeBps(dexId);
  const fee = tradeAmountSol * (bps / 10000);
  return { platform_fee_sol: fee, platform_fee_bps: bps, platform_name: bps > 0 ? dexName : null };
}

/**
 * Calculate slippage loss from expected vs actual execution.
 * Positive slippage_sol = you received less than expected (loss).
 * Negative = you received more (favorable).
 */
export function calcSlippage(amountInSol, expectedPrice, actualPrice) {
  if (!expectedPrice || !actualPrice || expectedPrice <= 0) {
    return { slippage_sol: 0, slippage_bps: 0, expected_price: expectedPrice, actual_price: actualPrice };
  }
  const expectedOut = amountInSol / expectedPrice;
  const actualOut = amountInSol / actualPrice;
  const slippageRatio = actualOut / expectedOut; // < 1 = bad, > 1 = good
  const slippageBps = Math.round((1 - slippageRatio) * 10000);
  const slippageSol = Math.abs(expectedOut - actualOut);
  return {
    slippage_sol: slippageBps > 0 ? slippageSol : 0,
    slippage_bps: Math.max(0, slippageBps),
    expected_price: expectedPrice,
    actual_price: actualPrice,
  };
}

// ─── MEV / Sandwich Detection ────────────────────────────

/**
 * Detect potential MEV / sandwich attack.
 * Flags when slippage is abnormally high AND price impact pattern
 * matches sandwich characteristics:
 *   - High slippage (>3%) on a token with decent liquidity
 *   - Price reverted quickly after trade (sandwich symptom)
 */
export function detectMevSandwich({ slippageBps, liquidity, priceChangeAfter1m, volume } = {}) {
  const flags = [];
  let sandwichScore = 0;

  // Signal 1: High slippage on a liquid token
  if (slippageBps > 300 && liquidity > 10000) {
    sandwichScore += 40;
    flags.push("high_slippage_liquid_token");
  }

  // Signal 2: Very high slippage regardless of liquidity
  if (slippageBps > 500) {
    sandwichScore += 30;
    flags.push("very_high_slippage");
  }

  // Signal 3: Price reversed quickly after trade
  if (priceChangeAfter1m != null && priceChangeAfter1m < -3) {
    sandwichScore += 20;
    flags.push("price_reversal_1m");
  }

  // Signal 4: Abnormally high volume-to-liquidity ratio
  if (liquidity > 0 && volume > 0 && volume / liquidity > 10) {
    sandwichScore += 10;
    flags.push("vol_liq_spike");
  }

  const detected = sandwichScore >= 50;
  return {
    sandwich_detected: detected,
    sandwich_score: sandwichScore,
    sandwich_flags: flags,
    mev_loss_estimate_bps: detected ? Math.round(slippageBps * 0.6) : 0, // ~60% of excess slippage is MEV
  };
}

// ─── Token Account Rent ──────────────────────────────────

let _rentTracker = {
  accountsCreated: 0,
  accountsClosed: 0,
  totalRentPaidSol: 0,
  totalRentRefundedSol: 0,
};

export function recordTokenAccountCreated() {
  _rentTracker.accountsCreated++;
  _rentTracker.totalRentPaidSol += TOKEN_ACCOUNT_RENT_SOL;
}

export function recordTokenAccountClosed() {
  _rentTracker.accountsClosed++;
  _rentTracker.totalRentRefundedSol += TOKEN_ACCOUNT_RENT_SOL;
}

export function getRentStats() {
  return {
    ..._rentTracker,
    netRentCostSol: _rentTracker.totalRentPaidSol - _rentTracker.totalRentRefundedSol,
  };
}

// ─── RPC Cost Tracking ──────────────────────────────────

let _rpcTracker = {
  simCalls: 0,
  totalSimCostSol: 0,
  rpcCalls: 0,
  heliusCalls: 0,
};

export function recordRpcCall(type = "rpc") {
  _rpcTracker.rpcCalls++;
  if (type === "helius") _rpcTracker.heliusCalls++;
}

export function recordSimCall() {
  _rpcTracker.simCalls++;
  _rpcTracker.totalSimCostSol += AVG_RPC_SIM_COST_SOL;
}

export function getRpcCostStats() {
  return {
    ..._rpcTracker,
    estimatedTotalRpcCostSol: _rpcTracker.totalSimCostSol + _rpcTracker.rpcCalls * 0.000001,
  };
}

// ─── Comprehensive Trade Fee Breakdown ───────────────────

/**
 * Main entry point. Calculate the complete fee breakdown for a trade.
 * Called on both entry (buy) and exit (sell).
 *
 * @param {object} params
 * @returns {object} Full fee breakdown
 */
export function computeTradeFeeBreakdown({
  // Trade info
  amountSol,            // SOL value of the trade
  dexId,                // DEX identifier
  isEntry,              // true = buy, false = sell
  // Price info (for slippage)
  expectedPrice,        // Quote price before execution
  actualPrice,          // Actual execution price
  // MEV detection
  liquidity,            // Pool liquidity in USD
  volume,               // 24h volume in USD
  priceChangeAfter1m,   // Price change 1 min after trade
  // Gas info
  priorityFeeSol,       // Priority fee paid in SOL
  jitoTipSol,           // Jito tip paid in SOL
  txFeeLamports,        // Base tx fee in lamports
  // Accumulated from entry (for exit)
  entryFeeBreakdown,    // Fee breakdown from the entry trade
  // Token accounts
  tokenAccountsCreated, // Number of new token accounts created
} = {}) {
  const bd = emptyFeeBreakdown();

  const tradeSol = amountSol || 0;

  // 1. DEX swap fee
  const dex = calcDexFee(tradeSol, dexId);
  bd.dex_fee_sol = dex.dex_fee_sol;
  bd.dex_fee_bps = dex.dex_fee_bps;
  bd.dex_name = dex.dex_name;

  // 2. Platform fee (pump.fun 1% on both sides)
  const platform = calcPlatformFee(tradeSol, dexId);
  bd.platform_fee_sol = platform.platform_fee_sol;
  bd.platform_fee_bps = platform.platform_fee_bps;
  bd.platform_name = platform.platform_name;

  // 3. Slippage
  if (expectedPrice && actualPrice) {
    const slip = calcSlippage(tradeSol, expectedPrice, actualPrice);
    bd.slippage_sol = slip.slippage_sol;
    bd.slippage_bps = slip.slippage_bps;
    bd.expected_price = slip.expected_price;
    bd.actual_price = slip.actual_price;
    bd.price_impact_pct = slip.slippage_bps / 100;
  }

  // 4. MEV / Sandwich detection
  if (bd.slippage_bps > 100) {
    const mev = detectMevSandwich({
      slippageBps: bd.slippage_bps,
      liquidity,
      volume,
      priceChangeAfter1m,
    });
    bd.sandwich_detected = mev.sandwich_detected;
    if (mev.sandwich_detected) {
      bd.mev_loss_sol = tradeSol * (mev.mev_loss_estimate_bps / 10000);
      bd.fee_breakdown_note = `MEV/sandwich detected: ${mev.sandwich_flags.join(", ")}`;
    }
  }

  // 5. Gas fees
  bd.priority_fee_sol = priorityFeeSol || 0;
  bd.jito_tip_sol = jitoTipSol || 0;
  if (txFeeLamports) {
    bd.tx_fee_sol = Number(txFeeLamports) / 1e9;
  }

  // 6. Token account rent
  if (isEntry && tokenAccountsCreated) {
    bd.token_account_rent_sol = tokenAccountsCreated * TOKEN_ACCOUNT_RENT_SOL;
  }

  // 7. RPC simulation cost
  bd.rpc_sim_cost_sol = AVG_RPC_SIM_COST_SOL;

  // ─── Total ──────────────────────────────────────────
  bd.total_fee_sol = parseFloat((
    bd.dex_fee_sol +
    bd.platform_fee_sol +
    bd.slippage_sol +
    bd.mev_loss_sol +
    bd.priority_fee_sol +
    bd.jito_tip_sol +
    bd.tx_fee_sol +
    bd.token_account_rent_sol +
    bd.rpc_sim_cost_sol
  ).toFixed(8));

  // Merge with entry breakdown for exit trades
  if (!isEntry && entryFeeBreakdown) {
    // Total round-trip fees
    bd.round_trip_fee_sol = parseFloat((bd.total_fee_sol + entryFeeBreakdown.total_fee_sol).toFixed(8));
    bd.entry_fee_sol = entryFeeBreakdown.total_fee_sol;
  }

  return bd;
}

/**
 * Calculate true PnL after ALL fees.
 * truePnL = (exitSol - entrySol) / entrySol * 100
 * feeAdjustedPnL = ((exitSol - exitFees) - (entrySol + entryFees)) / (entrySol + entryFees) * 100
 */
export function calcTruePnl({ entrySol, exitSol, entryFeeBreakdown, exitFeeBreakdown } = {}) {
  const entryFees = entryFeeBreakdown?.total_fee_sol || 0;
  const exitFees = exitFeeBreakdown?.total_fee_sol || 0;
  const totalFees = entryFees + exitFees;

  const grossPnlPct = entrySol > 0 ? ((exitSol - entrySol) / entrySol) * 100 : 0;
  const netEntry = entrySol + entryFees;
  const netExit = exitSol - exitFees;
  const netPnlPct = netEntry > 0 ? ((netExit - netEntry) / netEntry) * 100 : 0;
  const feeDragPct = grossPnlPct - netPnlPct;

  return {
    gross_pnl_pct: parseFloat(grossPnlPct.toFixed(2)),
    net_pnl_pct: parseFloat(netPnlPct.toFixed(2)),
    total_fees_sol: parseFloat(totalFees.toFixed(6)),
    entry_fees_sol: parseFloat(entryFees.toFixed(6)),
    exit_fees_sol: parseFloat(exitFees.toFixed(6)),
    fee_drag_pct: parseFloat(feeDragPct.toFixed(2)),
    fee_drag_bps: Math.round(feeDragPct * 100),
  };
}

// ─── Dashboard ──────────────────────────────────────────

export function getFeeTrackerDashboard() {
  return {
    dexFees: {
      tracked: Object.keys(DEX_FEE_BPS).length,
      common: { raydium: "0.25%", orca: "0.30%", meteora: "0.04%", pumpfun: "1%" },
    },
    rent: getRentStats(),
    rpc: getRpcCostStats(),
    mev: { sandwichDetectionEnabled: true },
  };
}

// ─── Quick slippage check from swap result ──────────────

/**
 * Extract slippage from Jupiter swap result.
 * Jupiter returns priceImpactPct in the quote response.
 */
export function extractSlippageFromSwapResult(swapResult, amountInSol) {
  if (!swapResult) return { slippage_bps: 0, slippage_sol: 0 };

  const priceImpactPct = Number(swapResult?.priceImpactPct || 0);
  const slippageBps = Math.round(Math.abs(priceImpactPct) * 100);
  const actualOut = Number(swapResult?.outAmount || 0) / 1e9;
  const expectedOut = amountInSol || 0;
  const slippageSol = actualOut > 0 ? Math.abs(expectedOut - actualOut) : 0;

  return {
    slippage_bps: slippageBps,
    slippage_sol: slippageSol,
    price_impact_pct: priceImpactPct,
  };
}

export { DEX_FEE_BPS, PLATFORM_FEE_BPS, TOKEN_ACCOUNT_RENT_SOL, AVG_RPC_SIM_COST_SOL };
