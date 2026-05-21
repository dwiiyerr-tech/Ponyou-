# PR Progress

<!--
This file is auto-updated by /autowork after every run.
Do not edit the "## AutoWork Progress" block manually — it will be overwritten.
You can add notes below the divider line.
-->

---

## AutoWork Progress

Updated: 2026-05-22T17:45:00Z

Current PR: PR-011
Current status: ready_for_review

### Agents used
- Gemini: research + risk analysis
- Claude: orchestration + build + review

### Completed work
- tools/rpcFailover.js — RPC failover with latency sorting, circuit breaker, health loop
- tools/priorityFeeManager.js — dynamic priority fees (p25/p50/p75/p90 percentiles, RPC fallbacks)
- tools/risk_guard.js — pure pre-trade risk validator (balance gate, trade size cap, slippage cap)
- tools/directRpcTrading.js — simulation-first orchestrator, DRY_RUN=true default, LIVE_TRADING=false gate
- tools/skill_registry.js — central registry of PR-007 tools
- tests/risk-guard.test.js — 9 tests (balance gate, trade size, fee reserve, slippage)
- tests/rpc-failover.test.js — 5 tests (latency sort, failover on ECONNREFUSED, circuit breaker)
- tests/priority-fee-manager.test.js — 8 tests (all modes, congestion detection, fallbacks)
- tests/direct-rpc-trading.test.js — 11 tests (dry run, live gate, sim failure, rust_cli_not_built)

### Remaining work
- Rust CLI (direct-rpc-engine) not built — requires Rust toolchain. directRpcTrading.js returns { reason: 'rust_cli_not_built' } gracefully when binary missing. Build separately if Rust is available.

### Changed files
- tools/rpcFailover.js (new)
- tools/priorityFeeManager.js (new)
- tools/risk_guard.js (new)
- tools/directRpcTrading.js (new)
- tools/skill_registry.js (new)
- tests/risk-guard.test.js (new)
- tests/rpc-failover.test.js (new)
- tests/priority-fee-manager.test.js (new)
- tests/direct-rpc-trading.test.js (new)
- PR_QUEUE.md (status + checkboxes updated)
- PR_PROGRESS.md (this file)

### Tests run
- npx vitest run tests/risk-guard.test.js tests/rpc-failover.test.js tests/priority-fee-manager.test.js tests/direct-rpc-trading.test.js
- Result: PASS 33/33, FAIL 0

### Limit status
clear

### Resume command
claude -c -p "/autowork resume from PR_PROGRESS.md and PR_QUEUE.md"

### Human approval needed
no

### Next action
Human review of PR-007 modules. To enable live trading after review: set liveTradingEnabled=true + dryRun=false in DirectRpcTrading constructor AND build Rust CLI separately.

---

<!--
HISTORY
=======
Entries above are overwritten each run.
Add permanent notes below this line.
-->

