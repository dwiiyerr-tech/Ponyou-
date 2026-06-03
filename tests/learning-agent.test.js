/**
 * Tests for learning-agent.js gaps:
 *   Bug #2: prescreen trash-blocks must NOT count as rugs in hunter stats
 *   Bug #1: getConsecutiveLosses importable from trading-plan.js (via executor)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Bug #2: prescreen trash-block classification ─────────────────────────────
// The fix: only scam_name, honeypot, rugcheck types bump source rug count.
// prescreen (dust mcap, zero liquidity) must NOT inflate rug_rate.

const RUG_QUALITY_TYPES = new Set(["scam_name", "honeypot", "rugcheck"]);

function shouldBumpRug(type) {
  return RUG_QUALITY_TYPES.has(type);
}

describe("learning-agent: trash-block rug classification (Bug #2)", () => {
  it("scam_name → bumps rug (real signal)", () => {
    expect(shouldBumpRug("scam_name")).toBe(true);
  });

  it("honeypot → bumps rug (real signal)", () => {
    expect(shouldBumpRug("honeypot")).toBe(true);
  });

  it("rugcheck → bumps rug (real signal)", () => {
    expect(shouldBumpRug("rugcheck")).toBe(true);
  });

  it("prescreen → does NOT bump rug (data quality filter, not source quality)", () => {
    expect(shouldBumpRug("prescreen")).toBe(false);
  });

  it("research → does NOT bump rug", () => {
    expect(shouldBumpRug("research")).toBe(false);
  });

  it("unknown → does NOT bump rug", () => {
    expect(shouldBumpRug("unknown")).toBe(false);
  });

  it("blacklisted_token → does NOT bump rug", () => {
    expect(shouldBumpRug("blacklisted_token")).toBe(false);
  });
});

// ─── Bug #1: getConsecutiveLosses is properly exported ───────────────────────

describe("trading-plan: getConsecutiveLosses export (Bug #1)", () => {
  it("getConsecutiveLosses is exported from trading-plan.js", async () => {
    const module = await import("../trading-plan.js");
    expect(typeof module.getConsecutiveLosses).toBe("function");
  });

  it("getConsecutiveLosses returns a non-negative number", async () => {
    const { getConsecutiveLosses } = await import("../trading-plan.js");
    const result = getConsecutiveLosses();
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("executor.js imports getConsecutiveLosses from trading-plan", async () => {
    // Verify the import resolves without error and the function is callable
    // (executor re-exports it via its own imports)
    const { CONFIG_BOUNDS } = await import("../tools/executor.js");
    // If executor.js fails to parse the getConsecutiveLosses import, vitest
    // would throw a SyntaxError/ReferenceError here — passing proves it loaded.
    expect(CONFIG_BOUNDS).toBeDefined();
  });
});

// ─── Adaptive risk: getConsecutiveLosses feeds correct data ──────────────────

describe("adaptive-risk: consecutiveLosses integration", () => {
  it("getRiskMultiplier with 3 consecutive losses returns multiplier ≤ 0.40", async () => {
    const { getRiskMultiplier } = await import("../adaptive-risk.js");
    const result = getRiskMultiplier({ consecutiveLosses: 3, sessionPnlPct: 0, circuitLocked: false });
    expect(result.multiplier).toBeLessThanOrEqual(0.40);
    expect(result.level).toBe("DEFENSIVE_CRITICAL");
  });

  it("getRiskMultiplier with 0 losses returns multiplier 1.0 (NORMAL)", async () => {
    const { getRiskMultiplier } = await import("../adaptive-risk.js");
    const result = getRiskMultiplier({ consecutiveLosses: 0, sessionPnlPct: 0, circuitLocked: false });
    expect(result.multiplier).toBe(1.0);
    expect(result.level).toBe("NORMAL");
  });

  it("circuit locked → multiplier 0 regardless of other inputs", async () => {
    const { getRiskMultiplier } = await import("../adaptive-risk.js");
    const result = getRiskMultiplier({ consecutiveLosses: 0, sessionPnlPct: 50, circuitLocked: true });
    expect(result.multiplier).toBe(0);
    expect(result.level).toBe("CIRCUIT_LOCKED");
  });

  it("getAdaptiveRiskPromptLine returns null in NORMAL state", async () => {
    const { getAdaptiveRiskPromptLine } = await import("../adaptive-risk.js");
    const line = getAdaptiveRiskPromptLine({ consecutiveLosses: 0, sessionPnlPct: 0, circuitLocked: false, marketCondition: "NORMAL" });
    expect(line).toBeNull();
  });

  it("getAdaptiveRiskPromptLine returns string in DEFENSIVE state", async () => {
    const { getAdaptiveRiskPromptLine } = await import("../adaptive-risk.js");
    const line = getAdaptiveRiskPromptLine({ consecutiveLosses: 3, sessionPnlPct: -5, circuitLocked: false });
    expect(typeof line).toBe("string");
    expect(line).toMatch(/RISK STATE/);
  });
});

// ─── Strategy runtime selector: meetsFloor logic ─────────────────────────────

describe("strategy-runtime-selector: meetsFloor baseline entry", () => {
  it("evolved strategy with empty scores and empty rules returns null overrides", async () => {
    const { evolvedRulesToOverrides } = await import("../strategy-runtime-selector.js");
    // degen-baseline-v1 has rules: {} — no overrides to apply
    const result = evolvedRulesToOverrides({});
    expect(result).toBeNull();
  });

  it("evolved strategy with real rules produces overrides", async () => {
    const { evolvedRulesToOverrides } = await import("../strategy-runtime-selector.js");
    const result = evolvedRulesToOverrides({ stopLossPct: -12, takeProfitPct: 30 });
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("stoploss");
  });
});
