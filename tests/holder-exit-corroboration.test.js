import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the three ABC tools so we control the signals deterministically.
const monitorHolderDumps = vi.fn();
const recordHolderSnapshot = vi.fn(async () => 1);
const analyzeHolderEntryPrices = vi.fn();
const estimateEntryPriceFromHistory = vi.fn();
const detectRugPattern = vi.fn();

vi.mock("../tools/holder-dump-monitor.js", () => ({
  monitorHolderDumps: (...a) => monitorHolderDumps(...a),
  recordHolderSnapshot: (...a) => recordHolderSnapshot(...a),
}));
vi.mock("../tools/holder-entry-price.js", () => ({
  analyzeHolderEntryPrices: (...a) => analyzeHolderEntryPrices(...a),
  estimateEntryPriceFromHistory: (...a) => estimateEntryPriceFromHistory(...a),
}));
vi.mock("../tools/rug-pattern-detector.js", () => ({
  detectRugPattern: (...a) => detectRugPattern(...a),
}));
vi.mock("../logger.js", () => ({ log: () => {} }));
vi.mock("../metrics.js", () => ({ recordCounter: () => {} }));

const { checkHolderExitSignals } = await import("../holder-exit-checks.js");

const MINT = "Mint1111111111111111111111111111111111AA"; // >=32 chars
const FLAGS = {
  dumpMonitor: { enabled: true, betaRolloutPct: 100 },
  entryPriceAnalysis: { enabled: true, betaRolloutPct: 100, fallbackUnderwaterThreshold: 85, corroborationBonus: 15 },
  rugPatternDetector: { enabled: false, betaRolloutPct: 100 },
};
const NONE_DUMP = { risk_level: "NONE", confidence: 0, recommendation: "OK", details: {} };
const HIGH_DUMP = { risk_level: "HIGH", confidence: 65, recommendation: "WATCH_CLOSELY", details: { top_dumper: "abc" } };
const UNDERWATER_FALLBACK = { underwater_pct: 90, confidence: 40, sell_pressure_risk: "HIGH", details: { method: "estimated_from_price_history" } };

const priceHistory = [{ timestamp: 1, priceUsd: 0.01 }, { timestamp: 2, priceUsd: 0.008 }, { timestamp: 3, priceUsd: 0.005 }];
const topHolders = [{ address: "w1", pct: 10, balance: 100 }];

beforeEach(() => {
  vi.clearAllMocks();
  monitorHolderDumps.mockReturnValue(NONE_DUMP);
  estimateEntryPriceFromHistory.mockReturnValue(UNDERWATER_FALLBACK);
  detectRugPattern.mockReturnValue({ pattern_detected: false });
});

describe("holder-exit corroboration (price-history fallback)", () => {
  it("fallback ALONE does not trigger an exit", async () => {
    monitorHolderDumps.mockReturnValue(NONE_DUMP); // no high-trust signal
    const r = await checkHolderExitSignals({
      position: { symbol: "X" }, mint: MINT, currentPrice: 0.005,
      topHolders, priceHistory, featureFlags: FLAGS,
    });
    expect(r).toBeNull(); // single low-confidence fallback → no exit
  });

  it("real dump HIGH (conf 65) alone does NOT cross the HIGH exit gate", async () => {
    monitorHolderDumps.mockReturnValue(HIGH_DUMP);
    const r = await checkHolderExitSignals({
      position: { symbol: "X" }, mint: MINT, currentPrice: 0.005,
      topHolders, priceHistory: [], featureFlags: FLAGS, // no price history → no fallback
    });
    expect(r).toBeNull(); // 65 < 80 HIGH gate, and < CRITICAL risk
  });

  it("fallback CORROBORATING a dump HIGH boosts confidence over the HIGH gate", async () => {
    monitorHolderDumps.mockReturnValue(HIGH_DUMP); // conf 65
    const r = await checkHolderExitSignals({
      position: { symbol: "X" }, mint: MINT, currentPrice: 0.005,
      topHolders, priceHistory, featureFlags: FLAGS, // fallback present + underwater 90
    });
    expect(r).not.toBeNull();
    expect(r.type).toBe("HOLDER_EXIT_HIGH");
    expect(r.confidence).toBe(80); // 65 + 15 corroboration bonus
    // The fallback is recorded as a corroborating signal, not the primary.
    expect(r.signals.some((s) => s.tool === "entry_price_fallback")).toBe(true);
  });

  it("fallback below its (stricter) threshold is ignored entirely", async () => {
    monitorHolderDumps.mockReturnValue(HIGH_DUMP);
    estimateEntryPriceFromHistory.mockReturnValue({ ...UNDERWATER_FALLBACK, underwater_pct: 80 }); // < 85 fallback threshold
    const r = await checkHolderExitSignals({
      position: { symbol: "X" }, mint: MINT, currentPrice: 0.005,
      topHolders, priceHistory, featureFlags: FLAGS,
    });
    // No fallback signal → no boost → dump HIGH 65 stays below the 80 gate.
    expect(r).toBeNull();
  });
});