## Notes
- 2026-05-21 20:00 +08: Codex co-leader handled PR-011 first Codex task only. Added normalized vault sweep config support (`vault.sweep.enabled`, `vault.sweep.sweepPct`, `vault.sweep.sweepIntervalDays`, `vault.sweep.minSweepSol`, `vault.sweep.vaultWallet`) while preserving legacy flat `vaultPct`, `vaultIntervalDays`, and `vaultWallet`. Added `vault-profit-sweep.js` as an analysis-only sweep helper entrypoint; hardened `vault.js` sweep calculations and transfer gates for disabled/minimum-sweep cases; expanded `tests/vault-profit-sweep.test.js` to 9 cases. Verification passed: `node --check config.js vault.js vault-profit-sweep.js tests/vault-profit-sweep.test.js`; `npx vitest run tests/vault-profit-sweep.test.js` -> 9/9; `npx vitest run tests/module-graph.test.js` -> 1/1. PR_QUEUE updated to mark only the first PR-011 Codex task complete and set PR-011 `in_progress`; remaining PR-011 trigger/Telegram/trading-plan/config tasks left unchecked. Submitted Codex result to orchestration task 1, then submitted a corrected testing artifact with failures=0.
- 2026-05-21 19:29 +08: Codex co-leader handled PR-009 import/export task only. Added `tests/module-graph.test.js`, a static ESM module graph regression test that scans repo JS/MJS/CJS files without importing runtime entrypoints and verifies relative imports resolve, named local imports/re-exports exist, and static local dependency cycles are absent. Current graph had 0 missing paths, 0 missing exports, and 0 cycles. Verification passed: `node --check tests/module-graph.test.js`; `npx vitest run tests/module-graph.test.js` -> 1/1. PR_QUEUE updated to check the import/export task; remaining PR-009 integration tasks left unchecked. No open Codex handoff/task id was present, so no collab submit was needed.
- 2026-05-21 19:20 +08: Codex co-leader handled PR-009 first Codex audit task only. Full suite verification passed with no failures: `npx vitest run` -> 86 test files passed, 565 tests passed, FAIL 0. PR_QUEUE updated to mark the full-suite capture task complete and PR-009 status `in_progress`; remaining PR-009 fix/integration tasks left unchecked. No open Codex handoff/task id was present, so no collab submit was needed.
- 2026-05-21 19:13 +08: Codex co-leader handled PR-008 `strategy-evolution-bus.js` task only. Reworked `StrategyEvolutionBus` to keep EventEmitter compatibility while enforcing async serial candidate dispatch, positive `maxQueue` validation, queue overflow warnings/events that drop the oldest queued candidate, `candidate_error` emission, and a `drain()` helper for deterministic tests. Expanded `tests/strategy-evolution-bus.test.js` to 5 focused cases covering subscriber delivery, backpressure, named events, async serialization, and listener errors. Verification passed: `node --check strategy-evolution-bus.js`; `node --check tests/strategy-evolution-bus.test.js`; `npx vitest run tests/strategy-evolution-bus.test.js` -> 5/5; `node --check strategy-registry.js && node --check strategy-gate.js && node --check strategy-composer.js && node --check strategy-evolution-engine.js`; `npx vitest run tests/strategy-registry.test.js tests/strategy-gate.test.js tests/strategy-composer.test.js tests/strategy-evolution-bus.test.js tests/strategy-evolution-engine.test.js` -> 31/31. PR_QUEUE checkbox for the strategy-evolution-bus task is checked; no open Codex handoff/task id was present.
- 2026-05-21 19:04 +08: Codex co-leader handled PR-008 task 3 only. Tightened `strategy-composer.js` candidate generation: composed candidates now preserve both parent signals, use id-based hybrid names, carry regime/parent metadata, and reject malformed parents. LLM-generated candidates now accept direct, nested, or JSON-string rule payloads, strip candidate metadata out of rules, tag regime, and reject invalid schema, invalid numeric risk thresholds, or BUY/SELL action payloads before gate entry. Expanded `tests/strategy-composer.test.js` to 10 focused cases. Verification passed: `node --check strategy-composer.js`; `node --check tests/strategy-composer.test.js`; `npx vitest run tests/strategy-composer.test.js` -> 10/10; `npx vitest run tests/strategy-registry.test.js tests/strategy-gate.test.js tests/strategy-composer.test.js` -> 21/21. PR_QUEUE checkbox updated for the strategy-composer task; remaining PR-008 Codex tasks left unchecked.
- 2026-05-21 18:56 +08: Codex co-leader handled PR-008 task 2 only. Added `strategy-gate.js` as an analysis-only triple evidence gate with injectable readers, candidate evidence defaults, local backtest support, and local trade-attribution live evidence lookup. Added focused `tests/strategy-gate.test.js` coverage for pass/fail layers, backtest profit factor, short-circuiting, attribution-file live evidence, and snapshot evidence. Verification passed: `node --check strategy-gate.js`; `node --check tests/strategy-gate.test.js`; `npx vitest run tests/strategy-gate.test.js tests/strategy-registry.test.js` -> 14/14. PR_QUEUE checkbox updated for the strategy-gate task; remaining PR-008 Codex tasks left unchecked.
- 2026-05-21 18:47 +08: Codex co-leader handled PR-008 task 1 only. Added `strategy-registry.js` with candidate catalog, activation/rejection/deactivation transitions, JSON persistence, best-active lookup, and cloned read APIs. Added focused `tests/strategy-registry.test.js` coverage. Verification passed: `node --check strategy-registry.js`; `npx vitest run tests/strategy-registry.test.js` -> 7/7. PR_QUEUE checkbox updated for the strategy-registry task; remaining PR-008 Codex tasks left unchecked.
- 2026-05-21 18:39 +08: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 is already done in PR_QUEUE; Claude decide/review gate remains open in collab task 1. Fresh verification passed: PR-007 tool module syntax checks and focused Vitest suite 33/33. Submitted corrected Codex result to task 1 with failures=0; no PR_QUEUE checkbox/status changes were needed. This supersedes one immediately prior submit that encoded "0" as a failure list item.
- 2026-05-21 18:32 +08: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 is already done in PR_QUEUE; Claude decide/review gate remains open in collab task 1. Fresh verification passed: PR-007 tool module syntax checks and focused Vitest suite 33/33. Submitted corrected Codex result to task 1 with failures=0; no PR_QUEUE checkbox/status changes were needed.
- 2026-05-21 18:25 +08: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 is already done in PR_QUEUE; Claude decide/review gate remains open in collab task 1. Fresh verification passed: PR-007 tool module syntax checks and focused Vitest suite 33/33. No PR_QUEUE checkbox/status changes were needed.
- 2026-05-21 18:19 +08: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 is already done in PR_QUEUE; Claude decide/review gate remains open in collab task 1. Fresh verification passed: PR-007 tool module syntax checks and focused Vitest suite 33/33. Submitted corrected Codex result to task 1 with failures=0; no PR_QUEUE status changes were needed.
- 2026-05-21 18:12 +08: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 is already marked done in PR_QUEUE; no PR_QUEUE checkbox/status changes were needed. Fresh verification passed: `node --check` for PR-007 tool modules and focused Vitest suite 33/33. Submitted corrected Codex result to orchestration task 1 with failures=0.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Fresh verification: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. No PR_QUEUE checkbox/status changes were needed.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. Submitted corrected Codex result to orchestration task 1 with failures=0; no code or PR_QUEUE status changes were needed.
- 2026-05-21: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review in Claude-owned decide stage. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. No PR_QUEUE checkbox/status changes were needed.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. Submitted corrected task 1 result with failures=0; no PR_QUEUE status changes were needed.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. Submitted corrected Codex result to orchestration task 1 with failures=0; no code changes or PR_QUEUE status changes were needed.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed, focused Vitest checks passed 33/33. Submitted corrected Codex result to orchestration task 1 with failures=0; no code changes were made.
- 2026-05-21: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed, focused Vitest checks passed 33/33. Submitted corrected Codex result to orchestration task 1 with failures=0.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review. Fresh verification: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. No PR_QUEUE checkbox/status changes were needed.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. Submitted task 1 result to orchestration with a corrected failures=0 testing artifact; no PR_QUEUE status changes were needed.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. Submitted corrected Codex result to orchestration task 1 with failures=0; no code changes or PR_QUEUE status changes were needed.
- 2026-05-21: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has all Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed and focused Vitest checks passed 33/33. Submitted Codex result to orchestration task 1 with failures=0.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; PR_QUEUE already has Codex tasks checked. Verification rerun: PR-007 tool module syntax checks passed, focused Vitest checks passed 33/33. Submitted Codex result to orchestration task 1.
- 2026-05-21: Codex co-leader run found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; syntax checks passed for PR-007 tool modules and focused Vitest checks passed 33/33. No PR_QUEUE checkbox/status changes were needed.
- 2026-05-21: PR-001 through PR-006 removed from the active queue per human request. PR-007 is the latest active PR and remains blocked until separately approved.
- daily-trade-guard.js uses file-based state (daily-trade-guard-state.json) — auto-reset on UTC date change
- Guard is disabled by default (dailyTradeGuard.enabled: false in config) — enable via user-config.json
- /stoptrade activates learning mode for learningModeDurationMin minutes
- 2026-05-21: Codex co-leader check found no open Codex handoffs. Next queue item is PR-007, but implementation is blocked by the explicit human approval gate recorded above for direct RPC trading/live execution paths. No PR_QUEUE checkboxes changed.
- 2026-05-21: Codex co-leader pass found no open Codex handoffs. PR-007 remains the first unchecked Codex PR, but build remains blocked by the explicit human approval gate for direct RPC trading/live execution paths. No code or PR_QUEUE checkbox changes made.
- 2026-05-21: Codex co-leader run found no open Codex handoffs. Selection reached PR-007, but the recorded human approval gate still blocks implementation of direct RPC trading paths. No PR_QUEUE checkbox/status changes and no code changes.
- 2026-05-21: Codex co-leader run found no open Codex handoffs. PR-007 remains the first unchecked Codex PR, but build is still blocked by the explicit human approval gate for direct RPC trading/live execution paths. No PR_QUEUE checkbox/status changes and no code changes.
- 2026-05-21: Codex co-leader run found no open Codex handoffs. PR-007 remains blocked by the explicit human approval gate for direct RPC trading/live execution paths. No PR_QUEUE checkbox/status changes and no code changes.
- 2026-05-21: Codex co-leader run found no open Codex handoffs. Selection reached PR-007 again; explicit human approval is still required before building direct RPC trading/live execution code. No PR_QUEUE checkbox/status changes and no code changes.
- 2026-05-21: Codex co-leader run found no open Codex handoffs. Selection reached PR-007; build remains blocked by the existing explicit human approval gate for direct RPC trading/live execution paths. No PR_QUEUE checkbox/status changes and no code changes.
- 2026-05-21: Codex co-leader run found no open Codex handoffs and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review in Claude-owned decide; no PR_QUEUE checkbox/status changes and no code changes.
- 2026-05-21: Codex co-leader pass found no open Codex handoff and no pending/in_progress PR with unchecked Codex tasks. PR-007 remains ready_for_review for Claude decide/review; focused checks passed (`node --check` for PR-007 tool modules, `npx vitest run tests/risk-guard.test.js tests/rpc-failover.test.js tests/priority-fee-manager.test.js tests/direct-rpc-trading.test.js` -> 33/33).

