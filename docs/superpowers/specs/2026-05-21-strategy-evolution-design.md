# Strategy Evolution System — Design Spec
Date: 2026-05-21
Status: approved

## Overview

Ponyou autonomous strategy evolution engine. Ponyou dapat memilih, mengkomposisi,
dan menghasilkan strategi baru — tetapi hanya jika ada bukti fundamental (backtest,
paper trade, live history) dengan win rate ≥ 80%. Setiap perubahan strategi wajib
diajukan sebagai proposal Telegram sebelum aktif.

Kelly capital sizing juga punya tiga mode progresif yang terkunci secara bertahap
berdasarkan pengalaman dan win rate nyata Ponyou.

---

## Architecture

```
Market signals / Conviction Memory
         │
         ▼
  [strategy-composer.js]          ← select / compose / generate candidates
         │
         ▼  (emits "candidate" event)
  [strategy-evolution-bus.js]     ← async event bus, queue max 5
         │
         ▼
  [strategy-evolution-engine.js]  ← orchestrator
         │
         ▼
  [strategy-gate.js]              ← triple evidence gate
    Layer 1: Backtest ≥ 80% (min 100 simulated trades)
    Layer 2: Paper trade ≥ 80% (min 30 dry-run signals)
    Layer 3: Live history ≥ 80% (min 20 live trades)
         │
    ALL pass → strategy-proposal
    ANY fail → reject + log reason + evidence
         │
         ▼
  [strategy-proposal.js]          ← format + send Telegram
    auto-approve: conviction ≥ 95% AND all gates ≥ 90%
    else: wait operator /approve or /reject (timeout 24h → auto-reject)
         │
         ▼
  [strategy-registry.js]          ← activate, persist, catalog
         │
         ▼
  [kelly-mode-selector.js]        ← unlock Mode 2 / Mode 3 based on evidence
```

---

## Components

### strategy-registry.js
- Catalog: `Map<id, StrategyRecord>`
- `StrategyRecord`: `{ id, name, type, status, source, rules, scores, activatedAt, deactivatedAt }`
- `status`: `"candidate" | "backtesting" | "paper" | "live_trial" | "active" | "rejected" | "superseded"`
- Persists to `strategy-registry.json`
- Methods: `register()`, `activate()`, `reject()`, `deactivate()`, `getBestActive(regime)`, `getAll()`

### strategy-gate.js
Triple evidence gate. All three layers required.

**Layer 1 — Backtest**
- Run `backtest-cli.js` on historical data
- Min 100 simulated trades
- Required: win rate ≥ 80%, profit factor > 1.0
- Fail: reject with backtest output attached

**Layer 2 — Paper Trade**
- Enable `DRY_RUN=true`, track candidate strategy signals
- Min 30 paper signals
- Required: simulated win rate ≥ 80%
- Duration: up to 7 days live paper before timeout

**Layer 3 — Live Trade History**
- Read from `trade-attribution.json` + `conviction-memory.js`
- Min 20 live trades attributed to strategy
- Required: live win rate ≥ 80%
- Fail: strategy stays in `live_trial` until threshold met or timeout

Gate output: `{ passed: bool, layer: 1|2|3, winRate, trades, evidence, rejectReason }`

### strategy-composer.js
Three creation modes — all output `StrategyCandidate` (never directly activate):

**selectBest(regime)**
- Read `strategy-registry.js` → filter `active` strategies
- Score by regime-specific win rate (from trade-attribution)
- Return top-1 candidate for regime

**compose(stratA, stratB)**
- Merge signal rules: union of entry conditions
- Thresholds: take more conservative of the two
- Name: `${stratA.id}+${stratB.id}-hybrid`
- Output: StrategyCandidate

**generate(context)**
- Send context (regime, recent trade patterns, conviction memory) to LLM
- Parse response into rule object (strict schema validation)
- If schema invalid → reject, do not emit candidate
- Output: StrategyCandidate

### strategy-evolution-bus.js
- Node.js `EventEmitter`-based, in-process async queue
- Events: `"candidate"`, `"gate_result"`, `"proposal_sent"`, `"proposal_approved"`, `"proposal_rejected"`, `"strategy_activated"`, `"strategy_degraded"`
- Queue: FIFO, process one candidate at a time (no parallel gate runs)
- Backpressure: queue > 5 → drop oldest + log warning

### strategy-evolution-engine.js
Orchestrator. Subscribes to bus.

