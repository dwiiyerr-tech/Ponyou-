# Strategy Evolution System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Ponyou's autonomous strategy evolution engine — select, compose, and generate new strategies with triple evidence gate (backtest → paper → live, all ≥ 80% win rate), Telegram proposal system, and progressive Kelly Mode 1/2/3 unlock.

**Architecture:** Event-driven (B+C hybrid) — strategy-composer emits candidates to an in-process EventEmitter bus; strategy-evolution-engine orchestrates gate → proposal → registry. Kelly mode selector wraps capital-sizing.js to inject per-mode effective bankroll.

**Tech Stack:** Node.js ESM, vitest, EventEmitter, existing backtest.js, conviction-memory.js, trade-attribution.json, Telegram bot.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `strategy-registry.js` | create | Catalog + persist strategy records |
| `strategy-gate.js` | create | Triple evidence gate (backtest/paper/live) |
| `strategy-composer.js` | create | select / compose / generate candidates |
| `strategy-evolution-bus.js` | create | EventEmitter async queue, backpressure |
| `strategy-evolution-engine.js` | create | Orchestrator: bus → gate → proposal → registry |
| `strategy-proposal.js` | create | Format + send Telegram proposal |
| `kelly-mode-selector.js` | create | Mode 1/2/3 unlock + effectiveBankroll |
| `capital-sizing.js` | modify | Inject effectiveBankroll from kelly-mode-selector |
| `config.js` | modify | Add `strategy.evolution` config block |
| `tests/strategy-registry.test.js` | create | Unit tests for registry |
| `tests/strategy-gate.test.js` | create | Unit tests for gate layers |
| `tests/strategy-composer.test.js` | create | Unit tests for composer |
| `tests/strategy-evolution-bus.test.js` | create | Unit tests for bus + backpressure |
| `tests/strategy-evolution-engine.test.js` | create | Integration tests for engine |
| `tests/strategy-proposal.test.js` | create | Unit tests for proposal formatter |
| `tests/kelly-mode-selector.test.js` | create | Unit tests for mode unlock |

---

## Task 1: strategy-registry.js

**Files:**
- Create: `strategy-registry.js`
- Create: `tests/strategy-registry.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/strategy-registry.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { StrategyRegistry } from "../strategy-registry.js";

describe("StrategyRegistry", () => {
  let reg;
  beforeEach(() => { reg = new StrategyRegistry({ persistPath: null }); });

  it("registers a candidate and returns it by id", () => {
    const id = reg.register({ name: "test", type: "select", rules: { signal: "three_candle" } });
    const rec = reg.get(id);
    expect(rec.status).toBe("candidate");
    expect(rec.name).toBe("test");
  });

  it("activates a candidate", () => {
    const id = reg.register({ name: "a", type: "compose", rules: {} });
    reg.activate(id, { backtest: 0.85, paper: 0.82, live: 0.81 });
    expect(reg.get(id).status).toBe("active");
    expect(reg.get(id).scores.backtest).toBe(0.85);
  });

  it("rejects a candidate with reason", () => {
    const id = reg.register({ name: "b", type: "generate", rules: {} });
    reg.reject(id, "backtest win rate 0.65 < 0.80");
    expect(reg.get(id).status).toBe("rejected");
    expect(reg.get(id).rejectReason).toMatch("backtest");
  });

  it("deactivates an active strategy", () => {
    const id = reg.register({ name: "c", type: "select", rules: {} });
    reg.activate(id, {});
    reg.deactivate(id, "degraded below 75%");
    expect(reg.get(id).status).toBe("superseded");
  });

  it("getBestActive returns highest-scoring active strategy for regime", () => {
    const id1 = reg.register({ name: "x", type: "select", rules: {}, regime: "HOT" });
    const id2 = reg.register({ name: "y", type: "select", rules: {}, regime: "HOT" });
    reg.activate(id1, { live: 0.82 });
    reg.activate(id2, { live: 0.91 });
    const best = reg.getBestActive("HOT");
    expect(best.id).toBe(id2);
  });

  it("getAll returns all records", () => {
    reg.register({ name: "p", type: "select", rules: {} });
    reg.register({ name: "q", type: "select", rules: {} });
    expect(reg.getAll().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-registry.test.js
```
Expected: FAIL — `strategy-registry.js` not found.

- [ ] **Step 3: Implement strategy-registry.js**

