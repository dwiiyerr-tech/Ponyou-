/**
 * Portfolio Manager coverage — Phase 2 multi-strategy ensemble (OpenClaw).
 * Registry/lock/attribution paths are redirected to a tmp dir by
 * vitest.config.js, so these never touch live state. config.portfolio.* is
 * mutated per-test (config is a live object) to exercise the staged flags.
 */

import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { config } from "../config.js";
import {
  upsertStrategySkill,
  _resetRegistryForTests,
} from "../strategy-skills.js";
import {
  getPortfolioBook,
  evaluateSkillFilters,
  aggregatePortfolioSignal,
  assessCorrelation,
  allocatePortfolioCapital,
  computePortfolioDecision,
  computeRebalancedWeights,
  rebalancePortfolioBook,
  recordSkillAttribution,
  getSkillAttribution,
  getPortfolioDashboard,
  _resetSkillAttributionForTests,
} from "../agents/portfolio-manager.js";

// Snapshot/restore the staged flags so tests don't leak into each other.
let _savedPortfolio;
beforeEach(() => {
  _resetRegistryForTests();
  _resetSkillAttributionForTests();
  _savedPortfolio = { ...config.portfolio };
  config.portfolio = {
    enabled: true,
    mode: "active",
    minAgree: 2,
    minEnsembleScore: 55,
    maxPerCluster: 2,
    perSkillRiskBudget: 0.5,
    rebalanceMinSample: 5,
    rebalanceMaxStep: 0.1,
  };
});
afterEach(() => {
  config.portfolio = _savedPortfolio;
});

function makeActive(id, weight, filters = {}) {
  return upsertStrategySkill({
    id,
    type: "composite",
    params: { filters },
    status: "active",
    weight,
  });
}

