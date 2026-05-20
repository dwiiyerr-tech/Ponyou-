/**
 * Solana RPC helpers used by the agent runtime.
 */

import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

export async function getSolanaGasFee() {
  try {
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return { avg: 0, median: 0, level: "low" };

    const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    let level = "low";
    if (median > 500000) level = "extreme";
    else if (median > 100000) level = "high";
    else if (median > 10000) level = "medium";

    return { avg, median, level, unit: "micro-lamports" };
  } catch (error) {
    log("gas_error", error.message);
    return { error: error.message, avg: 0, median: 0, level: "unknown" };
  }
}
