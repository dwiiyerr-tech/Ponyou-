import fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadObservations,
  gates,
  replayGate,
  compareGates,
  runCounterfactualScenarios,
  SCENARIOS,
} from "../tools/counterfactual-evaluator.js";
import { _resetExperimentsForTests, getExperimentSummary, listExperiments } from "../infra/agent-collab/experiment-tracker.js";

const OBSERVED = process.env.PONYOU_OBSERVED_TOKENS_FILE;
const SHADOW = process.env.PONYOU_SHADOW_WATCHLIST_FILE;

function writeFixtures({ observed = {}, shadow = {} } = {}) {
  fs.writeFileSync(OBSERVED, JSON.stringify({ observed }));
  fs.writeFileSync(SHADOW, JSON.stringify({ tokens: shadow }));
}

function obsToken(mint, { rug = 20, mcap = 50_000, change = 10, perf = "NEUTRAL", ts = "2026-06-01T00:00:00Z" } = {}) {
  return {
    mint, symbol: mint.slice(0, 4), status: "COMPLETED", check_at: ts,
    rug_score: rug, initial_mcap: mcap, narrative: "AI", change_pct: change, performance: perf,
  };
}

afterEach(() => {
  _resetExperimentsForTests();
  for (const f of [OBSERVED, SHADOW]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

describe("loadObservations", () => {
  it("normalizes COMPLETED observed tokens and terminal shadow tokens only", () => {
    writeFixtures({
      observed: {
        a: obsToken("MintA", { perf: "RUG", change: -80 }),
        b: { mint: "MintB", status: "FAILED" }, // no outcome — excluded
      },
      shadow: {
        c: { mint: "MintC", status: "rugged", rug_score: 70, entry_price: 1, peak_price: 1, added_at: 1781000000000 },
        d: { mint: "MintD", status: "mooned", rug_score: 10, entry_price: 1, peak_price: 3, added_at: 1781000000001 },
        e: { mint: "MintE", status: "watching" }, // not terminal — excluded
      },
    });
    const obs = loadObservations();
    expect(obs).toHaveLength(3);
    const rugged = obs.find((o) => o.mint === "MintC");
    expect(rugged.is_rug).toBe(true);
    expect(rugged.return_pct).toBe(-90); // explicit shadow assumption
    expect(obs.find((o) => o.mint === "MintD").return_pct).toBeCloseTo(200);
  });
});

describe("replay and comparison", () => {
  it("replayGate splits entered/skipped and counts avoided rugs and missed winners", () => {
    const observations = [
      { rug_score: 70, return_pct: -90, is_rug: true, mcap: 10_000 },
      { rug_score: 20, return_pct: 50, is_rug: false, mcap: 10_000 },
      { rug_score: 40, return_pct: 30, is_rug: false, mcap: 10_000 },
    ];
    const strict = replayGate(gates.rugScoreMax(35), observations);
    expect(strict.entered).toBe(1);
    expect(strict.win_rate).toBe(1);
    expect(strict.rugs_avoided).toBe(1);
    expect(strict.winners_missed).toBe(1); // the rug_score 40 winner

    const loose = replayGate(gates.rugScoreMax(80), observations);
    expect(loose.entered).toBe(3);
    expect(loose.rugs_entered).toBe(1);
  });

  it("rugScoreByBand applies the first band whose maxMcap covers the observation", () => {
    const band = gates.rugScoreByBand([
      { maxMcap: 200_000, maxRug: 25 },
      { maxMcap: Infinity, maxRug: 35 },
    ]);
    expect(band({ mcap: 50_000, rug_score: 30 })).toBe(false);  // micro: gate 25
    expect(band({ mcap: 50_000, rug_score: 20 })).toBe(true);
    expect(band({ mcap: 5_000_000, rug_score: 30 })).toBe(true); // besar: gate 35
    expect(band({ mcap: 5_000_000, rug_score: 40 })).toBe(false);
  });

  it("hasNarrative excludes OTHER and empty narratives", () => {
    const g = gates.hasNarrative();
    expect(g({ narrative: "FINANCE" })).toBe(true);
    expect(g({ narrative: "OTHER" })).toBe(false);
    expect(g({ narrative: "" })).toBe(false);
  });

  it("every registered scenario has paired callable arms and rule strings", () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      expect(typeof s.baseline, name).toBe("function");
      expect(typeof s.candidate, name).toBe("function");
      expect(s.baseline_rule, name).toBeTruthy();
      expect(s.candidate_rule, name).toBeTruthy();
      expect(s.hypothesis, name).toBeTruthy();
    }
  });

  it("compareGates runs both arms on the identical dataset", () => {
    const observations = [
      { rug_score: 50, return_pct: -90, is_rug: true, mcap: 10_000 },
      { rug_score: 10, return_pct: 40, is_rug: false, mcap: 10_000 },
    ];
    const cmp = compareGates(gates.rugScoreMax(60), gates.rugScoreMax(35), observations);
    expect(cmp.baseline.entered).toBe(2);
    expect(cmp.candidate.entered).toBe(1);
    expect(cmp.delta.rug_rate).toBeLessThan(0); // stricter gate avoids the rug
  });
});

describe("scenario recording (dedicated CF experiments, delta-windowed)", () => {
  it("records paired baseline+candidate runs into a cf experiment, never a live one", () => {
    writeFixtures({
      observed: {
        a: obsToken("MintA", { rug: 50, change: -60, perf: "RUG", ts: "2026-06-01T00:00:00Z" }),
        b: obsToken("MintB", { rug: 10, change: 40, perf: "GEM", ts: "2026-06-02T00:00:00Z" }),
      },
    });
    const out = runCounterfactualScenarios({ scenarios: ["cf:rug-gate-35"] });
    const r = out.results[0];
    expect(r.recorded).toBe(true);

    const exp = listExperiments({ tag: "counterfactual" }).find((e) => e.name === "cf:rug-gate-35");
    expect(exp).toBeTruthy();
    const { runs, summary } = getExperimentSummary({ id: exp.id });
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((x) => x.variant))).toEqual(new Set(["baseline", "candidate"]));
    expect(runs[0].context.counterfactual).toBe(true);
    expect(runs[0].notes).toMatch(/Backtest-grade/);
    expect(summary.comparison).toBeTruthy(); // both arms → real comparison
  });

  it("is idempotent: rerun without new observations records nothing", () => {
    writeFixtures({ observed: { a: obsToken("MintA", { ts: "2026-06-01T00:00:00Z" }) } });
    runCounterfactualScenarios({ scenarios: ["cf:rug-gate-35"] });
    const again = runCounterfactualScenarios({ scenarios: ["cf:rug-gate-35"] });
    expect(again.results[0].recorded).toBe(false);
    expect(again.results[0].reason).toBe("no_new_observations");
    const exp = listExperiments({ tag: "counterfactual" })[0];
    expect(getExperimentSummary({ id: exp.id }).runs).toHaveLength(2);
  });

  it("a grown cohort records only the new window", () => {
    writeFixtures({ observed: { a: obsToken("MintA", { ts: "2026-06-01T00:00:00Z" }) } });
    runCounterfactualScenarios({ scenarios: ["cf:rug-gate-35"] });
    writeFixtures({ observed: {
      a: obsToken("MintA", { ts: "2026-06-01T00:00:00Z" }),
      b: obsToken("MintB", { ts: "2026-06-03T00:00:00Z", change: 25 }),
    } });
    const out = runCounterfactualScenarios({ scenarios: ["cf:rug-gate-35"] });
    expect(out.results[0].recorded).toBe(true);
    expect(out.results[0].window.count).toBe(1); // only MintB
  });
});
