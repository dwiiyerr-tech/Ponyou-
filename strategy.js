/**
 * Ponyou Strategy System
 * Multi-strategy support inspired by Charon (yunus-0x/charon).
 * Strategies: sniper, dip_buy, smart_money, degen
 */

// ─── Strategy Definitions ─────────────────────────────────────

const STRATEGIES = {

  /**
   * Sniper: Entry cepat pada token baru. Target 30-60% profit, exit cepat.
   * Cocok untuk: HOT/EXTREME market, token baru < $100K mcap.
   */
  sniper: {
    name: "Sniper",
    description: "Fast entry on new tokens. High risk, high reward.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 12,
      minTopHolderSol: 0.1,
      maxEntryPumpMc: 5000,
      maxAllowedFlags: 1,
      minSourceCount: 1,
      maxMcap: 500_000,
      maxBundlePct: 25,
      maxRugRatioTrending: 0.4,
    },
    minimal_roi: {
      "0": 0.60,
      "3": 0.40,
      "10": 0.25,
      "20": 0.15,
      "45": 0.05,
      "60": 0.0,
    },
    stoploss: -0.12,
    trailing_stop: {
      enabled: true,
      positive_offset: 0.15,
      positive_distance: 0.05,
    },
    roi_presets: {
      EXTREME: { "0": 0.70, "2": 0.45, "8": 0.30, "20": 0.15, "40": 0.05, "60": 0.0 },
      HOT:     { "0": 0.60, "5": 0.35, "15": 0.20, "30": 0.10, "60": 0.02 },
      NORMAL:  { "0": 0.45, "5": 0.25, "15": 0.15, "30": 0.05, "60": 0.0 },
      COLD:    { "0": 0.30, "5": 0.18, "15": 0.10, "30": 0.05, "60": -0.05 },
      DEAD:    { "0": 0.20, "5": 0.10, "15": 0.05, "30": 0.0, "45": -0.10 },
    },
    protections: {
      max_open_trades: 2,
      max_open_trades_profit: 5,
      cooldown_after_loss_min: 0,
    },
  },

  /**
   * Dip Buy: Beli saat harga turun jauh dari ATH. Target reversal.
   * Cocok untuk: token dengan ATH distance > 40%, market NORMAL/HOT.
   */
  dip_buy: {
    name: "Dip Buy",
    description: "Buy dips below ATH. Requires athFilterPct config.",
    filters: {
      maxGasFeeLevel: "extreme",
      minHolderAgeHours: 24,
      minTopHolderSol: 0.2,
      maxEntryPumpMc: 10000,
      maxAllowedFlags: 1,
      minSourceCount: 1,
      maxMcap: 5_000_000,
      maxBundlePct: 30,
      maxRugRatioTrending: 0.35,
      athFilterPct: -40,    // Only buy if price is >= 40% below ATH
      minAthDistancePct: 40, // Minimum ATH distance to qualify
    },
    minimal_roi: {
      "0": 0.40,
      "10": 0.25,
      "30": 0.15,
      "60": 0.08,
      "120": 0.03,
      "240": 0.0,
    },
    stoploss: -0.20,
    trailing_stop: {
      enabled: true,
      positive_offset: 0.25,
      positive_distance: 0.08,
    },
    roi_presets: {
      EXTREME: { "0": 0.50, "5": 0.35, "15": 0.25, "30": 0.15, "60": 0.05, "120": 0.0 },
      HOT:     { "0": 0.40, "10": 0.25, "30": 0.15, "60": 0.08, "120": 0.03 },
      NORMAL:  { "0": 0.35, "15": 0.20, "45": 0.10, "90": 0.05, "180": 0.0 },
      COLD:    { "0": 0.25, "15": 0.15, "45": 0.08, "90": 0.03, "180": -0.05 },
      DEAD:    { "0": 0.15, "15": 0.08, "45": 0.03, "90": 0.0, "120": -0.10 },
    },
    protections: {
      max_open_trades: 3,
      max_open_trades_profit: 6,
      cooldown_after_loss_min: 0,
    },
  },

  /**
   * Smart Money: Ikuti wallet smart money. Kualitas tinggi, frekuensi rendah.
   * Cocok untuk: tokens dengan saved wallet exposure tinggi.
   */
  smart_money: {
    name: "Smart Money",
    description: "Follow smart money wallets. High quality, lower frequency.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 48,
      minTopHolderSol: 0.5,
      maxEntryPumpMc: 3000,
      maxAllowedFlags: 0,   // Zero tolerance
      minSourceCount: 2,    // Harus ada di minimal 2 sumber
      maxMcap: 10_000_000,
      maxBundlePct: 20,
      maxRugRatioTrending: 0.25,
      minSmartWalletExposure: 0.05, // At least 5% held by known smart wallets
    },
    minimal_roi: {
      "0": 0.50,
      "10": 0.30,
      "30": 0.20,
      "60": 0.10,
      "120": 0.05,
      "240": 0.0,
    },
    stoploss: -0.15,
    trailing_stop: {
      enabled: true,
      positive_offset: 0.20,
      positive_distance: 0.06,
    },
    roi_presets: {
      EXTREME: { "0": 0.60, "5": 0.40, "15": 0.25, "30": 0.15, "60": 0.05, "120": 0.0 },
      HOT:     { "0": 0.50, "10": 0.30, "30": 0.20, "60": 0.10, "120": 0.05 },
      NORMAL:  { "0": 0.40, "15": 0.25, "45": 0.15, "90": 0.08, "180": 0.0 },
      COLD:    { "0": 0.30, "15": 0.18, "45": 0.10, "90": 0.04, "180": -0.05 },
      DEAD:    { "0": 0.20, "15": 0.10, "45": 0.05, "90": 0.0, "120": -0.10 },
    },
    protections: {
      max_open_trades: 3,
      max_open_trades_profit: 8,
      cooldown_after_loss_min: 0,
    },
  },

  /**
   * Degen: High risk, aggressive. Lebih toleran pada filter.
   * Cocok untuk: EXTREME market, risiko tinggi diterima.
   */
  degen: {
    name: "Degen",
    description: "High risk aggressive entries. For EXTREME market conditions.",
    filters: {
      maxGasFeeLevel: "extreme",
      minHolderAgeHours: 6,
      minTopHolderSol: 0.05,
      maxEntryPumpMc: 10000,
      maxAllowedFlags: 2,   // More tolerant
      minSourceCount: 1,
      maxMcap: 1_000_000,
      maxBundlePct: 40,
      maxRugRatioTrending: 0.5,
    },
    minimal_roi: {
      "0": 0.80,
      "2": 0.50,
      "8": 0.30,
      "15": 0.20,
      "30": 0.10,
      "60": 0.0,
    },
    stoploss: -0.10,
    trailing_stop: {
      enabled: true,
      positive_offset: 0.10,
      positive_distance: 0.04,
    },
    roi_presets: {
      EXTREME: { "0": 0.90, "2": 0.60, "5": 0.40, "10": 0.25, "20": 0.10, "45": 0.0 },
      HOT:     { "0": 0.70, "3": 0.45, "10": 0.30, "20": 0.15, "45": 0.05, "60": 0.0 },
      NORMAL:  { "0": 0.50, "5": 0.30, "15": 0.18, "30": 0.08, "60": 0.0 },
      COLD:    { "0": 0.30, "5": 0.18, "15": 0.10, "30": 0.03, "60": -0.05 },
      DEAD:    { "0": 0.15, "5": 0.08, "15": 0.03, "30": 0.0, "45": -0.10 },
    },
    protections: {
      max_open_trades: 2,
      max_open_trades_profit: 6,
      cooldown_after_loss_min: 0,
    },
  },
};

