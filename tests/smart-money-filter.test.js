import { describe, it, expect } from "vitest";
import {
  passesSmartMoneyFilter,
  scoreSmartMoneyQuality,
  computeConsistencyScore,
  computeProfitFactor,
  FILTER_DEFAULTS,
} from "../smart-money-filter.js";

const CFG = {
  minWinRate:      0.60,
  minTrades:       30,
  minProfitFactor: 1.5,
  minConsistency:  0.60,
};

// Gold-standard wallet that passes everything
const GOLD = {
  winrate: 0.72,
  completed_trades: 45,
  wins: 32,
  profit_factor: 2.1,
};

// ─── FILTER_DEFAULTS ──────────────────────────────────────────────────────────

describe("FILTER_DEFAULTS", () => {
  it("has the correct default values", () => {
    expect(FILTER_DEFAULTS.minWinRate).toBe(0.60);
    expect(FILTER_DEFAULTS.minTrades).toBe(30);
    expect(FILTER_DEFAULTS.minProfitFactor).toBe(1.5);
    expect(FILTER_DEFAULTS.minConsistency).toBe(0.60);
  });
});

// ─── computeProfitFactor ──────────────────────────────────────────────────────

describe("computeProfitFactor", () => {
  it("divides total_win by total_loss", () => {
    expect(computeProfitFactor(3, 2)).toBeCloseTo(1.5, 2);
  });

  it("returns null when loss is 0 and win is also 0", () => {
    expect(computeProfitFactor(0, 0)).toBeNull();
  });

  it("returns Infinity when loss is 0 but win > 0", () => {
    expect(computeProfitFactor(5, 0)).toBe(Infinity);
  });

  it("returns null for non-finite inputs", () => {
    expect(computeProfitFactor(NaN, 2)).toBeNull();
    expect(computeProfitFactor(3, null)).toBeNull();
  });
});

// ─── computeConsistencyScore ──────────────────────────────────────────────────

describe("computeConsistencyScore", () => {
  it("uses wins / completed_trades when both present", () => {
    expect(computeConsistencyScore({ wins: 7, completed_trades: 10 })).toBe(0.7);
  });

  it("falls back to winrate when wins/completed_trades absent", () => {
    expect(computeConsistencyScore({ winrate: 0.65 })).toBe(0.65);
  });

  it("falls back to win_rate field alias", () => {
    expect(computeConsistencyScore({ win_rate: 0.70 })).toBe(0.70);
  });

  it("returns 0 when no data available", () => {
    expect(computeConsistencyScore({})).toBe(0);
  });

  it("handles 0 completed_trades gracefully (no division by zero)", () => {
    expect(computeConsistencyScore({ wins: 0, completed_trades: 0, winrate: 0.50 })).toBe(0.50);
  });
});

// ─── passesSmartMoneyFilter — passing cases ───────────────────────────────────

