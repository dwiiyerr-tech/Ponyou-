/**
 * GMGN compatibility shim.
 * All discovery and swap functionality has been migrated to:
 *   - tools/dexscreener.js  (token discovery, security, candles)
 *   - tools/jupiter.js      (swap execution)
 *
 * This file re-exports everything so existing imports continue to work.
 */

import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

export {
  discoverTokens,
  getTokenSecurityDetails,
  getTokenKlines,
  getTokenMarketInfo,
  getTrendingNarratives,
  getSmartMoneyRank,
  getSmartMoneyInflow,
} from "./dexscreener.js";

export { swapToken } from "./jupiter.js";

/**
 * getSolanaGasFee — unchanged, uses Solana RPC directly.
 */
export async function getSolanaGasFee() {
  try {
    const connection = new Connection(process.env.RPC_URL, "confirmed");
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return { avg: 0, median: 0, level: "low" };

    const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg    = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    let level = "low";
    if (median > 500000)  level = "extreme";
    else if (median > 100000) level = "high";
    else if (median > 10000)  level = "medium";

    return { avg, median, level, unit: "micro-lamports" };
  } catch (error) {
    log("gas_error", error.message);
    return { error: error.message, avg: 0, median: 0, level: "unknown" };
  }
}