- `on("candidate")`: route to strategy-gate → on pass → strategy-proposal
- `on("proposal_approved")`: activate in registry → recalculate kelly mode
- `on("proposal_rejected")`: set status = "rejected", log reason
- Hourly cron check: for each `active` strategy, verify live win rate still ≥ 75%
  - Drop below 75%: emit `"strategy_degraded"` → propose revision or auto-revert to previous active
- Handles strategy version history: keep last 3 versions per strategy slot

### strategy-proposal.js
Telegram notification + approval gate.

**Message format:**
```
[PROPOSAL] Strategy Update
Name: {name}
Type: {select|compose|generate}
Win Rate: {pct}% over {N} trades
Evidence:
  - Backtest: {pct}% ({N} sims)
  - Paper: {pct}% ({N} signals)
  - Live: {pct}% ({N} trades)
Reason: {text}
Regime: {regime}
Reply /approve_{id} or /reject_{id}
```

**Auto-approve condition:** conviction ≥ 95% AND all gates ≥ 90% → activate immediately, still send notification (not proposal).

**Timeout:** 24 hours no response → auto-reject, log, do not activate.

---

## Kelly Mode Selector

### kelly-mode-selector.js

Three progressive modes. Unlock requires evidence — cannot be forced manually.

**Mode 1 — CONSERVATIVE (default, always available)**
```
effectiveBankroll = bankrollSol / maxPositions
Trigger: win rate history < 80% OR live trades < 20
```

**Mode 2 — ADAPTIVE (auto-unlocks)**
```
effectiveBankroll = bankrollSol - currentlyDeployedSol
Unlock requires:
  - live win rate 80-90%
  - live trades ≥ 20
  - conviction ≥ 70%
```

**Mode 3 — FULL KELLY (operator approval required)**
```
effectiveBankroll = bankrollSol  (no division, no deduction)
Unlock requires ALL of:
  - live win rate sustained ≥ 100% over last 50 trades
  - live trades ≥ 50
  - conviction ≥ 99%
  - fundamental data strength: STRONG (regime memory populated, semantic memory ≥ 200 entries)
  - Telegram proposal sent AND operator approved
  - approval can be revoked at any time → immediate fallback to Mode 2
Feature gate: if not approved, Mode 3 is permanently locked until new proposal submitted
```

**capital-sizing.js patch:**
Before calling `computeFractionalKellySize()`, call `selectKellyMode()` to get `effectiveBankroll`.
Inject `bankrollSol: effectiveBankroll` into Kelly computation.

---

## Config additions (config.js)

```js
strategy: {
  evolution: {
    enabled: false,                  // master switch
    minWinRateGate: 0.80,            // gate threshold for all layers
    minBacktestTrades: 100,
    minPaperTrades: 30,
    minLiveTrades: 20,
    paperTradeTimeoutDays: 7,
    proposalTimeoutHours: 24,
    autoApproveConvictionMin: 0.95,
    degradationThreshold: 0.75,      // auto-revert if active strategy drops below this
    maxCandidateQueue: 5,
    kellyMode3: {
      requiresApproval: true,
      minLiveTrades: 50,
      minWinRate: 1.00,
      minConviction: 0.99,
      minSemanticMemoryEntries: 200,
    }
  }
}
```

---

## Files

| File | Action |
|------|--------|
| `strategy-registry.js` | new |
| `strategy-gate.js` | new |
| `strategy-composer.js` | new |
| `strategy-evolution-bus.js` | new |
| `strategy-evolution-engine.js` | new |
| `strategy-proposal.js` | new |
| `kelly-mode-selector.js` | new |
| `capital-sizing.js` | modify — inject kelly mode selector |
| `config.js` | modify — add `strategy.evolution` block |
| `tests/strategy-registry.test.js` | new |
| `tests/strategy-gate.test.js` | new |
| `tests/strategy-composer.test.js` | new |
| `tests/strategy-evolution-bus.test.js` | new |
| `tests/strategy-evolution-engine.test.js` | new |
| `tests/strategy-proposal.test.js` | new |
| `tests/kelly-mode-selector.test.js` | new |

---

## Non-Negotiable Safety Rules

1. Strategy-gate must pass ALL 3 layers. No shortcuts, no bypass flags.
2. Mode 3 Kelly cannot activate without operator Telegram approval on record.
3. Every strategy change logged to `strategy-registry.json` with evidence snapshot.
4. Degraded strategy (live win < 75%) triggers immediate auto-revert.
5. Candidate queue > 5: drop oldest, never block main trading loop.
6. LLM-generated strategy rules must pass strict schema validation before entering gate.
7. `strategy.evolution.enabled: false` by default. Operator must opt in.
