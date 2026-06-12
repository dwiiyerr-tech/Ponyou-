/**
 * Counterfactual exit evaluator — replay kebijakan exit pada path candle.
 * Konvensi yang dikunci di sini: intrabar pesimis (fill adverse duluan),
 * trailing pakai peak PRA-bar (no look-ahead), clamp model -90% identik di
 * kedua arm, baseline = outcome aktual, delta-window idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  replayExitPolicy,
  loadClosedPositions,
  captureCandles,
  runExitScenarios,
  EXIT_POLICIES,
  CURRENT_POLICY,
} from "../tools/counterfactual-exit.js";
import { _resetExperimentsForTests, getExperimentSummary, listExperiments } from "../infra/agent-collab/experiment-tracker.js";

// bar helper: time in seconds, prices relative to entry 1.0
const bar = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 1 });

describe("replayExitPolicy", () => {
  const entry = { entryPrice: 1.0, entryTs: 0 };

  it("SL fills at the stop level on the bar whose low touches it", () => {
    const candles = [bar(60, 1.0, 1.02, 0.95, 0.96), bar(120, 0.96, 0.97, 0.85, 0.9)];
    const r = replayExitPolicy({ sl_pct: -12, trail: null, partial: null }, { ...entry, candles });
    expect(r.exit_reason).toBe("sl");
    expect(r.pnl_pct).toBe(-12);
    expect(r.bars).toBe(2);
  });

  it("trailing activates on peak then exits at peak*(1-drop) using the PRE-bar peak", () => {
    // bar1 peak +20 (activates trail 5/2) → trail level = 1.2*0.98-1 = +17.6%
    const candles = [bar(60, 1.0, 1.2, 1.0, 1.18), bar(120, 1.18, 1.19, 1.10, 1.12)];
    const r = replayExitPolicy(CURRENT_POLICY, { ...entry, candles });
    expect(r.exit_reason).toBe("trailing");
    expect(r.pnl_pct).toBeCloseTo(17.6, 1);
  });

  it("pessimistic intrabar: when SL and new-peak share a bar, SL fills first and the bar is counted ambiguous", () => {
    const candles = [bar(60, 1.0, 1.5, 0.85, 1.4)]; // high +50, low -15 in ONE bar
    const r = replayExitPolicy({ sl_pct: -12, trail: null, partial: null }, { ...entry, candles });
    expect(r.exit_reason).toBe("sl");
    expect(r.pnl_pct).toBe(-12);
    expect(r.ambiguous_bars).toBe(1);
  });

  it("partial-TP locks the fraction at the trigger and the remainder rides to the final exit", () => {
    const policy = { sl_pct: -12, trail: null, partial: { frac: 0.5, at_pct: 25 } };
    const candles = [bar(60, 1.0, 1.3, 1.0, 1.28), bar(120, 1.28, 1.29, 0.87, 0.88)];
    const r = replayExitPolicy(policy, { ...entry, candles });
    // 50% @ +25 = +12.5 realized; sisa 50% kena SL -12 = -6 → total +6.5
    expect(r.exit_reason).toBe("sl");
    expect(r.pnl_pct).toBeCloseTo(6.5, 1);
  });

  it("horizon timeout exits at the last close and the model floor is -90", () => {
    const candles = [bar(60, 1.0, 1.0, 0.04, 0.05)]; // -95% close, no SL set
    const r = replayExitPolicy({ sl_pct: null, trail: null, partial: null }, { ...entry, candles });
    expect(r.exit_reason).toBe("horizon_timeout");
    expect(r.pnl_pct).toBe(-90);
  });

  it("returns no_data without candles or entry price", () => {
    expect(replayExitPolicy(CURRENT_POLICY, { candles: [], entryPrice: 1 }).exit_reason).toBe("no_data");
    expect(replayExitPolicy(CURRENT_POLICY, { candles: [bar(1, 1, 1, 1, 1)], entryPrice: 0 }).exit_reason).toBe("no_data");
  });
});

describe("dataset + recording (env-isolated)", () => {
  let dir, prevEnv;
  const ENV_KEYS = ["PONYOU_STATE_FILE", "PONYOU_ARCHIVE_FILE", "PONYOU_TRADE_ATTRIBUTION_FILE", "PONYOU_EXIT_CANDLE_ARCHIVE"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-exit-"));
    prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.PONYOU_STATE_FILE = path.join(dir, "state.json");
    process.env.PONYOU_ARCHIVE_FILE = path.join(dir, "archive.json");
    process.env.PONYOU_TRADE_ATTRIBUTION_FILE = path.join(dir, "attrib.json");
    process.env.PONYOU_EXIT_CANDLE_ARCHIVE = path.join(dir, "candles.json");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) process.env[k] = prevEnv[k];
    fs.rmSync(dir, { recursive: true, force: true });
    _resetExperimentsForTests();
  });

  function seedPosition({ key = "MintA::w", pnl = -16, closedAt = "2026-06-11T19:00:00Z" } = {}) {
    const mint = key.split("::")[0];
    const state = JSON.parse(fs.existsSync(process.env.PONYOU_STATE_FILE)
      ? fs.readFileSync(process.env.PONYOU_STATE_FILE, "utf8") : '{"positions":{}}');
    state.positions[key] = {
      position_key: key, closed: true, closed_at: closedAt, deployed_at: "2026-06-11T18:30:00Z",
      pool_name: "SEED", peak_pnl_pct: 8, notes: ["Closed: Stop Loss"],
      signal_snapshot: { entry_price: 1.0 },
    };
    fs.writeFileSync(process.env.PONYOU_STATE_FILE, JSON.stringify(state));
    const attrib = JSON.parse(fs.existsSync(process.env.PONYOU_TRADE_ATTRIBUTION_FILE)
      ? fs.readFileSync(process.env.PONYOU_TRADE_ATTRIBUTION_FILE, "utf8") : '{"trades":[]}');
    attrib.trades.push({ ts: closedAt, mint, pnl_pct: pnl });
    fs.writeFileSync(process.env.PONYOU_TRADE_ATTRIBUTION_FILE, JSON.stringify(attrib));
  }

  it("loadClosedPositions joins actual PnL from attribution", () => {
    seedPosition({ pnl: -16.1 });
    const [p] = loadClosedPositions();
    expect(p.actual_pnl_pct).toBe(-16.1);
    expect(p.entry_price).toBe(1.0);
  });

  it("captureCandles persists per-position paths and records failures honestly", async () => {
    seedPosition();
    const fetcher = async () => ({ candles: [bar(Date.parse("2026-06-11T18:30:00Z") / 1000, 1, 1.1, 0.9, 1.05)] });
    const out = await captureCandles({ fetcher });
    expect(out.captured).toBe(1);
    const failer = async () => ({ candles: [], error: "pool gone" });
    seedPosition({ key: "MintB::w" });
    const out2 = await captureCandles({ fetcher: failer });
    expect(out2.failed).toBe(1);
    expect(out2.skipped).toBe(1); // MintA already archived, not refetched
  });

  it("runExitScenarios records paired baseline(actual)+candidate runs into cf-exit experiments, idempotently", async () => {
    seedPosition({ pnl: -16 });
    await captureCandles({ fetcher: async () => ({ candles: [
      bar(Date.parse("2026-06-11T18:30:00Z") / 1000, 1.0, 1.02, 0.95, 0.96),
      bar(Date.parse("2026-06-11T18:35:00Z") / 1000, 0.96, 0.97, 0.85, 0.9),
    ] }) });

    const out = runExitScenarios({ policies: ["cf-exit:sl-8"] });
    const res = out.results[0];
    expect(res.recorded).toBe(true);
    expect(res.baseline_avg_pnl).toBe(-16);  // outcome aktual
    expect(res.candidate_avg_pnl).toBe(-8);  // SL -8 memotong lebih awal
    expect(res.delta_pnl).toBe(8);

    const exp = listExperiments({ limit: 200 }).find((e) => e.name === "cf-exit:sl-8");
    expect(exp.tags).toContain("counterfactual");
    const { runs } = getExperimentSummary({ id: exp.id });
    expect(runs.filter((r) => r.context?.cf_exit)).toHaveLength(2);

    // rerun without new closes records nothing
    const again = runExitScenarios({ policies: ["cf-exit:sl-8"] });
    expect(again.results[0].recorded).toBe(false);
    expect(getExperimentSummary({ id: exp.id }).runs).toHaveLength(2);
  });

  it("every registered policy has a rule string and replayable shape", () => {
    for (const [name, p] of Object.entries(EXIT_POLICIES)) {
      expect(p.rule, name).toBeTruthy();
      const r = replayExitPolicy(p, { entryPrice: 1, entryTs: 0, candles: [bar(60, 1, 1.01, 0.99, 1.0)] });
      expect(r.exit_reason, name).toBe("horizon_timeout");
    }
  });
});