// ─── Active Strategy State ────────────────────────────────────

let _activeStrategyName = "sniper";

export function getStrategyNames() {
  return Object.keys(STRATEGIES);
}

export function setActiveStrategy(name) {
  if (!STRATEGIES[name]) return false;
  _activeStrategyName = name;
  return true;
}

export function getActiveStrategyName() {
  return _activeStrategyName;
}

export function getActiveStrategy() {
  return STRATEGIES[_activeStrategyName];
}

// Legacy export: `strategy` points to the active strategy for backwards compat
export const strategy = new Proxy({}, {
  get(_, key) { return STRATEGIES[_activeStrategyName][key]; },
});

// ─── ROI Check ────────────────────────────────────────────────

/**
 * Check ROI conditions for a position.
 */
export function checkROI(ageMinutes, currentPnlPct, marketCondition = "NORMAL") {
  const active = STRATEGIES[_activeStrategyName];
  const roi = active.roi_presets[marketCondition] || active.minimal_roi;
  const pnlDecimal = currentPnlPct / 100;

  const times = Object.keys(roi).map(Number).sort((a, b) => b - a);
  for (const time of times) {
    if (ageMinutes >= time) {
      if (pnlDecimal >= roi[time]) {
        return {
          exit: true,
          reason: `ROI (${marketCondition}): ${ageMinutes.toFixed(1)}m >= ${time}m and PnL ${currentPnlPct.toFixed(2)}% >= ${roi[time] * 100}%`,
        };
      }
    }
  }
  return { exit: false };
}

/**
 * Check Trailing Stop condition.
 */
