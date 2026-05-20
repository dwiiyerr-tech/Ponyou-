import { describe, expect, it } from "vitest";
import { evaluateCandidateDecision } from "../decision-workflow.js";

describe("decision workflow", () => {
  it("skips candidates with negative Kelly edge", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [],
        rug_score: 8,
        kelly: { should_skip: true },
        volatility_adjusted_size: 1,
      },
      conviction: { conviction_score: 80, confidence_score: 70 },
      marketCondition: "HOT",
    });

    expect(result.verdict).toBe("skip");
    expect(result.recommended_amount_sol).toBe(0);
  });

  it("keeps low-confidence names in shadow mode", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [],
        rug_score: 10,
        kelly: { should_skip: false },
        momentum_entry_pass: true,
        volatility_adjusted_size: 1,
      },
      conviction: { conviction_score: 20, confidence_score: 10 },
      marketCondition: "NORMAL",
    });

    expect(result.verdict).toBe("shadow");
    expect(result.llm_can_buy).toBe(false);
  });

  it("allows probe entries when conviction is building but not yet strong", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [],
        rug_score: 10,
        kelly: { should_skip: false },
        momentum_entry_pass: true,
        volatility_adjusted_size: 2,
      },
      conviction: { conviction_score: 56, confidence_score: 35 },
      marketCondition: "NORMAL",
      probeSizeFraction: 0.4,
    });

    expect(result.verdict).toBe("probe");
    expect(result.recommended_amount_sol).toBe(0.7);
    expect(result.llm_can_buy).toBe(true);
  });

  it("permits active entries only for strong, low-caution setups", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [],
        rug_score: 6,
        kelly: { should_skip: false },
        momentum_entry_pass: true,
        volatility_adjusted_size: 1.5,
      },
      conviction: { conviction_score: 78, confidence_score: 64 },
      marketCondition: "HOT",
    });

    expect(result.verdict).toBe("active");
    expect(result.fast_track_eligible).toBe(true);
    expect(result.recommended_amount_sol).toBe(1.5);
  });

  it("passes normalized cold market into risk policy", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [],
        rug_score: 6,
        kelly: { should_skip: false },
        momentum_entry_pass: true,
        volatility_adjusted_size: 1,
      },
      conviction: { conviction_score: 70, confidence_score: 50 },
      marketCondition: "cold",
    });

    expect(result.reasons).toContain("cold_market");
    expect(result.policy.entry.activeConfidenceFloor).toBe(55);
    expect(result.verdict).toBe("probe");
  });

  it("does not let conviction reduce caution when rug score is elevated", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [],
        rug_score: 35,
        kelly: { should_skip: false },
        momentum_entry_pass: true,
        volatility_adjusted_size: 1,
      },
      conviction: { conviction_score: 80, confidence_score: 70 },
      marketCondition: "NORMAL",
    });

    expect(result.reasons).toContain("rug_score=35");
    expect(result.reasons).not.toContain("strong_conviction");
    expect(result.caution_score).toBe(25);
  });

  it("adds 12 caution for a single non-critical flag", () => {
    const result = evaluateCandidateDecision({
      token: {
        flags: [{ type: "thin_liquidity", severity: "medium" }],
        rug_score: 6,
        kelly: { should_skip: false },
        momentum_entry_pass: true,
        volatility_adjusted_size: 1,
      },
      conviction: { conviction_score: 65, confidence_score: 50 },
      marketCondition: "NORMAL",
    });

    expect(result.reasons).toContain("single_flag");
    expect(result.caution_score).toBe(12);
  });
});