describe("passesSmartMoneyFilter — passes", () => {
  it("gold wallet passes all criteria", () => {
    const r = passesSmartMoneyFilter(GOLD, CFG);
    expect(r.passes).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("wallet exactly at thresholds passes", () => {
    const r = passesSmartMoneyFilter({
      winrate: 0.60,
      completed_trades: 30,
      wins: 18,
      profit_factor: 1.5,
    }, CFG);
    expect(r.passes).toBe(true);
  });

  it("skips profit_factor check when field is 0 (unavailable)", () => {
    const r = passesSmartMoneyFilter({
      winrate: 0.65,
      completed_trades: 35,
      wins: 23,
      profit_factor: 0,     // sentinel = unknown
    }, CFG);
    expect(r.passes).toBe(true);
    expect(r.failures).not.toContain(expect.stringMatching(/profit_factor/));
  });

  it("skips profit_factor check when field is null", () => {
    const r = passesSmartMoneyFilter({
      winrate: 0.65,
      completed_trades: 35,
      wins: 23,
      profit_factor: null,
    }, CFG);
    expect(r.passes).toBe(true);
  });

  it("computes profit_factor from total_win_sol + total_loss_sol", () => {
    const r = passesSmartMoneyFilter({
      winrate: 0.65,
      completed_trades: 35,
      wins: 23,
      total_win_sol: 3.0,
      total_loss_sol: 1.5,  // PF = 2.0 ≥ 1.5 → pass
    }, CFG);
    expect(r.passes).toBe(true);
    expect(r.metrics.profit_factor).toBeCloseTo(2.0, 1);
  });

  it("accepts winRate (camelCase alias)", () => {
    const r = passesSmartMoneyFilter({
      winRate: 0.70,
      completed_trades: 40,
      wins: 28,
      profit_factor: 1.8,
    }, CFG);
    expect(r.passes).toBe(true);
  });

  it("accepts tradeCount alias for completed_trades", () => {
    const r = passesSmartMoneyFilter({
      winrate: 0.65,
      tradeCount: 35,
      wins: 23,
    }, CFG);
    expect(r.passes).toBe(true);
  });
});

// ─── passesSmartMoneyFilter — failure cases ───────────────────────────────────

describe("passesSmartMoneyFilter — failures", () => {
  it("rejects on low win rate", () => {
    const r = passesSmartMoneyFilter({ ...GOLD, winrate: 0.55 }, CFG);
    expect(r.passes).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining([expect.stringMatching(/win_rate/)]));
  });

  it("rejects on insufficient trades", () => {
    const r = passesSmartMoneyFilter({ ...GOLD, completed_trades: 15, wins: 11 }, CFG);
    expect(r.passes).toBe(false);
    expect(r.failures.some(f => f.includes("trades 15"))).toBe(true);
  });

  it("rejects on low profit factor", () => {
    const r = passesSmartMoneyFilter({ ...GOLD, profit_factor: 1.2 }, CFG);
    expect(r.passes).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining([expect.stringMatching(/profit_factor/)]));
  });

  it("rejects on low consistency score", () => {
    // 12 wins / 45 trades = 26.7% consistency
    const r = passesSmartMoneyFilter({ ...GOLD, wins: 12 }, CFG);
    expect(r.passes).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining([expect.stringMatching(/consistency/)]));
  });

  it("accumulates multiple failures", () => {
    const r = passesSmartMoneyFilter({
      winrate: 0.40,
      completed_trades: 5,
      wins: 2,
      profit_factor: 0.8,
    }, CFG);
    expect(r.passes).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── passesSmartMoneyFilter — metrics ─────────────────────────────────────────

describe("passesSmartMoneyFilter — metrics", () => {
  it("returns correct metrics values", () => {
    const r = passesSmartMoneyFilter(GOLD, CFG);
    expect(r.metrics.win_rate).toBeCloseTo(72, 0);
    expect(r.metrics.trades).toBe(45);
    expect(r.metrics.profit_factor).toBeCloseTo(2.1, 1);
    expect(r.metrics.consistency).toBeGreaterThan(0);
  });
});

// ─── scoreSmartMoneyQuality ───────────────────────────────────────────────────

describe("scoreSmartMoneyQuality", () => {
  it("perfect wallet scores 100", () => {
    const score = scoreSmartMoneyQuality({
      winrate: 0.90,
      completed_trades: 5 * 30, // 5× minTrades
      wins: 135,
      profit_factor: 4.5,       // 3× minPF
    }, { limits: CFG });
    expect(score).toBe(100);
  });

  it("wallet at minimum thresholds scores 0", () => {
    const score = scoreSmartMoneyQuality({
      winrate: CFG.minWinRate,
      completed_trades: CFG.minTrades,
      wins: Math.floor(CFG.minTrades * CFG.minConsistency),
      profit_factor: CFG.minProfitFactor,
    }, { limits: CFG });
    expect(score).toBe(0);
  });

  it("gold wallet scores > 0", () => {
    const score = scoreSmartMoneyQuality(GOLD, { limits: CFG });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("better wallet scores higher than worse wallet", () => {
    const good = scoreSmartMoneyQuality({
      winrate: 0.80, completed_trades: 100, wins: 80, profit_factor: 2.5,
    }, { limits: CFG });
    const ok = scoreSmartMoneyQuality({
      winrate: 0.62, completed_trades: 32, wins: 20, profit_factor: 1.6,
    }, { limits: CFG });
    expect(good).toBeGreaterThan(ok);
  });

  it("absent profit_factor uses neutral score (50)", () => {
    const withPF    = scoreSmartMoneyQuality({ ...GOLD, profit_factor: 2.5 }, { limits: CFG });
    const withoutPF = scoreSmartMoneyQuality({ ...GOLD, profit_factor: 0   }, { limits: CFG });
    // Without PF uses 50-neutral, so score differs but neither is 0
    expect(withoutPF).toBeGreaterThan(0);
    expect(withPF).not.toBe(withoutPF);
  });
});

// ─── custom config ────────────────────────────────────────────────────────────

describe("custom config overrides", () => {
  it("respects custom minTrades", () => {
    const r = passesSmartMoneyFilter({ ...GOLD, completed_trades: 10, wins: 7 }, {
      ...CFG, minTrades: 5,
    });
    expect(r.passes).toBe(true);
  });

  it("respects custom minWinRate", () => {
    const r = passesSmartMoneyFilter({ ...GOLD, winrate: 0.55 }, {
      ...CFG, minWinRate: 0.50,
    });
    expect(r.passes).toBe(true);
  });

  it("respects custom minProfitFactor", () => {
    const r = passesSmartMoneyFilter({ ...GOLD, profit_factor: 1.0 }, {
      ...CFG, minProfitFactor: 0.80,
    });
    expect(r.passes).toBe(true);
  });
});