describe("getPortfolioBook", () => {
  it("normalizes active weights to sum 1 and excludes zero-weight skills", () => {
    makeActive("a", 0.6);
    makeActive("b", 0.2);
    makeActive("c", 0); // zero weight → excluded from the book
    const book = getPortfolioBook({ includeShadow: false });
    expect(book.skills.map(s => s.id).sort()).toEqual(["a", "b"]);
    const sum = book.skills.reduce((s, x) => s + x.normWeight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("includes shadow skills at zero capital weight when asked", () => {
    makeActive("a", 1);
    upsertStrategySkill({ id: "sh", type: "composite", params: { filters: {} }, status: "shadow", weight: 0.5 });
    const book = getPortfolioBook({ includeShadow: true });
    const shadow = book.skills.find(s => s.id === "sh");
    expect(shadow.status).toBe("shadow");
    expect(shadow.normWeight).toBe(0);
  });
});

describe("evaluateSkillFilters", () => {
  it("passes when candidate clears all bounds", () => {
    const skill = { params: { filters: { min_mcap_usd: 1000, max_mcap_usd: 100000, min_holders: 50 } } };
    const r = evaluateSkillFilters(skill, { mcap_usd: 25000, holders: 120 });
    expect(r.passed).toBe(true);
  });

  it("fails on a violated bound with a reason", () => {
    const skill = { params: { filters: { max_mcap_usd: 100000 } } };
    const r = evaluateSkillFilters(skill, { mcap_usd: 250000 });
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/mcap/);
  });

  it("does not fail on missing data (graceful degradation)", () => {
    const skill = { params: { filters: { min_mcap_usd: 1000, min_holders: 50, maxAllowedFlags: 1 } } };
    const r = evaluateSkillFilters(skill, {}); // no fields present
    expect(r.passed).toBe(true);
  });
});

describe("aggregatePortfolioSignal", () => {
  it("votes buy when enough active skills agree and weighted score clears the gate", () => {
    makeActive("a", 0.5, { max_mcap_usd: 100000 });
    makeActive("b", 0.5, { max_mcap_usd: 100000 });
    const out = aggregatePortfolioSignal({ candidate: { mcap_usd: 50000 }, baseSignal: 80 });
    expect(out.agreeCount).toBe(2);
    expect(out.ensembleScore).toBeCloseTo(80, 1);
    expect(out.summary).toBe("buy");
  });

  it("falls below the gate when only one skill passes the filters", () => {
    makeActive("a", 0.5, { max_mcap_usd: 100000 }); // passes
    makeActive("b", 0.5, { max_mcap_usd: 10000 });  // fails (mcap too high)
    const out = aggregatePortfolioSignal({ candidate: { mcap_usd: 50000 }, baseSignal: 80 });
    expect(out.agreeCount).toBe(1);
    // only half the weight contributes a vote → 40, below minEnsembleScore 55
    expect(out.ensembleScore).toBeCloseTo(40, 1);
    expect(out.summary).not.toBe("buy");
  });
});

describe("assessCorrelation", () => {
  it("blocks when the narrative cluster is at capacity", () => {
    const candidate = { narrative_tags: ["dogs"] };
    const open = [{ narrative_tags: ["dogs"] }, { narrative_tags: ["dogs"] }];
    const r = assessCorrelation({ candidate, openPositions: open, maxPerCluster: 2 });
    expect(r.cluster).toBe("dogs");
    expect(r.sameClusterCount).toBe(2);
    expect(r.allowed).toBe(false);
  });

  it("allows when below capacity", () => {
    const r = assessCorrelation({
      candidate: { narrative_tags: ["cats"] },
      openPositions: [{ narrative_tags: ["dogs"] }],
      maxPerCluster: 2,
    });
    expect(r.allowed).toBe(true);
  });
});

describe("allocatePortfolioCapital", () => {
  it("returns no_slots when global position limit is full", () => {
    makeActive("a", 1, {});
    const ensemble = aggregatePortfolioSignal({ candidate: {}, baseSignal: 80 });
    config.risk.maxPositions = 1;
    const out = allocatePortfolioCapital({ ensemble, walletSol: 10, openPositions: [{}] });
    expect(out.reason).toBe("no_slots");
    expect(out.allocations).toHaveLength(0);
  });

  it("splits capital across passing active skills within available slots", () => {
    makeActive("a", 0.5, { max_mcap_usd: 100000 });
    makeActive("b", 0.5, { max_mcap_usd: 100000 });
    config.risk.maxPositions = 5;
    const ensemble = aggregatePortfolioSignal({ candidate: { mcap_usd: 50000 }, baseSignal: 80 });
    const out = allocatePortfolioCapital({ ensemble, walletSol: 20, openPositions: [] });
    expect(out.allocations.length).toBeGreaterThan(0);
    expect(out.totalSizeSol).toBeGreaterThan(0);
  });
});

describe("computePortfolioDecision", () => {
  it("is inert when disabled", () => {
    config.portfolio.enabled = false;
    const d = computePortfolioDecision({ candidate: { mcap_usd: 50000 }, baseSignal: 90 });
    expect(d.active).toBe(false);
    expect(d.actionable).toBe(false);
  });

  it("computes but never actions in shadow mode", () => {
    config.portfolio.mode = "shadow";
    makeActive("a", 0.5, { max_mcap_usd: 100000 });
    makeActive("b", 0.5, { max_mcap_usd: 100000 });
    config.risk.maxPositions = 5;
    const d = computePortfolioDecision({ candidate: { mcap_usd: 50000, symbol: "X" }, baseSignal: 80, walletSol: 20 });
    expect(d.mode).toBe("shadow");
    expect(d.decision).toBe("buy");
    expect(d.actionable).toBe(false); // shadow never acts
  });

  it("is actionable on a buy in active mode with capital + clear correlation", () => {
    makeActive("a", 0.5, { max_mcap_usd: 100000 });
    makeActive("b", 0.5, { max_mcap_usd: 100000 });
    config.risk.maxPositions = 5;
    const d = computePortfolioDecision({
      candidate: { mcap_usd: 50000, symbol: "X", narrative_tags: ["cats"] },
      baseSignal: 80,
      walletSol: 20,
      openPositions: [],
    });
    expect(d.decision).toBe("buy");
    expect(d.actionable).toBe(true);
    expect(d.allocation.allocations.length).toBeGreaterThan(0);
  });

  it("includes shadow skills in perSkill (paper) without affecting the active gate", () => {
    makeActive("a", 0.5, { max_mcap_usd: 100000 });
    makeActive("b", 0.5, { max_mcap_usd: 100000 });
    upsertStrategySkill({ id: "sh", type: "composite", params: { filters: { max_mcap_usd: 100000 } }, status: "shadow", weight: 0 });
    config.risk.maxPositions = 5;
    const d = computePortfolioDecision({ candidate: { mcap_usd: 50000, narrative_tags: ["x"] }, baseSignal: 80, walletSol: 20 });
    expect(d.ensemble.activeCount).toBe(2); // gate counts active only
    const sh = d.ensemble.perSkill.find(v => v.skillId === "sh");
    expect(sh?.status).toBe("shadow"); // shadow rides along for paper attribution
    expect(sh?.passed).toBe(true);
    expect(d.actionable).toBe(true); // active gate unaffected by the shadow skill
  });

  it("blocks an otherwise-valid buy when correlation cap is hit", () => {
    config.portfolio.maxPerCluster = 1;
    makeActive("a", 0.5, { max_mcap_usd: 100000 });
    makeActive("b", 0.5, { max_mcap_usd: 100000 });
    config.risk.maxPositions = 5;
    const d = computePortfolioDecision({
      candidate: { mcap_usd: 50000, symbol: "X", narrative_tags: ["dogs"] },
      baseSignal: 80,
      walletSol: 20,
      openPositions: [{ narrative_tags: ["dogs"] }],
    });
    expect(d.decision).toBe("buy_correlated");
    expect(d.actionable).toBe(false);
  });
});

describe("per-skill attribution", () => {
  it("records outcomes and rolls up win rate + expectancy per skill", async () => {
    await recordSkillAttribution({ skillIds: ["a", "b"], pnlPct: 20, mint: "m1" });
    await recordSkillAttribution({ skillIds: ["a"], pnlPct: -10, mint: "m2" });
    const a = getSkillAttribution("a");
    expect(a.trades).toBe(2);
    expect(a.wins).toBe(1);
    expect(a.losses).toBe(1);
    expect(a.winRate).toBeCloseTo(0.5, 6);
    expect(a.expectancyPct).toBeCloseTo(5, 1); // (20 + -10) / 2
    const b = getSkillAttribution("b");
    expect(b.trades).toBe(1);
    expect(b.wins).toBe(1);
  });

  it("ignores records with no skillIds", async () => {
    await recordSkillAttribution({ skillIds: [], pnlPct: 50 });
    expect(getSkillAttribution()).toEqual({});
  });
});

describe("book rebalancing", () => {
  it("holds weights when no skill has enough sample", () => {
    makeActive("a", 0.5);
    makeActive("b", 0.5);
    const changes = computeRebalancedWeights({ minSample: 5 });
    expect(changes.every(c => !c.changed)).toBe(true);
    expect(changes.every(c => c.reason === "insufficient_sample")).toBe(true);
  });

  it("shifts weight toward the higher-expectancy judged skill (capped per step)", async () => {
    makeActive("a", 0.5);
    makeActive("b", 0.5);
    // a: strong winner, b: loser — both past the sample floor.
    for (let i = 0; i < 6; i++) await recordSkillAttribution({ skillIds: ["a"], pnlPct: 30, mint: `a${i}` });
    for (let i = 0; i < 6; i++) await recordSkillAttribution({ skillIds: ["b"], pnlPct: -20, mint: `b${i}` });
    const changes = computeRebalancedWeights({ minSample: 5, maxStep: 0.1 });
    const a = changes.find(c => c.id === "a");
    const b = changes.find(c => c.id === "b");
    expect(a.to).toBeGreaterThan(b.to);
    const sum = changes.reduce((s, c) => s + c.to, 0);
    expect(sum).toBeCloseTo(1, 6); // stays a proper allocation
  });

  it("rebalancePortfolioBook is inert when portfolio disabled", () => {
    config.portfolio.enabled = false;
    makeActive("a", 1);
    const res = rebalancePortfolioBook();
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("portfolio_disabled");
  });

  it("rebalancePortfolioBook persists new weights to the registry", async () => {
    makeActive("a", 0.5);
    makeActive("b", 0.5);
    for (let i = 0; i < 6; i++) await recordSkillAttribution({ skillIds: ["a"], pnlPct: 40, mint: `a${i}` });
    for (let i = 0; i < 6; i++) await recordSkillAttribution({ skillIds: ["b"], pnlPct: -30, mint: `b${i}` });
    const res = rebalancePortfolioBook({ minSample: 5 });
    expect(res.applied).toBe(true);
    const book = getPortfolioBook({ includeShadow: false });
    const wa = book.skills.find(s => s.id === "a").weight;
    const wb = book.skills.find(s => s.id === "b").weight;
    expect(wa).toBeGreaterThan(wb);
  });
});

describe("getPortfolioDashboard", () => {
  it("surfaces the staged flags and the book", () => {
    makeActive("a", 1, {});
    const dash = getPortfolioDashboard();
    expect(dash.enabled).toBe(true);
    expect(dash.mode).toBe("active");
    expect(dash.book.find(s => s.id === "a")).toBeTruthy();
  });
});
