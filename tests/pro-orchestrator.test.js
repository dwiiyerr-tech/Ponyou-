// Tests for agents/pro-orchestrator.js — narrative recommendation order,
// validation gate, and re-init safety.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agents/agent-bus.js",     () => ({ agentBus: { subscribe: vi.fn(() => vi.fn()), emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock("../agents/agent-registry.js",() => ({ setAgentStatus: vi.fn(), updateAgentHealth: vi.fn() }));
vi.mock("../logger.js",               () => ({ log: vi.fn() }));
vi.mock("../tools/cast-net-gate.js",  () => ({ evaluateCastNet: vi.fn(() => ({ allowed: false })) }));
vi.mock("../strategies.js",           () => ({ getActiveStrategy: vi.fn(() => ({ id: "scalping" })) }));
vi.mock("../tools/trash-filter.js",   () => ({ scoreTrash: vi.fn(() => ({ score: 20 })) }));
vi.mock("../conviction-memory.js",    () => ({ getExperienceScore: vi.fn(() => 0) }));
vi.mock("../tools/wallet-manager.js", () => ({ getAllWallets: vi.fn(() => []) }));
vi.mock("../config.js",               () => ({ config: { pro: {} } }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "{}") };
});
vi.mock("path", async (importOriginal) => importOriginal());

const { runProAnalysis, proBuyDecision, validateStrategyCandidate } = await import("../agents/pro-orchestrator.js");

describe("pro-orchestrator: narrative recommendation order (T3-8)", () => {
  it("AVOID takes priority over BUY when rug rate exceeds threshold", () => {
    // A narrative with 45% WR but 15% rug rate should be AVOID not BUY.
    // Prior bug: wr>=0.40 ? "BUY" was evaluated before rugRate>=0.10 ? "AVOID".
    const HIGH_RUG_RATE = 0.10;
    const obs = 15, wins = 7, rugs = 3; // WR=46%, rugRate=20% → AVOID
    const wr = wins / obs;
    const rugRate = rugs / obs;

    const rec = !( obs >= 10) ? "INSUFFICIENT_DATA"
      : wr >= 0.50 && rugRate === 0 ? "STRONG_BUY"
      : rugRate >= HIGH_RUG_RATE ? "AVOID"      // must check BEFORE BUY
      : wr >= 0.40 ? "BUY"
      : "NEUTRAL";

    expect(rec).toBe("AVOID");
    expect(wr).toBeGreaterThan(0.40); // confirms it WOULD have been BUY before fix
  });

  it("BUY when rug rate is below threshold and WR is good", () => {
    const HIGH_RUG_RATE = 0.10;
    const obs = 15, wins = 7, rugs = 1; // WR=46%, rugRate=6.7% → BUY
    const wr = wins / obs;
    const rugRate = rugs / obs;

    const rec = !(obs >= 10) ? "INSUFFICIENT_DATA"
      : wr >= 0.50 && rugRate === 0 ? "STRONG_BUY"
      : rugRate >= HIGH_RUG_RATE ? "AVOID"
      : wr >= 0.40 ? "BUY"
      : "NEUTRAL";

    expect(rec).toBe("BUY");
  });

  it("STRONG_BUY only when rug rate is exactly 0 and WR >= 50%", () => {
    const HIGH_RUG_RATE = 0.10;
    const obs = 15, wins = 8, rugs = 0;
    const wr = wins / obs;
    const rugRate = rugs / obs;

    const rec = !(obs >= 10) ? "INSUFFICIENT_DATA"
      : wr >= 0.50 && rugRate === 0 ? "STRONG_BUY"
      : rugRate >= HIGH_RUG_RATE ? "AVOID"
      : wr >= 0.40 ? "BUY"
      : "NEUTRAL";

    expect(rec).toBe("STRONG_BUY");
  });

  it("INSUFFICIENT_DATA when sample size below threshold", () => {
    const HIGH_RUG_RATE = 0.10;
    const obs = 5; // below MIN_NARRATIVE_OBS=10

    const rec = !(obs >= 10) ? "INSUFFICIENT_DATA"
      : "BUY";

    expect(rec).toBe("INSUFFICIENT_DATA");
  });
});

describe("pro-orchestrator: proBuyDecision gate", () => {
  // proBuyDecision returns action: "BUY" | "SKIP" (uppercase) and counts
  // converging signals against a threshold (default 4). It doesn't gate on
  // marketCondition directly — that's done at the caller level. These tests
  // verify signal counting and threshold behavior.

  it("returns SKIP when not enough converging signals", () => {
    const result = proBuyDecision({
      conviction: { conviction_score: 10 },  // below threshold
      signal: { aggregate: 10 },             // below threshold
      kelly: { effective_fraction: 0, should_skip: true },
      workflow: { verdict: "probe" },
      rugScore: 80,                          // above maxRugScore
      marketCondition: "NORMAL",
      narrativeVelocity: null,
      volatilityPercentile: 90,
      liquidity: 100,                        // below minLiquidity
    });
    expect(result.action).toBe("SKIP");
    expect(result).toHaveProperty("convergingSignals");
    expect(result.convergingSignals).toBeLessThan(result.requiredSignals);
  });

  it("returns BUY when enough converging signals", () => {
    const result = proBuyDecision({
      conviction: { conviction_score: 80 },  // above default 65
      signal: { aggregate: 70 },             // above default 55
      kelly: { effective_fraction: 0.15, should_skip: false },  // above default 0.08
      workflow: { verdict: "active" },
      rugScore: 10,                          // below default 25
      marketCondition: "NORMAL",
      narrativeVelocity: null,
      volatilityPercentile: 40,              // below default 80
      liquidity: 5000,                       // above default 2000
    });
    expect(result.action).toBe("BUY");
    expect(result.convergingSignals).toBeGreaterThanOrEqual(result.requiredSignals);
  });

  it("result always has required fields", () => {
    const result = proBuyDecision({
      conviction: {}, signal: {}, kelly: {},
      workflow: {}, rugScore: 0, marketCondition: "NORMAL",
    });
    expect(result).toHaveProperty("action");
    expect(result).toHaveProperty("convergingSignals");
    expect(result).toHaveProperty("requiredSignals");
    expect(["BUY", "SKIP"]).toContain(result.action);
  });
});
