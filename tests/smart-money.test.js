import { describe, expect, it } from "vitest";
import { _internalSmartMoney } from "../tools/dexscreener.js";

function makeTransfer({
  mint = "token1",
  fromUserAccount = null,
  toUserAccount = null,
  tokenAmount = 100,
} = {}) {
  return { mint, fromUserAccount, toUserAccount, tokenAmount };
}

function makeNativeTransfer({
  fromUserAccount = null,
  toUserAccount = null,
  amountSol = 0,
} = {}) {
  return {
    fromUserAccount,
    toUserAccount,
    amount: amountSol * 1e9,
  };
}

describe("parseSolanaSwap", () => {
  it("parses buy swaps using feePayer-owned transfers", () => {
    const swap = _internalSmartMoney.parseSolanaSwap({
      signature: "sig1",
      timestamp: 1000,
      feePayer: "walletA",
      tokenTransfers: [
        makeTransfer({ toUserAccount: "walletA", tokenAmount: 200 }),
      ],
      nativeTransfers: [
        makeNativeTransfer({ fromUserAccount: "walletA", amountSol: 2 }),
      ],
      fee: 5000,
    });

    expect(swap.type).toBe("buy");
    expect(swap.token_amount).toBe(200);
    expect(swap.sol_value).toBeCloseTo(2);
    expect(swap.unit_price_sol).toBeCloseTo(0.01);
  });

  it("parses sell swaps using feePayer-owned transfers", () => {
    const swap = _internalSmartMoney.parseSolanaSwap({
      signature: "sig2",
      timestamp: 1010,
      feePayer: "walletA",
      tokenTransfers: [
        makeTransfer({ fromUserAccount: "walletA", tokenAmount: 50 }),
      ],
      nativeTransfers: [
        makeNativeTransfer({ toUserAccount: "walletA", amountSol: 1.5 }),
      ],
      fee: 5000,
    });

    expect(swap.type).toBe("sell");
    expect(swap.token_amount).toBe(50);
    expect(swap.sol_value).toBeCloseTo(1.5);
  });
});

describe("analyzeSmartWalletPerformance", () => {
  it("computes realized pnl with FIFO matching", () => {
    const stats = _internalSmartMoney.analyzeSmartWalletPerformance([
      { type: "buy", token_mint: "mintA", token_amount: 100, sol_value: 1, timestamp: 1000 },
      { type: "sell", token_mint: "mintA", token_amount: 100, sol_value: 1.4, timestamp: 1600 },
    ]);

    expect(stats.trade_count).toBe(1);
    expect(stats.realized_pnl_sol).toBeCloseTo(0.4);
    expect(stats.winrate).toBe(1);
    expect(stats.avg_hold_minutes).toBeCloseTo(10);
  });

  it("tracks open positions and conviction separately from realized trades", () => {
    const stats = _internalSmartMoney.analyzeSmartWalletPerformance([
      { type: "buy", token_mint: "mintA", token_amount: 100, sol_value: 1, timestamp: 1000 },
      { type: "buy", token_mint: "mintB", token_amount: 50, sol_value: 0.5, timestamp: 1100 },
      { type: "sell", token_mint: "mintA", token_amount: 100, sol_value: 0.8, timestamp: 1700 },
    ]);

    expect(stats.trade_count).toBe(1);
    expect(stats.realized_pnl_sol).toBeCloseTo(-0.2);
    expect(stats.open_positions).toBe(1);
    expect(stats.buy_count).toBe(2);
    expect(stats.sell_count).toBe(1);
    expect(stats.conviction_score).toBeGreaterThanOrEqual(0);
  });

  it("returns safe zero defaults for empty swap lists", () => {
    const stats = _internalSmartMoney.analyzeSmartWalletPerformance([]);
    expect(stats.trade_count).toBe(0);
    expect(stats.realized_pnl_sol).toBe(0);
    expect(stats.buy_pressure).toBe(0.5);
  });
});