```js
// strategy-registry.js
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";

export class StrategyRegistry {
  #catalog = new Map();
  #persistPath;

  constructor({ persistPath = "./strategy-registry.json" } = {}) {
    this.#persistPath = persistPath;
    if (persistPath) this.#load();
  }

  register({ name, type, rules, regime = null, source = "manual" }) {
    const id = randomUUID();
    this.#catalog.set(id, {
      id,
      name,
      type,
      status: "candidate",
      source,
      rules,
      regime,
      scores: {},
      rejectReason: null,
      activatedAt: null,
      deactivatedAt: null,
      createdAt: new Date().toISOString(),
    });
    this.#persist();
    return id;
  }

  get(id) { return this.#catalog.get(id) ?? null; }

  getAll() { return [...this.#catalog.values()]; }

  activate(id, scores = {}) {
    const rec = this.#mustGet(id);
    rec.status = "active";
    rec.scores = scores;
    rec.activatedAt = new Date().toISOString();
    this.#persist();
  }

  reject(id, reason) {
    const rec = this.#mustGet(id);
    rec.status = "rejected";
    rec.rejectReason = reason;
    this.#persist();
  }

  deactivate(id, reason) {
    const rec = this.#mustGet(id);
    rec.status = "superseded";
    rec.rejectReason = reason;
    rec.deactivatedAt = new Date().toISOString();
    this.#persist();
  }

  getBestActive(regime) {
    const actives = [...this.#catalog.values()].filter(
      r => r.status === "active" && (!regime || !r.regime || r.regime === regime)
    );
    if (!actives.length) return null;
    return actives.sort((a, b) => (b.scores.live ?? 0) - (a.scores.live ?? 0))[0];
  }

  #mustGet(id) {
    const rec = this.#catalog.get(id);
    if (!rec) throw new Error(`StrategyRegistry: unknown id ${id}`);
    return rec;
  }

  #persist() {
    if (!this.#persistPath) return;
    writeFileSync(this.#persistPath, JSON.stringify([...this.#catalog.values()], null, 2));
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.#persistPath, "utf8"));
      for (const r of raw) this.#catalog.set(r.id, r);
    } catch { /* file not exist yet */ }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/strategy-registry.test.js
```
Expected: PASS 6/6

- [ ] **Step 5: Commit**

```bash
git add strategy-registry.js tests/strategy-registry.test.js
git commit -m "feat(evolution): strategy-registry — catalog + persist"
```

---

## Task 2: kelly-mode-selector.js

**Files:**
- Create: `kelly-mode-selector.js`
- Create: `tests/kelly-mode-selector.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/kelly-mode-selector.test.js
import { describe, it, expect } from "vitest";
import { selectKellyMode, KELLY_MODES } from "../kelly-mode-selector.js";

describe("selectKellyMode", () => {
  it("returns Mode 1 when trades < 20", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 2, maxPositions: 3,
      winRate: 0.85, liveTrades: 10, conviction: 0.9, mode3Approved: false });
    expect(r.mode).toBe(KELLY_MODES.CONSERVATIVE);
    expect(r.effectiveBankroll).toBeCloseTo(10 / 3, 4);
  });

  it("returns Mode 1 when winRate < 0.80", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 2, maxPositions: 3,
      winRate: 0.70, liveTrades: 30, conviction: 0.9, mode3Approved: false });
    expect(r.mode).toBe(KELLY_MODES.CONSERVATIVE);
  });

  it("returns Mode 2 when winRate 80-90% and trades >= 20", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 2, maxPositions: 3,
      winRate: 0.85, liveTrades: 25, conviction: 0.75, mode3Approved: false });
    expect(r.mode).toBe(KELLY_MODES.ADAPTIVE);
    expect(r.effectiveBankroll).toBeCloseTo(10 - 2, 4);
  });

  it("returns Mode 2 even if conviction meets mode3 threshold when trades < 50", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 0, maxPositions: 3,
      winRate: 1.0, liveTrades: 30, conviction: 0.99, mode3Approved: true });
    expect(r.mode).toBe(KELLY_MODES.ADAPTIVE);
  });

  it("returns Mode 3 only when all unlock conditions met", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 3, maxPositions: 3,
      winRate: 1.0, liveTrades: 55, conviction: 0.99, mode3Approved: true,
      semanticMemoryEntries: 210 });
    expect(r.mode).toBe(KELLY_MODES.FULL_KELLY);
    expect(r.effectiveBankroll).toBe(10);
  });

  it("returns Mode 2 when mode3 not approved even if criteria met", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 1, maxPositions: 3,
      winRate: 1.0, liveTrades: 55, conviction: 0.99, mode3Approved: false,
      semanticMemoryEntries: 210 });
    expect(r.mode).toBe(KELLY_MODES.ADAPTIVE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/kelly-mode-selector.test.js
```
Expected: FAIL — `kelly-mode-selector.js` not found.

- [ ] **Step 3: Implement kelly-mode-selector.js**

```js
// kelly-mode-selector.js

export const KELLY_MODES = Object.freeze({
  CONSERVATIVE: "Mode1_Conservative",
  ADAPTIVE:     "Mode2_Adaptive",
  FULL_KELLY:   "Mode3_FullKelly",
});

const MODE3_MIN_LIVE_TRADES        = 50;
const MODE3_MIN_WIN_RATE           = 1.00;
const MODE3_MIN_CONVICTION         = 0.99;
const MODE3_MIN_SEMANTIC_ENTRIES   = 200;

const MODE2_MIN_LIVE_TRADES = 20;
const MODE2_MIN_WIN_RATE    = 0.80;
const MODE2_MIN_CONVICTION  = 0.70;

/**
 * @param {object} opts
 * @param {number} opts.bankrollSol          - Total wallet balance (SOL)
 * @param {number} opts.deployedSol          - Capital currently in open positions
 * @param {number} opts.maxPositions         - config.risk.maxPositions
 * @param {number} opts.winRate              - Recent live win rate (0-1)
 * @param {number} opts.liveTrades           - Count of live trades with attribution
 * @param {number} opts.conviction           - Conviction score (0-1)
 * @param {boolean} opts.mode3Approved       - Operator approved Mode 3 via Telegram
 * @param {number} [opts.semanticMemoryEntries=0]
 * @returns {{ mode: string, effectiveBankroll: number, reason: string }}
 */
export function selectKellyMode({
  bankrollSol,
  deployedSol = 0,
  maxPositions = 3,
  winRate = 0,
  liveTrades = 0,
  conviction = 0,
  mode3Approved = false,
  semanticMemoryEntries = 0,
}) {
  // Mode 3 — Full Kelly: all unlock criteria + operator approval required
  if (
    mode3Approved &&
    liveTrades >= MODE3_MIN_LIVE_TRADES &&
    winRate >= MODE3_MIN_WIN_RATE &&
    conviction >= MODE3_MIN_CONVICTION &&
    semanticMemoryEntries >= MODE3_MIN_SEMANTIC_ENTRIES
  ) {
    return {
      mode: KELLY_MODES.FULL_KELLY,
      effectiveBankroll: bankrollSol,
      reason: "Mode3: all unlock criteria met + operator approved",
    };
  }

  // Mode 2 — Adaptive: track deployed capital
  if (
    liveTrades >= MODE2_MIN_LIVE_TRADES &&
    winRate >= MODE2_MIN_WIN_RATE &&
    conviction >= MODE2_MIN_CONVICTION
  ) {
    return {
      mode: KELLY_MODES.ADAPTIVE,
      effectiveBankroll: Math.max(0, bankrollSol - deployedSol),
      reason: `Mode2: winRate=${winRate} trades=${liveTrades}`,
    };
  }

  // Mode 1 — Conservative: divide by slot count
  const slots = Math.max(1, maxPositions);
  return {
    mode: KELLY_MODES.CONSERVATIVE,
    effectiveBankroll: bankrollSol / slots,
    reason: `Mode1: winRate=${winRate} trades=${liveTrades} (below Mode2 threshold)`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/kelly-mode-selector.test.js
```
Expected: PASS 6/6

