/** Dynamic priority fee calculation using Solana RPC fee percentiles. */

export const PriorityFeeMode = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  AUTO: "AUTO",
});

const FALLBACK = Object.freeze({ LOW: 1_000, MEDIUM: 5_000, HIGH: 25_000, AUTO: 10_000 });

/** Percentile index helpers over a sorted number array. */
function percentile(arr, p) {
  if (!arr.length) return null;
  const idx = Math.floor((p / 100) * (arr.length - 1));
  return arr[idx];
}

export class PriorityFeeManager {
  /**
   * @param {{ rpcUrl: string, programKeys?: string[] }} opts
   * programKeys: Solana program pubkeys to scope fee lookups (e.g. Raydium, Orca)
   */
  constructor({ rpcUrl, programKeys = [] }) {
    this._rpcUrl = rpcUrl;
    this._programKeys = programKeys;
  }

  async _rpcCall(method, params) {
    const res = await fetch(this._rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  }

  async _getRecentFees() {
    const params = this._programKeys.length ? [this._programKeys] : [];
    const result = await this._rpcCall("getRecentPrioritizationFees", params);
    if (!Array.isArray(result) || !result.length) return null;
    return result.map((r) => r.prioritizationFee).sort((a, b) => a - b);
  }

  /** Returns microLamports for the given mode. Falls back to static values on RPC failure. */
  async getFee(mode = PriorityFeeMode.MEDIUM) {
    const normalized = String(mode).toUpperCase();
    if (!PriorityFeeMode[normalized]) throw new Error(`Unknown fee mode: ${mode}`);

    let fees;
    try {
      fees = await this._getRecentFees();
    } catch {
      return FALLBACK[normalized];
    }

    if (!fees || fees.length < 4) return FALLBACK[normalized];

    switch (normalized) {
      case "LOW":    return percentile(fees, 25) ?? FALLBACK.LOW;
      case "MEDIUM": return percentile(fees, 50) ?? FALLBACK.MEDIUM;
      case "HIGH":   return percentile(fees, 75) ?? FALLBACK.HIGH;
      case "AUTO": {
        // Use p90 if network is congested (recent fees heavily skewed high), else p50
        const p50 = percentile(fees, 50);
        const p90 = percentile(fees, 90);
        const congested = p90 > p50 * 3;
        return (congested ? p90 : p50) ?? FALLBACK.AUTO;
      }
      default: return FALLBACK.MEDIUM;
    }
  }
}

export function createPriorityFeeManager(opts) {
  return new PriorityFeeManager(opts);
}