## New task added: PR-011
Status: pending
Goal: Vault profit sweep (configurable % + interval + wallet + toggle) + Trading Plan 30 (N-trade target mode, on/off, auto-stop)
Added: 2026-05-21

## New task added: PR-010
Status: pending
Goal: Gap-filling specialist agent — detects uncovered features/stuck tasks, decomposes large tasks, routes to right sub-agent
Added: 2026-05-21

## New task added: PR-009
Status: pending
Goal: Full integration audit — run all tests, fix all errors/bugs, ensure all features (orchestration, strategy, skills, security, Kelly, RPC, MCP) connected end-to-end
Added: 2026-05-21

## New task added: PR-008
Status: pending
Goal: Autonomous strategy evolution engine — triple evidence gate (backtest→paper→live ≥80%), Telegram proposal, Kelly Mode 1/2/3 progressive unlock
Added: 2026-05-21

## New tasks added: 2026-05-21

| PR | Title | Priority | Safety |
|----|-------|----------|--------|
| PR-007 | Transaksi Murah / Direct RPC (Rust) | medium | needs_review |

Latest active PR: PR-007. Agent flow: Gemini (research) -> Codex (build+tests) -> Claude (review).
PR-001 through PR-006 were removed from the active queue on 2026-05-21. PR-007 still requires explicit human review before go-live because it introduces direct RPC trading/live execution paths.