export function checkTrailingStop(currentPnlPct, peakPnlPct) {
  const ts = STRATEGIES[_activeStrategyName].trailing_stop;
  if (!ts.enabled) return { exit: false };

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

// ─── 4-Filter Protocol ────────────────────────────────────────

/**
 * Run the 4-filter protocol on a candidate token.
 */
export async function run4FilterProtocol(tokenData, securityDetails, gasFee) {
  const filters = STRATEGIES[_activeStrategyName].filters;
  let flags = [];

  // Filter 1: Global Gas Fee
  const gasLevels = ["low", "medium", "high", "extreme"];
  const maxGasIdx = gasLevels.indexOf(filters.maxGasFeeLevel);
  const curGasIdx = gasLevels.indexOf(gasFee.level);
  if (curGasIdx > maxGasIdx) {
    flags.push(`Gas Fee: ${gasFee.level} level (exceeds ${filters.maxGasFeeLevel} threshold)`);
  }

  // Filter 2: Holder Age (Funded Wallet)
  const freshlyFunded = securityDetails.holders?.filter(h => {
    if (!h.funded_at) return false;
    const ageHours = (Date.now() / 1000 - h.funded_at) / 3600;
    return ageHours < filters.minHolderAgeHours;
  }) || [];
  if (freshlyFunded.length >= 3) {
    flags.push(`Holder Age: ${freshlyFunded.length} top holders funded < ${filters.minHolderAgeHours}h ago`);
  }

  // Filter 3: Top Holder Balance
  const dustHolders = securityDetails.holders?.filter(h => !h.is_contract && h.sol_balance < filters.minTopHolderSol) || [];
  if (dustHolders.length >= 3) {
    flags.push(`Top Holder Balance: ${dustHolders.length} dust wallets (< ${filters.minTopHolderSol} SOL)`);
  }

  // Filter 4: Entry Market Cap (pump ratio)
  if (tokenData.initial_mcap && tokenData.initial_mcap < filters.maxEntryPumpMc) {
    const pumpRatio = tokenData.mcap / tokenData.initial_mcap;
    if (pumpRatio > 3) {
      flags.push(`Entry MC: Pumped ${pumpRatio.toFixed(1)}x from low start ($${filters.maxEntryPumpMc})`);
    }
  }

  // Filter 5: Fee-to-Volume Integrity (Anti-Wash Trading)
  const volumeUsd = tokenData.volume || 0;
  const globalFeesSol = tokenData.global_fees_sol || 0;
  if (volumeUsd > 100000 && globalFeesSol < 5) {
    flags.push(`Wash Trading: High Volume ($${(volumeUsd / 1000).toFixed(0)}K) but suspiciously Low Fees (${globalFeesSol.toFixed(2)} SOL)`);
  }

  // Filter 6: Bundle Rate (from Charon)
  const bundlePct = tokenData.bundle_pct || tokenData.bundler_pct || 0;
  if (filters.maxBundlePct != null && bundlePct > filters.maxBundlePct) {
    flags.push(`Bundle Rate: ${bundlePct.toFixed(1)}% > max ${filters.maxBundlePct}%`);
  }

  // Filter 7: ATH Distance (dip_buy strategy gate)
  if (filters.minAthDistancePct != null && tokenData.ath_price) {
    const currentPrice = tokenData.price || tokenData.current_price || 0;
    const athDistancePct = currentPrice > 0
      ? ((tokenData.ath_price - currentPrice) / tokenData.ath_price) * 100
      : 0;
    if (athDistancePct < filters.minAthDistancePct) {
      flags.push(`ATH Distance: ${athDistancePct.toFixed(1)}% < min ${filters.minAthDistancePct}% (not a real dip)`);
    }
  }

  const maxFlags = filters.maxAllowedFlags ?? 1;
  const passed = flags.length <= maxFlags;
  return {
    passed,
    flags,
    action: passed ? "GAS IT" : "SKIP",
    score: 7 - flags.length,
  };
}

// ─── Market Cap Tier ──────────────────────────────────────────

export function getMcapTier(mcap) {
  if (mcap < 100000) return {
    tier: "NEW_PAIR",
    desc: "Pure Chaos. Lawan: Bot Sniper & Cabal.",
    guidance: "Momentum adalah segalanya. Entry cepat, exit lebih cepat. Jangan hold lebih dari hitungan menit jika tidak ada volume baru.",
  };
  if (mcap < 5000000) return {
    tier: "MICRO_CAP",
    desc: "Community Driven. Lawan: Scalper & Raider.",
    guidance: "Analisis Teknikal (TA) mulai relevan. Cari pola reversal dan akumulasi volume. Distribusi holder sangat penting.",
  };
  if (mcap < 50000000) return {
    tier: "MID_CAP",
    desc: "Institutional Interest. Lawan: Dolphin & Whale.",
    guidance: "Butuh narasi media untuk naik lebih jauh. Ukuran posisi (size) bisa lebih besar, tapi entry harus presisi pada saat breakout.",
  };
  if (mcap < 200000000) return {
    tier: "HIGH_CAP",
    desc: "Peak Hype. Lawan: Mainstream Media & FOMO Retail.",
    guidance: "Puncak harga biasanya terjadi saat media mainstream mulai ramai. Fokus pada strategi EXIT bertahap (DCA out).",
  };
  return {
    tier: "CEX_LEVEL",
    desc: "CEX Listing / MM Controlled. Lawan: Market Makers (Wintermute, dll).",
    guidance: "Lawan algoritma institusi. Volatilitas tinggi tapi terkontrol. Fokus pada likuiditas besar dan hindari trade emosional.",
  };
}
