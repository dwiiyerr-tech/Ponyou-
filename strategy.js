/**
 * Ponyou Strategy Definition (Freqtrade-inspired).
 *
 * All functions in this file now resolve the *active* strategy from
 * strategies.js on every call, so /strategy switches hot-apply without
 * restart. The exported `strategy` constant remains the "scalping"
 * preset for backward compatibility with code that imports it directly.
 */

import { getStrategy, PRESETS } from "./strategies.js";

// Legacy export — code that does `import { strategy } from "./strategy.js"`
// keeps working. New code should call getStrategy() to pick up overrides.
export const strategy = PRESETS.scalping;

/**
 * Resolve effective stop-loss (decimal, negative).
 * Hybrid: user-config override wins; otherwise active strategy default.
 * @param {number|null} userStopLossPct - From config.management.stopLossPct (percent, e.g. -15)
 * @param {{regime?: string}} [context] - Optional regime hint for runtime selector
 * @returns {number} stop-loss in decimal (e.g. -0.15)
 */
export function getEffectiveStopLoss(userStopLossPct = null, context = {}) {
  if (userStopLossPct != null && Number.isFinite(userStopLossPct) && userStopLossPct < 0) {
    return userStopLossPct / 100;
  }
  return getStrategy(null, context).stoploss;
}

/**
 * Resolve effective immediate take-profit (decimal).
 * Hybrid: if user explicitly sets takeProfitPct, exit when reached at any time.
 * Returns null if not overridden — caller should fall back to ROI table.
 * @param {number|null} userTakeProfitPct - From config.management.takeProfitPct (percent, e.g. 25)
 * @param {{regime?: string}} [context]
 * @returns {number|null} take-profit decimal (e.g. 0.25) or null
 */
export function getEffectiveImmediateTakeProfit(userTakeProfitPct = null, context = {}) {
  if (userTakeProfitPct != null && Number.isFinite(userTakeProfitPct) && userTakeProfitPct > 0) {
    return userTakeProfitPct / 100;
  }
  return null;
}

/**
 * Check ROI conditions for a position.
 * @param {number} ageMinutes - Minutes since entry
 * @param {number} currentPnlPct - Current PnL in percentage (e.g. 15.5 for 15.5%)
 * @param {string} marketCondition - Market state (EXTREME, HOT, NORMAL, etc)
 */
export function checkROI(ageMinutes, currentPnlPct, marketCondition = "NORMAL") {
  // marketCondition doubles as the regime hint for the runtime selector —
  // evolved strategies are keyed on the same set of regime labels.
  const active = getStrategy(null, { regime: marketCondition });
  const roi = active.roi_presets?.[marketCondition] || active.minimal_roi;
  const pnlDecimal = currentPnlPct / 100;

  const times = Object.keys(roi).map(Number).sort((a, b) => b - a);
  for (const time of times) {
    if (ageMinutes >= time && pnlDecimal >= roi[time]) {
      return {
        exit: true,
        reason: `ROI (${active.id}${active._evolved_id ? "+evolved:"+active._evolved_id.slice(0, 6) : ""}/${marketCondition}): ${ageMinutes.toFixed(1)}m >= ${time}m and PnL ${currentPnlPct.toFixed(2)}% >= ${roi[time] * 100}%`,
      };
    }
  }
  return { exit: false };
}

/**
 * Check Trailing Stop condition.
 * @param {{regime?: string}} [context]
 */
export function checkTrailingStop(currentPnlPct, peakPnlPct, context = {}) {
  const ts = getStrategy(null, context).trailing_stop;
  if (!ts?.enabled) return { exit: false };

  const currentPnl = currentPnlPct / 100;
  const peakPnl = peakPnlPct / 100;

  if (peakPnl < ts.positive_offset) return { exit: false };
  if (currentPnl <= peakPnl - ts.positive_distance) {
    return {
      exit: true,
      reason: `Trailing Stop: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}% (dropped > ${ts.positive_distance * 100}%)`,
    };
  }
  return { exit: false };
}

/**
 * Check partial take-profit: trigger a partial sell once when PnL crosses the threshold.
 *
 * @param {number} currentPnlPct - current PnL %
 * @param {boolean} alreadyDone - true if partial TP was already executed for this position
 * @param {{regime?: string}} [context]
 * @returns {{trigger: boolean, sell_pct?: number, reason?: string}}
 */
