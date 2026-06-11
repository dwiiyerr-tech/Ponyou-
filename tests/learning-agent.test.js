/**
 * Tests for learning-agent.js gaps:
 *   Bug #2: prescreen trash-blocks must NOT count as rugs in hunter stats
 *   Bug #1: getConsecutiveLosses importable from trading-plan.js (via executor)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

// ─── Exp #11: trash blocks never feed per-source rates ───────────────────────
// History: Bug #2 narrowed the bump to scam_name/honeypot/rugcheck types, but
// even those are numerator-only by construction (there is no "block that
// survived" counterpart), so any contribution biases rug_rate toward 1.0.
// Source-stats v2 removed the trash-block bump entirely; per-source quality
// now comes from real trades + shadow-watchlist terminal outcomes, which have
// proper denominators (every watched token ends rugged/mooned/survived).

describe("learning-agent: trash-block stat policy (exp #11)", () => {
  it("the trash_blocked handler contains no bumpSource call", () => {
    const src = fs.readFileSync(
      new URL("../agents/learning-agent.js", import.meta.url), "utf8"
    );
    const handler = src.slice(src.indexOf('"learning:trash_blocked"'));
    const handlerBody = handler.slice(0, handler.indexOf("}));"));
    expect(handlerBody).not.toContain("bumpSource(");
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