- [ ] **Step 5: Commit**

```bash
git add kelly-mode-selector.js tests/kelly-mode-selector.test.js
git commit -m "feat(evolution): kelly-mode-selector — Mode 1/2/3 progressive unlock"
```

---

## Task 3: Patch capital-sizing.js + config.js

**Files:**
- Modify: `capital-sizing.js` — inject `effectiveBankroll` from selector
- Modify: `config.js` — add `strategy.evolution` block

- [ ] **Step 1: Write failing test for Kelly mode injection**

```js
// tests/capital-sizing-kelly-mode.test.js
import { describe, it, expect } from "vitest";
import { computeCapitalSizing } from "../capital-sizing.js";

describe("capital-sizing Kelly mode injection", () => {
  const baseTrades = Array.from({ length: 6 }, (_, i) =>
    ({ pnl_pct: i % 2 === 0 ? 40 : -10 })
  );

  it("Mode 1 uses bankrollSol / maxPositions as effective bankroll", () => {
    const r = computeCapitalSizing({
      capitalUsd: 300, bankrollSol: 9,
      trades: baseTrades,
      kellyModeOpts: { winRate: 0.5, liveTrades: 5, conviction: 0.5,
        deployedSol: 0, maxPositions: 3, mode3Approved: false },
    });
    // effective bankroll = 9/3 = 3 SOL; deploy should be <= 3
    expect(r.should_skip).toBe(false);
    expect(r.deploy_amount_sol).toBeLessThanOrEqual(3);
  });

  it("Mode 2 uses bankrollSol - deployedSol as effective bankroll", () => {
    const r = computeCapitalSizing({
      capitalUsd: 300, bankrollSol: 9,
      trades: baseTrades,
      kellyModeOpts: { winRate: 0.85, liveTrades: 25, conviction: 0.75,
        deployedSol: 4, maxPositions: 3, mode3Approved: false },
    });
    // effective bankroll = 9 - 4 = 5 SOL
    expect(r.deploy_amount_sol).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/capital-sizing-kelly-mode.test.js
```
Expected: FAIL — `kellyModeOpts` not supported yet.

- [ ] **Step 3: Add `strategy.evolution` to config.js**

Find the line `rugMonitor: buildRugMonitorConfig(u),` (line ~368) and add before it:

```js
  strategy: {
    evolution: {
      enabled:                    u.strategyEvolutionEnabled    ?? false,
      minWinRateGate:             u.strategyMinWinRate          ?? 0.80,
      minBacktestTrades:          u.strategyMinBacktestTrades   ?? 100,
      minPaperTrades:             u.strategyMinPaperTrades      ?? 30,
      minLiveTrades:              u.strategyMinLiveTrades        ?? 20,
      paperTradeTimeoutDays:      u.strategyPaperTimeoutDays    ?? 7,
      proposalTimeoutHours:       u.strategyProposalTimeout     ?? 24,
      autoApproveConvictionMin:   u.strategyAutoApprove         ?? 0.95,
      degradationThreshold:       u.strategyDegradation         ?? 0.75,
      maxCandidateQueue:          u.strategyMaxQueue            ?? 5,
      kellyMode3: {
        requiresApproval:         true,
        minLiveTrades:            u.kellyMode3MinTrades         ?? 50,
        minWinRate:               u.kellyMode3MinWinRate        ?? 1.00,
        minConviction:            u.kellyMode3MinConviction     ?? 0.99,
        minSemanticMemoryEntries: u.kellyMode3MinMemory         ?? 200,
      },
    },
  },
```

- [ ] **Step 4: Patch capital-sizing.js**

At top of `capital-sizing.js`, add import:
```js
import { selectKellyMode } from "./kelly-mode-selector.js";
```

Find `export function computeCapitalSizing(` and add `kellyModeOpts` param. Before the `computeFractionalKellySize` call, add:

```js
  // Kelly mode: determine effective bankroll based on experience + conviction
  let effectiveBankroll = bankrollSol;
  if (kellyModeOpts) {
    const modeResult = selectKellyMode({
      bankrollSol,
      deployedSol:          kellyModeOpts.deployedSol          ?? 0,
      maxPositions:         kellyModeOpts.maxPositions          ?? config.risk.maxPositions ?? 3,
      winRate:              kellyModeOpts.winRate               ?? 0,
      liveTrades:           kellyModeOpts.liveTrades            ?? 0,
      conviction:           kellyModeOpts.conviction            ?? 0,
      mode3Approved:        kellyModeOpts.mode3Approved         ?? false,
      semanticMemoryEntries:kellyModeOpts.semanticMemoryEntries ?? 0,
    });
    effectiveBankroll = modeResult.effectiveBankroll;
  }
```

Then replace `bankrollSol` with `effectiveBankroll` inside `computeFractionalKellySize({ bankrollSol, ...` call.

- [ ] **Step 5: Run all Kelly tests**

```bash
npx vitest run tests/kelly.test.js tests/capital-sizing-kelly-mode.test.js tests/capital-sizing.test.js
```
Expected: all PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add capital-sizing.js config.js tests/capital-sizing-kelly-mode.test.js
git commit -m "feat(evolution): inject Kelly mode selector into capital-sizing + config block"
```

---

## Task 4: strategy-gate.js

**Files:**
- Create: `strategy-gate.js`
- Create: `tests/strategy-gate.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/strategy-gate.test.js
import { describe, it, expect, vi } from "vitest";
import { StrategyGate } from "../strategy-gate.js";

