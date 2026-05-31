/**
 * Skill Codifier coverage — Phase 3 Hermes self-improvement loop. Registry,
 * profit-pattern, and attribution paths are redirected to a tmp dir by
 * vitest.config.js, so these never touch live state. The HARD GATE (loop never
 * auto-promotes to live capital) is asserted explicitly.
 */

import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { config } from "../config.js";
import { priceSeq } from "../backtest.js";
import { recordProfitPattern, _resetConvictionMemoryForTests } from "../conviction-memory.js";
import {
  getStrategySkill,
  _resetRegistryForTests,
} from "../strategy-skills.js";
import { recordSkillAttribution, _resetSkillAttributionForTests } from "../agents/portfolio-manager.js";
import {
  mineWinningPatterns,
  authorSkillFromPattern,
  backtestSkill,
  proposeShadowSkill,
  buildApprovalRequest,
  promoteSkillWithApproval,
  runCodifierCycle,
  getSkillLoopDashboard,
  MCAP_TIER_BOUNDS,
} from "../agents/skill-codifier.js";

let _savedSkillLoop;
beforeEach(() => {
  _resetRegistryForTests();
  _resetSkillAttributionForTests();
  _resetConvictionMemoryForTests();
  _savedSkillLoop = { ...config.skillLoop };
  config.skillLoop = { enabled: true, minPatternSample: 5, minShadowSample: 10, promotionMaxWeight: 0.1 };
});
afterEach(() => {
  config.skillLoop = _savedSkillLoop;
});

// A scorecard hand-built to clear DEFAULT_PROMOTION_THRESHOLDS.
function passingScorecard() {
  const m = { sample: 35, win_rate: 0.5, expectancy_pct: 8, max_drawdown_pct: 25, sharpe: 0.4 };
  return {
    sample: 50,
    metrics: { ...m, sample: 50 },
    walk_forward: { in_sample: m, out_of_sample: m },
  };
}

function seedWinningPatterns(n = 8, mcap = 100_000) {
  for (let i = 0; i < n; i++) {
    recordProfitPattern({
      mint: `mint${i}`,
      symbol: "WIN",
      name: "win",
      pnl_pct: 40 + i,
      hold_minutes: 12,
      token: { mcap, narrative_tags: ["cats"] },
      strategy: "scalping",
    });
  }
}

describe("mineWinningPatterns", () => {
  it("returns null without enough sample", () => {
    seedWinningPatterns(2);
    expect(mineWinningPatterns({ minSample: 5 })).toBeNull();
  });

  it("surfaces the dominant mcap tier + narrative once enough patterns exist", () => {
    seedWinningPatterns(8, 100_000); // micro tier
    const p = mineWinningPatterns({ minSample: 5 });
    expect(p).toBeTruthy();
    expect(p.mcapTier).toBe("micro");
    expect(p.narrative).toBe("cats");
    expect(p.baseStrategyId).toBe("scalping");
  });
});

describe("authorSkillFromPattern", () => {
  it("authors a loop skill with tightened mcap filters and loop provenance", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", narrative: "cats", baseStrategyId: "scalping", sample: 8, avgPnl: 45 });
    expect(skill.provenance.author).toBe("loop");
    expect(skill.provenance.parent_skills).toEqual(["scalping"]);
    expect(skill.status).toBe("draft");
    expect(skill.weight).toBe(0);
    expect(skill.params.filters.min_mcap_usd).toBe(MCAP_TIER_BOUNDS.micro.min_mcap_usd);
    expect(skill.params.filters.max_mcap_usd).toBe(MCAP_TIER_BOUNDS.micro.max_mcap_usd);
    expect(skill.id).toMatch(/^loop_scalping_micro_v\d+$/);
  });

  it("drops the upper mcap bound for the large tier", () => {
    const skill = authorSkillFromPattern({ mcapTier: "large", baseStrategyId: "scalping" });
    expect(skill.params.filters.min_mcap_usd).toBe(50_000_000);
    expect(skill.params.filters.max_mcap_usd).toBeUndefined();
  });

  it("falls back to the default base strategy for an unknown id", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "does_not_exist" });
    expect(skill.provenance.parent_skills).toEqual(["scalping"]);
  });
});

