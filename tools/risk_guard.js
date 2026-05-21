/** Pre-trade risk validation. Pure, synchronous, no side effects. */

const DEFAULTS = Object.freeze({
  maxTradeSOL: 0.25,
  feeReserveSOL: 0.05,
  minBalanceSOL: 1.0,
  maxSlippageBps: 300,
});

export class RiskGuard {
  constructor(config = {}) {
    this._cfg = { ...DEFAULTS, ...config };
  }

  /**
   * Validate trade parameters against risk limits.
   * @param {{ balanceSOL: number, tradeSizeSOL: number, slippageBps: number }} params
   * @returns {{ ok: boolean, reason: string|null }}
   */
  check({ balanceSOL, tradeSizeSOL, slippageBps }) {
    const { maxTradeSOL, feeReserveSOL, minBalanceSOL, maxSlippageBps } = this._cfg;

    if (balanceSOL < minBalanceSOL) {
      return { ok: false, reason: `balance ${balanceSOL} SOL below minimum ${minBalanceSOL} SOL` };
    }
    if (tradeSizeSOL > maxTradeSOL) {
      return { ok: false, reason: `trade size ${tradeSizeSOL} SOL exceeds max ${maxTradeSOL} SOL` };
    }
    if (balanceSOL - tradeSizeSOL < feeReserveSOL) {
      return { ok: false, reason: `post-trade balance would leave less than ${feeReserveSOL} SOL for fees` };
    }
    if (slippageBps > maxSlippageBps) {
      return { ok: false, reason: `slippage ${slippageBps}bps exceeds cap ${maxSlippageBps}bps` };
    }
    return { ok: true, reason: null };
  }

  get config() { return { ...this._cfg }; }
}

export function createRiskGuard(config) {
  return new RiskGuard(config);
}