export function checkPartialTP(currentPnlPct, alreadyDone = false, context = {}) {
  if (alreadyDone) return { trigger: false };
  const pt = getStrategy(null, context).partial_tp;
  if (!pt?.enabled || !pt.at_pct || !pt.sell_pct) return { trigger: false };
  if (currentPnlPct >= pt.at_pct) {
    return {
      trigger: true,
      sell_pct: pt.sell_pct,
      reason: `Partial TP: PnL ${currentPnlPct.toFixed(2)}% >= ${pt.at_pct}% — sell ${pt.sell_pct}%`,
    };
  }
  return { trigger: false };
}

/**
 * Run the 4-filter protocol on a candidate token.
 * Reads filter thresholds from the *active* strategy preset, with
 * regime-aware runtime selector taking over when an evolved strategy
 * targets the same regime (tokenData.market_condition).
 */
export async function run4FilterProtocol(tokenData, securityDetails, gasFee) {
  const regime = tokenData?.market_condition || null;
  const active = getStrategy(null, { regime });
  const f = active.filters;
  const flags = [];
  const gasLevel = gasFee?.level ?? "unknown";
  const holders = securityDetails?.holders ?? [];

  const maxGasFee = active.filters?.maxGasFeeLevel ?? "high";
  if (gasLevel === "extreme" || (maxGasFee === "extreme" ? false : gasLevel === "high")) {
    flags.push(`Gas Fee: ${gasLevel} level (Bots/Traffic)`);
  }

  const freshlyFunded = holders.filter(h => {
    if (!h.funded_at) return false;
    const ageHours = (Date.now() / 1000 - h.funded_at) / 3600;
    return ageHours < f.minHolderAgeHours;
  });
  if (freshlyFunded.length >= 3) {
    flags.push(`Holder Age: ${freshlyFunded.length} top holders funded < ${f.minHolderAgeHours}h ago`);
  }

  const dustHolders = holders.filter(h => !h.is_contract && h.sol_balance < f.minTopHolderSol);
  if (dustHolders.length >= 3) {
    flags.push(`Top Holder Balance: ${dustHolders.length} dust wallets (< ${f.minTopHolderSol} SOL)`);
  }

  if (tokenData.initial_mcap && tokenData.initial_mcap < f.maxEntryPumpMc) {
    const pumpRatio = tokenData.mcap / tokenData.initial_mcap;
    if (pumpRatio > 3) {
      flags.push(`Entry MC: Pumped ${pumpRatio.toFixed(1)}x from low start`);
    }
  }

  const volumeUsd = tokenData.volume || 0;
  const globalFeesSol = tokenData.global_fees_sol || 0;
  if (volumeUsd > 100000 && globalFeesSol < 5) {
    flags.push(`Wash Trading: High Volume ($${(volumeUsd/1000).toFixed(0)}K) but Low Fees (${globalFeesSol.toFixed(2)} SOL)`);
  }

  // ─── Optional preset gates (sniper/dip_buy/smart_money) ────
  const mcap = Number(tokenData.mcap || 0);
  if (Number.isFinite(f.min_mcap_usd) && mcap > 0 && mcap < f.min_mcap_usd) {
    flags.push(`MCap below ${f.min_mcap_usd}: ${mcap.toFixed(0)}`);
  }
  if (Number.isFinite(f.max_mcap_usd) && mcap > f.max_mcap_usd) {
    flags.push(`MCap above ${f.max_mcap_usd}: ${mcap.toFixed(0)}`);
  }
  if (Number.isFinite(f.min_holders) && tokenData.holder_count != null && tokenData.holder_count < f.min_holders) {
    flags.push(`Holders below ${f.min_holders}: ${tokenData.holder_count}`);
  }
  if (Number.isFinite(f.min_token_fees_sol) && globalFeesSol < f.min_token_fees_sol) {
    flags.push(`Token fees below ${f.min_token_fees_sol} SOL: ${globalFeesSol.toFixed(2)}`);
  }

  // ─── Concentration gate (smart_money preset) ────────────────
  const top10Pct = Number(securityDetails?.rug_signals?.top10_concentration_pct ?? NaN);
  if (Number.isFinite(f.max_top10_pct) && Number.isFinite(top10Pct) && top10Pct > f.max_top10_pct) {
    flags.push(`Top10 ${top10Pct.toFixed(1)}% > max ${f.max_top10_pct}%`);
  }

  // ─── ATH-distance gate (dip_buy preset) ─────────────────────
  // tokenData.price_change_h24 / dip_from_ath_pct are negative when below ATH.
  // We accept either a precomputed dip metric or the 24h change as a proxy.
  if (Number.isFinite(f.max_ath_distance_pct)) {
    const dip = Number(
      tokenData.dip_from_ath_pct ??
      tokenData.price_change_24h ??
      tokenData.price_change_1h ??
      NaN
    );
    if (Number.isFinite(dip) && dip > f.max_ath_distance_pct) {
      flags.push(`Not dipped enough: ${dip.toFixed(1)}% > ${f.max_ath_distance_pct}%`);
    }
  }

  const passed = flags.length <= f.maxAllowedFlags;
  return {
    passed,
    flags,
    action: passed ? "GAS IT" : "SKIP",
    score: Math.max(0, 5 - flags.length),
    strategy_id: active.id,
    evolved_id: active._evolved_id || null,
    runtime_source: active._runtime_source || "preset",
  };
}

