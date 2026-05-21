# PR Queue

<!--
HOW TO USE
==========
Add tasks here manually or via:  ./addtask.sh <description>
Work tasks via:                  /autowork   (or run-autowork.sh)
Plan after limit:                /limitplan

STATUS VALUES
  pending         → not started
  in_progress     → being worked on now
  paused_by_limit → stopped due to token/usage limit
  ready_for_review→ done, needs human review
  done            → confirmed complete by human
-->

---

## PR-007: Transaksi Murah — Direct RPC Trading engine (Rust + TypeScript)
Status: done
Priority: medium
Safety: needs_review
Goal: Rust CLI service + TypeScript integration layer for direct Solana RPC trading. Reduces platform fees by bypassing aggregator middleware. Features: simulation-first (blocks execute if sim fails), dynamic priority fee (auto/low/medium/high), RPC failover (primary + 2 backups), risk guard (max 0.25 SOL/trade, reserve 0.05 SOL for fees, slippage cap 300bps). 1 SOL balance gate. DRY_RUN=true default, LIVE_TRADING=false default.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] Rust engine: balance, simulate, execute, health commands with JSON output    (worker: codex)
- [x] TypeScript: rpcFailover.ts with latency-based endpoint switching             (worker: codex)
- [x] TypeScript: priorityFeeManager.ts (auto/low/medium/high modes)               (worker: codex)
- [x] TypeScript: directRpcTrading.ts with simulation-first gate                   (worker: codex)
- [x] TypeScript: skill_registry.ts + risk_guard.ts + 1 SOL balance gate          (worker: codex)
- [x] Write unit tests: balance gate, sim-blocks-execute, RPC failover, DRY_RUN   (worker: codex)
- [x] Review & finalize                                                            (worker: claude)
Added: 2026-05-21

---

<!--
TEMPLATE — copy and fill in for new PRs
========================================

## PR-XXX: <short title>
Status: pending
Priority: <high | medium | low>
Safety: <safe | needs_review>
Goal: <one-line description of what this PR achieves>
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] <task 1>           (worker: gemini)
- [ ] <task 2>           (worker: codex)
- [ ] Write tests        (worker: codex)
- [ ] Review & finalize  (worker: claude)
Added: <YYYY-MM-DD>

Worker options: gemini | codex | claude
Default flow: gemini (research) → codex (build + tests) → claude (review)

-->

## Codex Co-Leader Notes
- 2026-05-21: Codex co-leader loop enabled via ops/codex-coleader-loop.sh. Claude remains final review/decision gate; Codex handles build/test tasks.
