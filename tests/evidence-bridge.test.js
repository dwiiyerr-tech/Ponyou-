import fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetExperimentsForTests,
  createExperiment,
  getExperimentSummary,
  setExperimentEvidenceSource,
} from "../infra/agent-collab/experiment-tracker.js";
import { enableEvidence, runEvidenceBridge } from "../infra/agent-collab/evidence-bridge.js";

const PERF_FILE = process.env.PONYOU_PERF_FILE;

function writeTrades(trades) {
  fs.writeFileSync(PERF_FILE, JSON.stringify({ trades }));
}

function trade(ts, win, pnl) {
  return { ts, win, pnl_pct: pnl, sol_pnl_pct: pnl, hold_minutes: 10, rug_detected: false };
}

afterEach(() => {
  _resetExperimentsForTests();
  if (fs.existsSync(PERF_FILE)) fs.unlinkSync(PERF_FILE);
});

describe("evidence bridge", () => {
  function makeExperiment() {
    const exp = createExperiment({
      name: "bridge test",
      hypothesis: "h",
      baseline_rule: "b",
      candidate_rule: "c",
      status: "running",
      minimum_sample_size: 3,
    });
    // created_at is "now"; backdate it so trades written below fall after it
    setExperimentEvidenceSource({ id: exp.id, source: { kind: "closed_trades" } });
    return exp;
  }

  it("records a delta-window candidate run from closed trades", () => {
    const exp = makeExperiment();
    const later = new Date(Date.now() + 1000).toISOString();
    const later2 = new Date(Date.now() + 2000).toISOString();
    writeTrades([trade(later, true, 20), trade(later2, false, -10)]);

    const out = runEvidenceBridge();
    expect(out.results).toHaveLength(1);
    const r = out.results[0];
    expect(r.recorded).toBe(true);
    expect(r.window.trades).toBe(2);
    expect(r.window.wins).toBe(1);

    const { runs } = getExperimentSummary({ id: exp.id });
    expect(runs).toHaveLength(1);
    expect(runs[0].variant).toBe("candidate");
    expect(runs[0].context.evidence_bridge).toBe(true);
    expect(runs[0].notes).toMatch(/NO concurrent baseline arm/);
  });

  it("never double-counts: second run with no new trades records nothing", () => {
    const exp = makeExperiment();
    writeTrades([trade(new Date(Date.now() + 1000).toISOString(), true, 20)]);
    runEvidenceBridge();
    const out = runEvidenceBridge();
    expect(out.results[0].recorded).toBe(false);
    expect(out.results[0].reason).toBe("no_new_closed_trades");
    expect(getExperimentSummary({ id: exp.id }).runs).toHaveLength(1);
  });

  it("a later trade lands in the next window only", () => {
    const exp = makeExperiment();
    const t1 = new Date(Date.now() + 1000).toISOString();
    writeTrades([trade(t1, true, 20)]);
    runEvidenceBridge();

    const t2 = new Date(Date.now() + 5000).toISOString();
    writeTrades([trade(t1, true, 20), trade(t2, false, -5)]);
    const out = runEvidenceBridge();
    expect(out.results[0].recorded).toBe(true);
    expect(out.results[0].window.trades).toBe(1);

    const { summary } = getExperimentSummary({ id: exp.id });
    expect(summary.sample_size).toBe(2); // 1 + 1, not 1 + 2
  });

  it("ignores experiments without evidence_source or not running", () => {
    createExperiment({ name: "no source", hypothesis: "h", baseline_rule: "b", candidate_rule: "c", status: "running" });
    const closed = createExperiment({ name: "closed", hypothesis: "h", baseline_rule: "b", candidate_rule: "c", status: "validated" });
    setExperimentEvidenceSource({ id: closed.id, source: { kind: "closed_trades" } });
    writeTrades([trade(new Date(Date.now() + 1000).toISOString(), true, 20)]);
    const out = runEvidenceBridge();
    expect(out.experiments_checked).toBe(0);
  });

  it("enableEvidence opts experiments in by id", () => {
    const exp = createExperiment({ name: "opt-in", hypothesis: "h", baseline_rule: "b", candidate_rule: "c", status: "running" });
    const out = enableEvidence([exp.id, 999]);
    expect(out[0].evidence_source.kind).toBe("closed_trades");
    expect(out[1].error).toMatch(/not found/);
  });
});

describe("evidence bridge: skill_attribution kind", () => {
  const SKILL_FILE = process.env.PONYOU_SKILL_ATTRIBUTION_FILE;

  function makeSkillExperiment() {
    const exp = createExperiment({
      name: "skill bridge test", hypothesis: "h", baseline_rule: "b", candidate_rule: "c",
      status: "active", minimum_sample_size: 3,
    });
    setExperimentEvidenceSource({ id: exp.id, source: { kind: "skill_attribution" } });
    return exp;
  }

  it("records a run from skill-attribution entries with per-skill breakdown", () => {
    const exp = makeSkillExperiment();
    const later = (ms) => new Date(Date.now() + ms).toISOString();
    fs.writeFileSync(SKILL_FILE, JSON.stringify({ entries: [
      { ts: later(1000), skillIds: ["dip_buy"], pnl_pct: 30, win: true },
      { ts: later(2000), skillIds: ["dip_buy", "scalping"], pnl_pct: -10, win: false },
    ], bySkill: {} }));

    const out = runEvidenceBridge();
    const r = out.results.find((x) => x.experiment_id === exp.id);
    expect(r.recorded).toBe(true);
    expect(r.window.trades).toBe(2);

    const { runs } = getExperimentSummary({ id: exp.id });
    expect(runs[0].context.source_kind).toBe("skill_attribution");
    expect(runs[0].notes).toMatch(/per-skill: dip_buy=50%\/2 scalping=0%\/1/);
    fs.unlinkSync(SKILL_FILE);
  });

  it("enableEvidence rejects unknown kinds", async () => {
    const { enableEvidence } = await import("../infra/agent-collab/evidence-bridge.js");
    expect(enableEvidence([1], "nope")[0].error).toMatch(/unknown kind/);
  });
});
