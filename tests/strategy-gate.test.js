import { describe, expect, it, vi } from "vitest";
import { StrategyGate } from "../strategy-gate.js";

function createGate(overrides = {}) {
  return new StrategyGate({
    minWinRate: 0.80,
    minBacktestTrades: 100,
    minPaperTrades: 30,
    minLiveTrades: 20,
    ...overrides,
  });
}

describe("StrategyGate", () => {
  it("passes all 3 layers when all metrics are at or above threshold", async () => {
    const backtestRunner = vi.fn(async () => ({
      winRate: 0.80,
      trades: 100,
      profitFactor: 1.5,
    }));
    const paperTradeReader = vi.fn(async () => ({
      winRate: 0.80,
      trades: 30,
      profitFactor: 1.5,
    }));
    const liveTradeReader = vi.fn(async () => ({
      winRate: 0.80,
      trades: 20,
      profitFactor: 1.5,
    }));
    const strategyGate = createGate({ backtestRunner, paperTradeReader, liveTradeReader });

    const result = await strategyGate.evaluate("strategy-id");

    expect(result.passed).toBe(true);
    expect(result.scores).toEqual({
      backtest: 0.80,
      paper: 0.80,
      live: 0.80,
    });
  });

  it("fails layer 1 when backtest winRate is below 0.80", async () => {
    const backtestRunner = vi.fn(async () => ({
      winRate: 0.79,
      trades: 100,
      profitFactor: 1.5,
    }));
    const paperTradeReader = vi.fn(async () => ({
      winRate: 0.90,
      trades: 30,
      profitFactor: 1.5,
    }));
    const liveTradeReader = vi.fn(async () => ({
      winRate: 0.90,
      trades: 20,
      profitFactor: 1.5,
    }));
    const strategyGate = createGate({ backtestRunner, paperTradeReader, liveTradeReader });

    const result = await strategyGate.evaluate("strategy-id");

    expect(result.passed).toBe(false);
    expect(result.failedLayer).toBe(1);
    expect(result.rejectReason).toContain("backtest");
    expect(paperTradeReader).not.toHaveBeenCalled();
    expect(liveTradeReader).not.toHaveBeenCalled();
  });

  it("fails layer 2 when paper winRate is below 0.80", async () => {
    const backtestRunner = vi.fn(async () => ({
      winRate: 0.90,
      trades: 100,
      profitFactor: 1.5,
    }));
    const paperTradeReader = vi.fn(async () => ({
      winRate: 0.79,
      trades: 30,
      profitFactor: 1.5,
    }));
    const liveTradeReader = vi.fn(async () => ({
      winRate: 0.90,
      trades: 20,
      profitFactor: 1.5,
    }));
    const strategyGate = createGate({ backtestRunner, paperTradeReader, liveTradeReader });

    const result = await strategyGate.evaluate("strategy-id");

    expect(result.passed).toBe(false);
    expect(result.failedLayer).toBe(2);
    expect(liveTradeReader).not.toHaveBeenCalled();
  });

  it("fails layer 3 when live trade count is below minLiveTrades", async () => {
    const backtestRunner = vi.fn(async () => ({
      winRate: 0.90,
      trades: 100,
      profitFactor: 1.5,
    }));
    const paperTradeReader = vi.fn(async () => ({
      winRate: 0.90,
      trades: 30,
      profitFactor: 1.5,
    }));
    const liveTradeReader = vi.fn(async () => ({
      winRate: 0.90,
      trades: 19,
      profitFactor: 1.5,
    }));
    const strategyGate = createGate({ backtestRunner, paperTradeReader, liveTradeReader });

    const result = await strategyGate.evaluate("strategy-id");

    expect(result.passed).toBe(false);
    expect(result.failedLayer).toBe(3);
    expect(result.rejectReason).toContain("live trades");
  });
});
