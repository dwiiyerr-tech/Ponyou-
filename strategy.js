/**
 * Ponyou Strategy Definition
 * Inspired by Freqtrade strategy structure.
 */

export const strategy = {
  name: "Instant Scalping New Pair",
  
  // ─── Entry Filters (The 4-Filter Protocol) ────────────────
  filters: {
    maxGasFeeLevel: "high",      // Filter 1: extreme/high = flag
    minHolderAgeHours: 24,       // Filter 2: funded < 24h = flag
    minTopHolderSol: 0.2,        // Filter 3: balance < 0.2 SOL = flag
    maxEntryPumpMc: 3000,        // Filter 4: started < $3K and pumped = flag
    
    // Protocol: 2+ flags = SKIP, 0-1 flag = GAS IT
    maxAllowedFlags: 1,
  },

  // ─── Exit Logic (Freqtrade inspired) ──────────────────────
  
  // Minimal ROI table: { "time_in_minutes": profit_percentage }
  // Logic: If trade is open for X minutes and profit >= Y, exit.
  minimal_roi: {
    "0": 0.60,      // Exit immediately at 60% profit
    "5": 0.30,      // Exit after 5 mins if 30% profit
    "15": 0.15,     // Exit after 15 mins if 15% profit
    "30": 0.05,     // Exit after 30 mins if 5% profit
    "60": 0.0,      // Exit at break-even after 1 hour (avoid stagnation)
  },

  // Static Stop Loss (e.g. -0.15 = 15% loss)
  stoploss: -0.15,

  // Trailing Stop Loss
  trailing_stop: {
    enabled: true,
    positive_offset: 0.20,      // Start trailing after 20% profit
    positive_distance: 0.05,    // Follow peak price at 5% distance
  },

  // ─── Dynamic Scalping (Adaptive ROI) ──────────────────────
  // Logic: Menyesuaikan target profit berdasarkan kondisi pasar.
  // User request: 10-35% profit range.
  roi_presets: {
    EXTREME: { // Volatilitas gila, ambil untung cepat tapi target tinggi bisa dicapai
      "0": 0.60, "2": 0.35, "10": 0.25, "20": 0.15, "45": 0.05, "60": 0.0
    },
    HOT: { // Market bergairah, target 20-35%
      "0": 0.50, "5": 0.30, "15": 0.20, "30": 0.10, "60": 0.02
    },
    NORMAL: { // Market standar, target 15-25%
      "0": 0.40, "5": 0.25, "15": 0.15, "30": 0.05, "60": 0.0
    },
    COLD: { // Market sepi, target rendah 10-15%, keluar cepat
      "0": 0.25, "5": 0.15, "15": 0.10, "30": 0.05, "60": -0.05
    },
    DEAD: { // Market mati, segera keluar jika ada profit kecil
      "0": 0.15, "5": 0.10, "15": 0.05, "30": 0.0, "45": -0.10
    }
  },

  // ─── Protections ──────────────────────────────────────────
  protections: {
    max_open_trades: 3,           // batas normal mode
    max_open_trades_profit: 8,    // batas maksimum saat profit mode aktif
    cooldown_after_loss_min: 0,   // dihandle oleh learning-mode.js (60 menit)
  }
};

/**
 * Check ROI conditions for a position.
 * @param {number} ageMinutes - Minutes since entry
 * @param {number} currentPnlPct - Current PnL in percentage (e.g. 15.5 for 15.5%)
 * @param {string} marketCondition - Market state (EXTREME, HOT, NORMAL, etc)
 */
export function checkROI(ageMinutes, currentPnlPct, marketCondition = "NORMAL") {
  const roi = strategy.roi_presets[marketCondition] || strategy.minimal_roi;
  const pnlDecimal = currentPnlPct / 100;

  // Sort times descending to check the oldest thresholds first
  const times = Object.keys(roi).map(Number).sort((a, b) => b - a);
  
  for (const time of times) {
    if (ageMinutes >= time) {
      if (pnlDecimal >= roi[time]) {
        return { 
          exit: true, 
          reason: `ROI (${marketCondition}): ${ageMinutes.toFixed(1)}m >= ${time}m and PnL ${currentPnlPct.toFixed(2)}% >= ${roi[time] * 100}%` 
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
  const ts = strategy.trailing_stop;
  if (!ts.enabled) return { exit: false };

  const currentPnl = currentPnlPct / 100;
  const peakPnl = peakPnlPct / 100;

  // Only active after reaching offset
  if (peakPnl < ts.positive_offset) return { exit: false };

  // Exit if current PnL drops below peak - distance
  if (currentPnl <= peakPnl - ts.positive_distance) {
    return { 
      exit: true, 
      reason: `Trailing Stop: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}% (dropped > ${ts.positive_distance * 100}%)` 
    };
  }

  return { exit: false };
}

/**
 * Run the 4-filter protocol on a candidate token.
 */
export async function run4FilterProtocol(tokenData, securityDetails, gasFee) {
  let flags = [];
  const gasLevel = gasFee?.level ?? "unknown";
  const holders = securityDetails?.holders ?? [];

  // Filter 1: Global Gas Fee
  if (gasLevel === "extreme" || gasLevel === "high") {
    flags.push(`Gas Fee: ${gasLevel} level (Bots/Traffic)`);
  }

  // Filter 2: Holder Age (Funded Wallet)
  const freshlyFunded = holders.filter(h => {
    if (!h.funded_at) return false;
    const ageHours = (Date.now() / 1000 - h.funded_at) / 3600;
    return ageHours < strategy.filters.minHolderAgeHours;
  });
  if (freshlyFunded.length >= 3) {
    flags.push(`Holder Age: ${freshlyFunded.length} top holders funded < 24h ago`);
  }

  // Filter 3: Top Holder Balance
  const dustHolders = holders.filter(h => !h.is_contract && h.sol_balance < strategy.filters.minTopHolderSol);
  if (dustHolders.length >= 3) {
    flags.push(`Top Holder Balance: ${dustHolders.length} dust wallets (< 0.2 SOL)`);
  }

  // Filter 4: Entry Market Cap
  if (tokenData.initial_mcap && tokenData.initial_mcap < strategy.filters.maxEntryPumpMc) {
    const pumpRatio = tokenData.mcap / tokenData.initial_mcap;
    if (pumpRatio > 3) {
      flags.push(`Entry MC: Pumped ${pumpRatio.toFixed(1)}x from low start`);
    }
  }

  // Filter 5: Fee-to-Volume Integrity (Anti-Wash Trading)
  // Logic: Real volume pays Jito tips & Priority fees. Wash trading avoids them.
  const volumeUsd = tokenData.volume || 0;
  const globalFeesSol = tokenData.global_fees_sol || 0;
  
  if (volumeUsd > 100000 && globalFeesSol < 5) {
    flags.push(`Wash Trading: High Volume ($${(volumeUsd/1000).toFixed(0)}K) but suspiciously Low Fees (${globalFeesSol.toFixed(2)} SOL)`);
  }

  const passed = flags.length <= strategy.filters.maxAllowedFlags;
  return {
    passed,
    flags,
    action: passed ? "GAS IT" : "SKIP",
    score: 5 - flags.length,
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