/**
 * Identify the Market Cap Tier and provide strategic context.
 */
export function getMcapTier(mcap) {
  if (mcap < 100000) return {
    tier: "NEW_PAIR",
    desc: "Pure Chaos. Lawan: Bot Sniper & Cabal.",
    guidance: "Momentum adalah segalanya. Entry cepat, exit lebih cepat. Jangan hold lebih dari hitungan menit jika tidak ada volume baru."
  };
  if (mcap < 5000000) return {
    tier: "MICRO_CAP",
    desc: "Community Driven. Lawan: Scalper & Raider.",
    guidance: "Analisis Teknikal (TA) mulai relevan. Cari pola reversal dan akumulasi volume. Distribusi holder sangat penting."
  };
  if (mcap < 50000000) return {
    tier: "MID_CAP",
    desc: "Institutional Interest. Lawan: Dolphin & Whale.",
    guidance: "Butuh narasi media untuk naik lebih jauh. Ukuran posisi (size) bisa lebih besar, tapi entry harus presisi pada saat breakout."
  };
  if (mcap < 200000000) return {
    tier: "HIGH_CAP",
    desc: "Peak Hype. Lawan: Mainstream Media & FOMO Retail.",
    guidance: "Puncak harga biasanya terjadi saat media mainstream mulai ramai. Fokus pada strategi EXIT bertahap (DCA out)."
  };
  return {
    tier: "CEX_LEVEL",
    desc: "CEX Listing / MM Controlled. Lawan: Market Makers (Wintermute, dll).",
    guidance: "Lawan algoritma institusi. Volatilitas tinggi tapi terkontrol. Fokus pada likuiditas besar dan hindari trade emosional."
  };
}

export function getTierExecutionProfile(mcap, strategyId = null) {
  const tier = getMcapTier(mcap);

  // ── Strategy-aware sell_only threshold ──────────────────────
  // Scalping strategies: block >$50M (no exit liquidity at swing scale)
  // Swing strategies:    allow up to $200M (need deep liquidity for position size)
  const swingStrategies = new Set(["day_phase_trading", "swing"]);
  const isSwing = swingStrategies.has(strategyId);

  if (tier.tier === "NEW_PAIR") {
    return {
      ...tier,
      use_holder_filters: true,
      use_technicals: false,
      size_multiplier: isSwing ? 0.5 : 1.0,    // swing: half-size di pair baru
      sell_only: false,
    };
  }
  if (tier.tier === "MICRO_CAP") {
    return {
      ...tier,
      use_holder_filters: false,
      use_technicals: true,
      size_multiplier: isSwing ? 0.75 : 1.0,   // swing: cautious size at micro cap
      sell_only: false,
    };
  }
  if (tier.tier === "MID_CAP") {
    return {
      ...tier,
      use_holder_filters: false,
      use_technicals: true,
      size_multiplier: isSwing ? 1.25 : 1.25,   // both: confidence sizing
      sell_only: false,
    };
  }
  if (tier.tier === "HIGH_CAP") {
    // Scalping: sell_only (no exit liquidity for fast trades)
    // Swing:     allowed — deep liquidity needed for multi-day positions
    return {
      ...tier,
      use_holder_filters: false,
      use_technicals: true,
      size_multiplier: isSwing ? 1.0 : 0,
      sell_only: !isSwing,
    };
  }
  // CEX_LEVEL (>$200M) — always sell_only regardless of strategy
  return {
    ...tier,
    use_holder_filters: false,
    use_technicals: false,
    size_multiplier: 0,
    sell_only: true,
  };
}
