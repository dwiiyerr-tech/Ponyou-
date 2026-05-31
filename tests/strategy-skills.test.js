/**
 * Strategy-Skill registry coverage — the artifact + lifecycle that unifies the
 * self-improvement loop, PortfolioManager, marketplace, and backtest gate.
 * Registry/lock paths are redirected to a tmp dir by vitest.config.js, so these
 * never touch the live strategy-skills.json / skills-lock.json.
 */

import { beforeEach, describe, it, expect } from "vitest";
import {
  makeStrategySkill,
  validateStrategySkill,
  computeSkillHash,
  scorecardPasses,
  upsertStrategySkill,
  getStrategySkill,
  listStrategySkills,
  setStrategySkillStatus,
  setStrategySkillScorecard,
  setStrategySkillWeight,
  requiresApproval,
  verifySkillLock,
  bootstrapFromPresets,
  _resetRegistryForTests,
} from "../strategy-skills.js";

const PASSING = { walk_forward: { out_of_sample: { sample: 40, expectancy_pct: 3.2, win_rate: 0.42, max_drawdown_pct: 22, sharpe: 1.1 } } };

beforeEach(() => { _resetRegistryForTests(); });

describe("strategy-skills: construction + validation", () => {
  it("makeStrategySkill fills defaults, validates, and hashes", () => {
    const s = makeStrategySkill({ id: "x", params: { stoploss: -0.1 } });
    expect(s.version).toBe(1);
    expect(s.type).toBe("composite");
    expect(s.status).toBe("draft");
    expect(s.provenance.author).toBe("human");
    expect(typeof s.hash).toBe("string");
    expect(s.hash).toHaveLength(64);
  });

  it("rejects invalid shapes", () => {
    expect(validateStrategySkill({ id: "", version: 0, type: "nope", params: 1, status: "x", weight: 2, provenance: {} }).ok).toBe(false);
    expect(() => makeStrategySkill({ id: "" })).toThrow(/Invalid strategy-skill/);
  });

  it("hash is content-stable (independent of key order / timestamps)", () => {
    const a = makeStrategySkill({ id: "h", params: { a: 1, b: 2 } });
    const b = makeStrategySkill({ id: "h", params: { b: 2, a: 1 } });
    expect(a.hash).toBe(b.hash);
    expect(computeSkillHash({ id: "h", version: 1, type: "composite", params: { a: 1 }, provenance: { author: "human" } }))
      .not.toBe(a.hash);
  });
});

describe("strategy-skills: scorecard gate", () => {
  it("passes a healthy out-of-sample scorecard", () => {
    expect(scorecardPasses(PASSING).passed).toBe(true);
  });
  it("fails on small sample / negative expectancy / deep drawdown", () => {
    expect(scorecardPasses({ walk_forward: { out_of_sample: { sample: 5, expectancy_pct: 3, win_rate: 0.5, max_drawdown_pct: 10, sharpe: 1 } } }).passed).toBe(false);
    expect(scorecardPasses({ walk_forward: { out_of_sample: { sample: 50, expectancy_pct: -1, win_rate: 0.5, max_drawdown_pct: 10, sharpe: 1 } } }).passed).toBe(false);
    expect(scorecardPasses({ walk_forward: { out_of_sample: { sample: 50, expectancy_pct: 2, win_rate: 0.5, max_drawdown_pct: 90, sharpe: 1 } } }).passed).toBe(false);
    expect(scorecardPasses(null).passed).toBe(false);
  });
});

describe("strategy-skills: registry + lifecycle gates", () => {
  it("bootstraps the 6 presets as active human skills (idempotent)", () => {
    const first = bootstrapFromPresets();
    expect(first.added).toBe(6);
    expect(first.total).toBe(6);
    expect(bootstrapFromPresets().added).toBe(0); // idempotent
    const active = listStrategySkills({ status: "active" });
    expect(active.map(s => s.id)).toContain("scalping");
    expect(getStrategySkill("scalping").weight).toBe(1);
  });

  it("blocks shadow→active without a passing scorecard", () => {
    upsertStrategySkill({ id: "loop_v1", params: { stoploss: -0.1 }, provenance: { author: "loop" }, status: "shadow" });
    expect(() => setStrategySkillStatus("loop_v1", "active")).toThrow(/scorecard gate failed/);
  });

  it("blocks loop-authored promotion without manual approval, then allows it", () => {
    upsertStrategySkill({ id: "loop_v2", params: { stoploss: -0.1 }, provenance: { author: "loop" }, status: "shadow" });
    setStrategySkillScorecard("loop_v2", PASSING);
    expect(requiresApproval(getStrategySkill("loop_v2"))).toBe(true);
    expect(() => setStrategySkillStatus("loop_v2", "active")).toThrow(/manual approval/);
    const promoted = setStrategySkillStatus("loop_v2", "active", { approved: true });
    expect(promoted.status).toBe("active");
  });

  it("human-authored skills with a passing scorecard promote without approval", () => {
    upsertStrategySkill({ id: "human_v1", params: {}, provenance: { author: "human" }, status: "shadow", backtest_scorecard: PASSING });
    const p = setStrategySkillStatus("human_v1", "active");
    expect(p.status).toBe("active");
  });

  it("hash-pins into the lockfile; non-behavioral updates don't trip the pin", () => {
    upsertStrategySkill({ id: "pin_v1", params: { stoploss: -0.2 }, provenance: { author: "human" } });
    expect(verifySkillLock("pin_v1").ok).toBe(true);
    // weight + scorecard are operational metadata, NOT part of the behavior hash,
    // so updating them must not look like tampering.
    setStrategySkillWeight("pin_v1", 0.5);
    setStrategySkillScorecard("pin_v1", PASSING);
    expect(verifySkillLock("pin_v1").ok).toBe(true);
  });

  it("setStrategySkillWeight enforces [0,1]", () => {
    upsertStrategySkill({ id: "w_v1", params: {}, provenance: { author: "human" } });
    expect(() => setStrategySkillWeight("w_v1", 2)).toThrow(/\[0,1\]/);
    expect(setStrategySkillWeight("w_v1", 0.3).weight).toBe(0.3);
  });
});
