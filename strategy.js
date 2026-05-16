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
 * @returns {number} stop-loss in decimal (e.g. -0.15)
 */
export function getEffectiveStopLoss(userStopLossPct = null) {
  if (userStopLossPct != null && Number.isFinite(userStopLossPct) && userStopLossPct < 0) {
    return userStopLossPct / 100;
  }
  return getStrategy().stoploss;
}

/**
 * Resolve effective immediate take-profit (decimal).
 * Hybrid: if user explicitly sets takeProfitPct, exit when reached at any time.
 * Returns null if not overridden — caller should fall back to ROI table.
 * @param {number|null} userTakeProfitPct - From config.management.takeProfitPct (percent, e.g. 25)
 * @returns {number|null} take-profit decimal (e.g. 0.25) or null
 */
export function getEffectiveImmediateTakeProfit(userTakeProfitPct = null) {
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
  const active = getStrategy();
  const roi = active.roi_presets?.[marketCondition] || active.minimal_roi;
  const pnlDecimal = currentPnlPct / 100;

  const times = Object.keys(roi).map(Number).sort((a, b) => b - a);
  for (const time of times) {
    if (ageMinutes >= time && pnlDecimal >= roi[time]) {
      return {
        exit: true,
        reason: `ROI (${active.id}/${marketCondition}): ${ageMinutes.toFixed(1)}m >= ${time}m and PnL ${currentPnlPct.toFixed(2)}% >= ${roi[time] * 100}%`,
      };
    }
  }
  return { exit: false };
}

/**
 * Check Trailing Stop condition.
 */
export function checkTrailingStop(currentPnlPct, peakPnlPct) {
  const ts = getStrategy().trailing_stop;
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
 * @returns {{trigger: boolean, sell_pct?: number, reason?: string}}
 */
export function checkPartialTP(currentPnlPct, alreadyDone = false) {
  if (alreadyDone) return { trigger: false };
  const pt = getStrategy().partial_tp;
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
 * Reads filter thresholds from the *active* strategy preset.
 */
export async function run4FilterProtocol(tokenData, securityDetails, gasFee) {
  const f = getStrategy().filters;
  const flags = [];
  const gasLevel = gasFee?.level ?? "unknown";
  const holders = securityDetails?.holders ?? [];

  if (gasLevel === "extreme" || gasLevel === "high") {
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

  const passed = flags.length <= f.maxAllowedFlags;
  return {
    passed,
    flags,
    action: passed ? "GAS IT" : "SKIP",
    score: Math.max(0, 5 - flags.length),
    strategy_id: getStrategy().id,
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