describe("backtestSkill", () => {
  it("produces a scorecard with metrics + walk-forward from injected trades", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    const trades = Array.from({ length: 10 }, () => ({
      priceSequence: priceSeq([1, 1.2, 1.5, 1.8], 60_000, 0),
      marketCondition: "NORMAL",
    }));
    const card = backtestSkill(skill, { trades, splitRatio: 0.7 });
    expect(card.metrics.sample).toBe(10);
    expect(card.walk_forward.out_of_sample).toBeTruthy();
    expect(card.cost_model.roundtrip_cost_pct).toBeGreaterThan(0);
  });
});

describe("proposeShadowSkill (the gate)", () => {
  it("registers a passing skill as shadow with its scorecard", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    const verdict = proposeShadowSkill(skill, passingScorecard());
    expect(verdict.accepted).toBe(true);
    const stored = getStrategySkill(skill.id);
    expect(stored.status).toBe("shadow");
    expect(stored.backtest_scorecard).toBeTruthy();
  });

  it("rejects (never registers active) a skill that fails the gate", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    const bad = { sample: 4, metrics: { sample: 4, win_rate: 0.1, expectancy_pct: -5, max_drawdown_pct: 80, sharpe: -1 }, walk_forward: { out_of_sample: { sample: 2 } } };
    const verdict = proposeShadowSkill(skill, bad);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/gate_failed/);
    expect(getStrategySkill(skill.id)).toBeNull();
  });
});

describe("buildApprovalRequest", () => {
  it("returns null until the shadow skill accrues enough paper sample", async () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    proposeShadowSkill(skill, passingScorecard());
    expect(buildApprovalRequest(skill.id, { minShadowSample: 10 })).toBeNull();

    for (let i = 0; i < 10; i++) await recordSkillAttribution({ skillIds: [skill.id], pnlPct: 5, mint: `m${i}` });
    const req = buildApprovalRequest(skill.id, { minShadowSample: 10 });
    expect(req).toBeTruthy();
    expect(req.type).toBe("skill_promotion_request");
    expect(req.proposed_weight).toBeLessThanOrEqual(0.1);
    expect(req.paper_attribution.trades).toBe(10);
  });
});

describe("promoteSkillWithApproval (HARD GATE)", () => {
  it("refuses to promote without explicit approval", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    proposeShadowSkill(skill, passingScorecard());
    expect(() => promoteSkillWithApproval(skill.id, { approved: false })).toThrow(/requires explicit approval/);
    expect(getStrategySkill(skill.id).status).toBe("shadow"); // unchanged
  });

  it("promotes an approved skill to active at a capped weight", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    proposeShadowSkill(skill, passingScorecard());
    const updated = promoteSkillWithApproval(skill.id, { approved: true, weight: 0.5 });
    expect(updated.status).toBe("active");
    expect(updated.weight).toBeLessThanOrEqual(0.1); // weight capped despite asking for 0.5
  });
});

describe("runCodifierCycle", () => {
  it("is inert when the loop is disabled", async () => {
    config.skillLoop.enabled = false;
    const r = await runCodifierCycle();
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("skill_loop_disabled");
  });

  it("mines + authors but reports no_backtest_trades when the loader returns none", async () => {
    seedWinningPatterns(8);
    const r = await runCodifierCycle({ loadTradesFn: async () => [] });
    expect(r.ran).toBe(true);
    expect(r.authored).toBe(false);
    expect(r.reason).toBe("no_backtest_trades");
    expect(r.skillId).toMatch(/^loop_scalping_micro_v\d+$/);
  });

  it("reports no_minable_pattern when there is no signal", async () => {
    const r = await runCodifierCycle({ loadTradesFn: async () => [] });
    expect(r.ran).toBe(true);
    expect(r.authored).toBe(false);
    expect(r.reason).toBe("no_minable_pattern");
  });
});

describe("getSkillLoopDashboard", () => {
  it("lists loop shadow skills with their paper sample", () => {
    const skill = authorSkillFromPattern({ mcapTier: "micro", baseStrategyId: "scalping" });
    proposeShadowSkill(skill, passingScorecard());
    const dash = getSkillLoopDashboard();
    expect(dash.enabled).toBe(true);
    expect(dash.shadowSkills.find(s => s.id === skill.id)).toBeTruthy();
  });
});