describe("StrategyGate", () => {
  const makeTrades = (winRate, n) =>
    Array.from({ length: n }, (_, i) => ({
      pnl_pct: i / n < winRate ? 30 : -15,
    }));

  it("passes all 3 layers when win rate >= 80% across all", async () => {
    const gate = new StrategyGate({
      minWinRate: 0.80,
      minBacktestTrades: 5,
      minPaperTrades: 5,
      minLiveTrades: 5,
      backtestRunner: async () => ({ winRate: 0.85, trades: 10, profitFactor: 1.5 }),
      paperTradeReader: async () => ({ winRate: 0.82, trades: 8 }),
      liveTradeReader: async () => ({ winRate: 0.88, trades: 7 }),
    });
    const result = await gate.evaluate("strat-id");
    expect(result.passed).toBe(true);
    expect(result.scores.backtest).toBe(0.85);
    expect(result.scores.paper).toBe(0.82);
    expect(result.scores.live).toBe(0.88);
  });

  it("fails at Layer 1 when backtest win rate < 80%", async () => {
    const gate = new StrategyGate({
      minWinRate: 0.80,
      minBacktestTrades: 5,
      minPaperTrades: 5,
      minLiveTrades: 5,
      backtestRunner: async () => ({ winRate: 0.65, trades: 10, profitFactor: 0.9 }),
      paperTradeReader: async () => ({ winRate: 0.90, trades: 8 }),
      liveTradeReader: async () => ({ winRate: 0.90, trades: 7 }),
    });
    const result = await gate.evaluate("strat-id");
    expect(result.passed).toBe(false);
    expect(result.failedLayer).toBe(1);
    expect(result.rejectReason).toMatch("backtest");
  });

  it("fails at Layer 2 when paper trade win rate < 80%", async () => {
    const gate = new StrategyGate({
      minWinRate: 0.80,
      minBacktestTrades: 5,
      minPaperTrades: 5,
      minLiveTrades: 5,
      backtestRunner: async () => ({ winRate: 0.90, trades: 10, profitFactor: 1.8 }),
      paperTradeReader: async () => ({ winRate: 0.60, trades: 8 }),
      liveTradeReader: async () => ({ winRate: 0.90, trades: 7 }),
    });
    const result = await gate.evaluate("strat-id");
    expect(result.passed).toBe(false);
    expect(result.failedLayer).toBe(2);
  });

  it("fails at Layer 3 when live trade count below minimum", async () => {
    const gate = new StrategyGate({
      minWinRate: 0.80,
      minBacktestTrades: 5,
      minPaperTrades: 5,
      minLiveTrades: 20,
      backtestRunner: async () => ({ winRate: 0.90, trades: 10, profitFactor: 2.0 }),
      paperTradeReader: async () => ({ winRate: 0.85, trades: 8 }),
      liveTradeReader: async () => ({ winRate: 0.90, trades: 5 }),  // only 5, need 20
    });
    const result = await gate.evaluate("strat-id");
    expect(result.passed).toBe(false);
    expect(result.failedLayer).toBe(3);
    expect(result.rejectReason).toMatch("live trades");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-gate.test.js
```
Expected: FAIL — `strategy-gate.js` not found.

- [ ] **Step 3: Implement strategy-gate.js**

```js
// strategy-gate.js

export class StrategyGate {
  #cfg;
  #backtestRunner;
  #paperTradeReader;
  #liveTradeReader;

  constructor({
    minWinRate = 0.80,
    minBacktestTrades = 100,
    minPaperTrades = 30,
    minLiveTrades = 20,
    backtestRunner,
    paperTradeReader,
    liveTradeReader,
  }) {
    this.#cfg = { minWinRate, minBacktestTrades, minPaperTrades, minLiveTrades };
    this.#backtestRunner = backtestRunner;
    this.#paperTradeReader = paperTradeReader;
    this.#liveTradeReader = liveTradeReader;
  }

  async evaluate(strategyId) {
    // Layer 1 — Backtest
    const bt = await this.#backtestRunner(strategyId);
    if (bt.winRate < this.#cfg.minWinRate || bt.trades < this.#cfg.minBacktestTrades || bt.profitFactor <= 1.0) {
      return this.#fail(1, `backtest win rate ${bt.winRate} < ${this.#cfg.minWinRate} or trades ${bt.trades} < ${this.#cfg.minBacktestTrades}`, { backtest: bt.winRate });
    }

    // Layer 2 — Paper trade
    const pt = await this.#paperTradeReader(strategyId);
    if (pt.winRate < this.#cfg.minWinRate || pt.trades < this.#cfg.minPaperTrades) {
      return this.#fail(2, `paper trade win rate ${pt.winRate} < ${this.#cfg.minWinRate} or trades ${pt.trades} < ${this.#cfg.minPaperTrades}`, { backtest: bt.winRate, paper: pt.winRate });
    }

    // Layer 3 — Live history
    const lt = await this.#liveTradeReader(strategyId);
    if (lt.winRate < this.#cfg.minWinRate || lt.trades < this.#cfg.minLiveTrades) {
      return this.#fail(3, `live trades ${lt.trades} < ${this.#cfg.minLiveTrades} or win rate ${lt.winRate} < ${this.#cfg.minWinRate}`, { backtest: bt.winRate, paper: pt.winRate, live: lt.winRate });
    }

    return {
      passed: true,
      failedLayer: null,
      rejectReason: null,
      scores: { backtest: bt.winRate, paper: pt.winRate, live: lt.winRate },
      evidence: { bt, pt, lt },
    };
  }

  #fail(layer, reason, scores = {}) {
    return { passed: false, failedLayer: layer, rejectReason: reason, scores, evidence: null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/strategy-gate.test.js
```
Expected: PASS 4/4

- [ ] **Step 5: Commit**

```bash
git add strategy-gate.js tests/strategy-gate.test.js
git commit -m "feat(evolution): strategy-gate — triple evidence gate (backtest/paper/live)"
```

---

## Task 5: strategy-proposal.js

**Files:**
- Create: `strategy-proposal.js`
- Create: `tests/strategy-proposal.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/strategy-proposal.test.js
import { describe, it, expect, vi } from "vitest";
import { StrategyProposal } from "../strategy-proposal.js";

describe("StrategyProposal", () => {
  it("formats proposal message with all evidence fields", () => {
    const proposal = new StrategyProposal({ sendTelegram: async () => {}, autoApproveConvictionMin: 0.95 });
    const msg = proposal.formatMessage({
      id: "abc-123",
      name: "three-candle+day-phase-hybrid",
      type: "compose",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: { bt: { trades: 120 }, pt: { trades: 35 }, lt: { trades: 22 } },
      regime: "HOT",
      reason: "Day phase + three candle synergy detected in HOT regime",
    });
    expect(msg).toMatch("[PROPOSAL]");
    expect(msg).toMatch("three-candle+day-phase-hybrid");
    expect(msg).toMatch("85%");
    expect(msg).toMatch("/approve_abc-123");
    expect(msg).toMatch("/reject_abc-123");
  });

  it("auto-approves when conviction >= threshold and all gates >= 90%", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({ sendTelegram, autoApproveConvictionMin: 0.95 });
    const result = await proposal.submit({
      id: "auto-001",
      name: "auto-strat",
      type: "select",
      conviction: 0.97,
      scores: { backtest: 0.92, paper: 0.91, live: 0.93 },
      evidence: {},
      regime: "HOT",
      reason: "high conviction, all gates ≥ 90%",
    });
    expect(result.autoApproved).toBe(true);
    expect(sendTelegram).toHaveBeenCalledWith(expect.stringMatching("auto-approved"));
  });

  it("does NOT auto-approve when conviction below threshold", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({ sendTelegram, autoApproveConvictionMin: 0.95, proposalTimeoutMs: 100 });
    const result = await proposal.submit({
      id: "manual-001",
      name: "manual-strat",
      type: "select",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: {},
      regime: "COLD",
      reason: "moderate conviction",
    });
    expect(result.autoApproved).toBe(false);
    expect(result.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-proposal.test.js
```
Expected: FAIL — `strategy-proposal.js` not found.

- [ ] **Step 3: Implement strategy-proposal.js**

```js
// strategy-proposal.js

export class StrategyProposal {
  #sendTelegram;
  #autoApproveConvictionMin;
  #proposalTimeoutMs;
  #pending = new Map(); // id → { resolve, reject, timer }

  constructor({
    sendTelegram,
    autoApproveConvictionMin = 0.95,
    proposalTimeoutMs = 24 * 60 * 60 * 1000,
  }) {
    this.#sendTelegram = sendTelegram;
    this.#autoApproveConvictionMin = autoApproveConvictionMin;
    this.#proposalTimeoutMs = proposalTimeoutMs;
  }

  formatMessage({ id, name, type, conviction, scores, evidence, regime, reason }) {
    const bt = scores.backtest ? `${(scores.backtest * 100).toFixed(0)}%` : "n/a";
    const pt = scores.paper   ? `${(scores.paper * 100).toFixed(0)}%`    : "n/a";
    const lt = scores.live    ? `${(scores.live * 100).toFixed(0)}%`     : "n/a";
    const btN = evidence?.bt?.trades ?? "?";
    const ptN = evidence?.pt?.trades ?? "?";
    const ltN = evidence?.lt?.trades ?? "?";
    return [
      `[PROPOSAL] Strategy Update`,
      `Name: ${name}`,
      `Type: ${type}`,
      `Conviction: ${(conviction * 100).toFixed(0)}%`,
      `Evidence:`,
      `  Backtest: ${bt} (${btN} sims)`,
      `  Paper:    ${pt} (${ptN} signals)`,
      `  Live:     ${lt} (${ltN} trades)`,
      `Regime: ${regime}`,
      `Reason: ${reason}`,
      ``,
      `Reply /approve_${id} or /reject_${id}`,
    ].join("\n");
  }

  async submit(candidate) {
    const { id, conviction, scores } = candidate;
    const allGatesAbove90 = [scores.backtest, scores.paper, scores.live].every(s => (s ?? 0) >= 0.90);

    if (conviction >= this.#autoApproveConvictionMin && allGatesAbove90) {
      const msg = `[AUTO-APPROVED] ${candidate.name} — conviction ${(conviction * 100).toFixed(0)}%, all gates ≥ 90%`;
      await this.#sendTelegram(msg).catch(() => {});
      return { id, autoApproved: true, status: "approved" };
    }

    const msg = this.formatMessage(candidate);
    await this.#sendTelegram(msg).catch(() => {});

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ id, autoApproved: false, status: "timeout_rejected" });
      }, this.#proposalTimeoutMs);
      this.#pending.set(id, { resolve, timer });
    });
  }

  // Called by Telegram bot command handler: /approve_<id> or /reject_<id>
  handleOperatorResponse(id, approved) {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    entry.resolve({ id, autoApproved: false, status: approved ? "approved" : "rejected" });
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/strategy-proposal.test.js
```
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git add strategy-proposal.js tests/strategy-proposal.test.js
git commit -m "feat(evolution): strategy-proposal — Telegram proposal + auto-approve gate"
```

---

## Task 6: strategy-evolution-bus.js

**Files:**
- Create: `strategy-evolution-bus.js`
- Create: `tests/strategy-evolution-bus.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/strategy-evolution-bus.test.js
import { describe, it, expect, vi } from "vitest";
import { StrategyEvolutionBus } from "../strategy-evolution-bus.js";

describe("StrategyEvolutionBus", () => {
  it("emits candidate event to subscriber", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5 });
    const received = [];
    bus.on("candidate", c => received.push(c));
    await bus.enqueue({ id: "x1", name: "test", type: "select", rules: {} });
    await new Promise(r => setTimeout(r, 10));
    expect(received.length).toBe(1);
    expect(received[0].id).toBe("x1");
  });

  it("drops oldest when queue exceeds maxQueue", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 2 });
    const warned = [];
    bus.on("queue_overflow", w => warned.push(w));
    await bus.enqueue({ id: "a" });
    await bus.enqueue({ id: "b" });
    await bus.enqueue({ id: "c" }); // this should trigger overflow
    expect(warned.length).toBeGreaterThan(0);
  });

  it("emits named events from bus.emit()", () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5 });
    const received = [];
    bus.on("strategy_activated", e => received.push(e));
    bus.emit("strategy_activated", { id: "y1" });
    expect(received[0].id).toBe("y1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-evolution-bus.test.js
```
Expected: FAIL — `strategy-evolution-bus.js` not found.

- [ ] **Step 3: Implement strategy-evolution-bus.js**

```js
// strategy-evolution-bus.js
import { EventEmitter } from "events";

export class StrategyEvolutionBus extends EventEmitter {
  #queue = [];
  #maxQueue;
  #processing = false;

  constructor({ maxQueue = 5 } = {}) {
    super();
    this.#maxQueue = maxQueue;
  }

  async enqueue(candidate) {
    if (this.#queue.length >= this.#maxQueue) {
      const dropped = this.#queue.shift();
      this.emit("queue_overflow", { dropped, queueSize: this.#queue.length });
    }
    this.#queue.push(candidate);
    if (!this.#processing) this.#processNext();
  }

  #processNext() {
    if (!this.#queue.length) { this.#processing = false; return; }
    this.#processing = true;
    const candidate = this.#queue.shift();
    // Emit async to avoid blocking enqueue caller
    setImmediate(() => {
      this.emit("candidate", candidate);
      this.#processNext();
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/strategy-evolution-bus.test.js
```
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git add strategy-evolution-bus.js tests/strategy-evolution-bus.test.js
git commit -m "feat(evolution): strategy-evolution-bus — async event queue with backpressure"
```

---

## Task 7: strategy-composer.js

**Files:**
- Create: `strategy-composer.js`
- Create: `tests/strategy-composer.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/strategy-composer.test.js
import { describe, it, expect, vi } from "vitest";
import { StrategyComposer } from "../strategy-composer.js";
import { StrategyRegistry } from "../strategy-registry.js";

describe("StrategyComposer", () => {
  it("selectBest returns active strategy for regime", () => {
    const reg = new StrategyRegistry({ persistPath: null });
    const id = reg.register({ name: "hot-strat", type: "select", rules: { signal: "three_candle" }, regime: "HOT" });
    reg.activate(id, { live: 0.88 });
    const composer = new StrategyComposer({ registry: reg });
    const best = composer.selectBest("HOT");
    expect(best?.name).toBe("hot-strat");
  });

  it("returns null when no active strategy for regime", () => {
    const reg = new StrategyRegistry({ persistPath: null });
    const composer = new StrategyComposer({ registry: reg });
    expect(composer.selectBest("DEAD")).toBeNull();
  });

  it("compose merges two strategies conservatively", () => {
    const composer = new StrategyComposer({ registry: new StrategyRegistry({ persistPath: null }) });
    const stratA = { id: "a1", name: "alpha", rules: { entryRsi: 30, tpPct: 50 } };
    const stratB = { id: "b1", name: "beta",  rules: { entryRsi: 40, tpPct: 40 } };
    const candidate = composer.compose(stratA, stratB);
    expect(candidate.type).toBe("compose");
    expect(candidate.name).toContain("hybrid");
    // conservative merge: take higher RSI threshold (more restrictive entry)
    expect(candidate.rules.entryRsi).toBe(40);
    // conservative: take lower TP
    expect(candidate.rules.tpPct).toBe(40);
  });

  it("generate validates LLM output schema and returns candidate", async () => {
    const mockLlm = vi.fn(async () => ({
      name: "llm-strat",
      signal: "breakout",
      entryRsi: 35,
      tpPct: 60,
      stopPct: 15,
    }));
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    const candidate = await composer.generate({ regime: "HOT", context: {} });
    expect(candidate.type).toBe("generate");
    expect(candidate.rules.signal).toBe("breakout");
  });

  it("generate returns null when LLM output fails schema validation", async () => {
    const mockLlm = vi.fn(async () => ({ invalid: true })); // missing required fields
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    const candidate = await composer.generate({ regime: "HOT", context: {} });
    expect(candidate).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-composer.test.js
```
Expected: FAIL — `strategy-composer.js` not found.

- [ ] **Step 3: Implement strategy-composer.js**

```js
// strategy-composer.js

const REQUIRED_RULE_FIELDS = ["signal"];

export class StrategyComposer {
  #registry;
  #llmGenerator;

  constructor({ registry, llmGenerator = null }) {
    this.#registry = registry;
    this.#llmGenerator = llmGenerator;
  }

  selectBest(regime) {
    return this.#registry.getBestActive(regime) ?? null;
  }

  compose(stratA, stratB) {
    const merged = {};
    const allKeys = new Set([...Object.keys(stratA.rules), ...Object.keys(stratB.rules)]);
    for (const key of allKeys) {
      const a = stratA.rules[key];
      const b = stratB.rules[key];
      if (a === undefined) { merged[key] = b; continue; }
      if (b === undefined) { merged[key] = a; continue; }
      // Conservative merge: for numeric thresholds, take stricter (higher entry filter, lower TP)
      if (key === "tpPct" || key === "takeProfitPct") { merged[key] = Math.min(a, b); continue; }
      if (typeof a === "number" && typeof b === "number") { merged[key] = Math.max(a, b); continue; }
      merged[key] = a; // default: take A
    }
    return {
      type: "compose",
      name: `${stratA.name}+${stratB.name}-hybrid`,
      rules: merged,
      source: `composed from ${stratA.id} + ${stratB.id}`,
    };
  }

  async generate(context) {
    if (!this.#llmGenerator) return null;
    try {
      const raw = await this.#llmGenerator(context);
      if (!this.#validateSchema(raw)) return null;
      return { type: "generate", name: raw.name ?? "llm-generated", rules: raw, source: "llm" };
    } catch {
      return null;
    }
  }

  #validateSchema(raw) {
    if (!raw || typeof raw !== "object") return false;
    return REQUIRED_RULE_FIELDS.every(f => f in raw);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/strategy-composer.test.js
```
Expected: PASS 5/5

- [ ] **Step 5: Commit**

```bash
git add strategy-composer.js tests/strategy-composer.test.js
git commit -m "feat(evolution): strategy-composer — select/compose/generate candidates"
```

---

## Task 8: strategy-evolution-engine.js

**Files:**
- Create: `strategy-evolution-engine.js`
- Create: `tests/strategy-evolution-engine.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/strategy-evolution-engine.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrategyEvolutionEngine } from "../strategy-evolution-engine.js";
import { StrategyEvolutionBus } from "../strategy-evolution-bus.js";
import { StrategyRegistry } from "../strategy-registry.js";

function makePassing(scores = { backtest: 0.90, paper: 0.88, live: 0.85 }) {
  return {
    evaluate: vi.fn(async () => ({ passed: true, failedLayer: null, rejectReason: null, scores, evidence: {} })),
  };
}

function makeProposal(approved = true) {
  return {
    submit: vi.fn(async () => ({ id: "any", autoApproved: true, status: "approved" })),
    handleOperatorResponse: vi.fn(),
  };
}

describe("StrategyEvolutionEngine", () => {
  it("activates strategy in registry after gate pass + proposal approve", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const gate = makePassing();
    const proposal = makeProposal(true);

    const engine = new StrategyEvolutionEngine({ bus, registry, gate, proposal });
    engine.start();

    await bus.enqueue({ id: "e1", name: "test-strat", type: "select", rules: { signal: "three_candle" }, conviction: 0.97 });
    await new Promise(r => setTimeout(r, 50));

    const activated = registry.getAll().find(r => r.status === "active");
    expect(activated).toBeDefined();
    expect(activated.name).toBe("test-strat");
  });

  it("rejects strategy in registry after gate fail", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const gate = { evaluate: vi.fn(async () => ({ passed: false, failedLayer: 1, rejectReason: "backtest 0.65 < 0.80", scores: {}, evidence: null })) };
    const proposal = makeProposal(true);

    const engine = new StrategyEvolutionEngine({ bus, registry, gate, proposal });
    engine.start();

    await bus.enqueue({ id: "e2", name: "fail-strat", type: "generate", rules: {}, conviction: 0.80 });
    await new Promise(r => setTimeout(r, 50));

    const rejected = registry.getAll().find(r => r.status === "rejected");
    expect(rejected).toBeDefined();
    expect(proposal.submit).not.toHaveBeenCalled();
  });

  it("reverts active strategy below degradation threshold", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "degrading", type: "select", rules: {} });
    registry.activate(id, { live: 0.85 });

    const gate = makePassing();
    const proposal = makeProposal(true);
    const engine = new StrategyEvolutionEngine({ bus, registry, gate, proposal, degradationThreshold: 0.75 });
    engine.start();

    // Simulate degradation check with current live rate below threshold
    const degraded = await engine.checkDegradation({ strategyId: id, currentLiveWinRate: 0.70 });
    expect(degraded).toBe(true);
    expect(registry.get(id).status).toBe("superseded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-evolution-engine.test.js
```
Expected: FAIL — `strategy-evolution-engine.js` not found.

- [ ] **Step 3: Implement strategy-evolution-engine.js**

```js
// strategy-evolution-engine.js

export class StrategyEvolutionEngine {
  #bus;
  #registry;
  #gate;
  #proposal;
  #degradationThreshold;
  #running = false;

  constructor({ bus, registry, gate, proposal, degradationThreshold = 0.75 }) {
    this.#bus = bus;
    this.#registry = registry;
    this.#gate = gate;
    this.#proposal = proposal;
    this.#degradationThreshold = degradationThreshold;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#bus.on("candidate", c => this.#handleCandidate(c));
  }

  stop() { this.#running = false; }

  async #handleCandidate(candidate) {
    // Register as candidate
    const id = this.#registry.register({
      name: candidate.name,
      type: candidate.type,
      rules: candidate.rules,
      regime: candidate.regime,
      source: candidate.source ?? "evolution",
    });

    // Run triple gate
    const gateResult = await this.#gate.evaluate(id);
    if (!gateResult.passed) {
      this.#registry.reject(id, gateResult.rejectReason);
      this.#bus.emit("gate_result", { id, passed: false, layer: gateResult.failedLayer });
      return;
    }

    this.#bus.emit("gate_result", { id, passed: true, scores: gateResult.scores });

    // Submit proposal
    const propResult = await this.#proposal.submit({
      ...candidate,
      id,
      scores: gateResult.scores,
      evidence: gateResult.evidence,
    });

    if (propResult.status === "approved") {
      this.#registry.activate(id, gateResult.scores);
      this.#bus.emit("strategy_activated", { id, name: candidate.name, scores: gateResult.scores });
    } else {
      this.#registry.reject(id, `proposal ${propResult.status}`);
      this.#bus.emit("proposal_rejected", { id, status: propResult.status });
    }
  }

  async checkDegradation({ strategyId, currentLiveWinRate }) {
    if (currentLiveWinRate < this.#degradationThreshold) {
      this.#registry.deactivate(strategyId, `degraded: live win rate ${currentLiveWinRate} < ${this.#degradationThreshold}`);
      this.#bus.emit("strategy_degraded", { id: strategyId, currentLiveWinRate });
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/strategy-evolution-engine.test.js
```
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git add strategy-evolution-engine.js tests/strategy-evolution-engine.test.js
git commit -m "feat(evolution): strategy-evolution-engine — orchestrator gate→proposal→registry"
```

---

## Task 9: Final integration + full suite

- [ ] **Step 1: Run complete test suite**

```bash
npx vitest run tests/strategy-registry.test.js tests/strategy-gate.test.js tests/strategy-composer.test.js tests/strategy-evolution-bus.test.js tests/strategy-evolution-engine.test.js tests/strategy-proposal.test.js tests/kelly-mode-selector.test.js tests/capital-sizing-kelly-mode.test.js tests/kelly.test.js tests/capital-sizing.test.js
```
Expected: all PASS, zero regressions.

- [ ] **Step 2: Update PR_QUEUE.md**

Add new PR entry:
```markdown
## PR-008: Strategy Evolution + Kelly Mode Selector
Status: done
Priority: high
Safety: needs_review
Goal: Autonomous strategy select/compose/generate with triple evidence gate (backtest→paper→live ≥80%), Telegram proposal, auto-approve at 95% conviction, and progressive Kelly Mode 1/2/3 unlock (Mode 3 requires operator approval + 100% win rate).
```

- [ ] **Step 3: Final commit**

```bash
git add PR_QUEUE.md PR_PROGRESS.md
git commit -m "feat(evolution): PR-008 complete — strategy evolution + Kelly mode selector

- strategy-registry.js: catalog + persist
- strategy-gate.js: triple evidence gate backtest/paper/live ≥80%
- strategy-composer.js: select/compose/generate candidates
- strategy-evolution-bus.js: EventEmitter async queue, backpressure
- strategy-evolution-engine.js: orchestrator gate→proposal→registry
- strategy-proposal.js: Telegram proposal + auto-approve at 95% conviction
- kelly-mode-selector.js: Mode1(bankroll/N) → Mode2(bankroll-deployed) → Mode3(full, approval required)
- capital-sizing.js: injected kelly mode selector
- config.js: strategy.evolution config block
- All tests: PASS"
```
