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

## PR-008: Strategy Evolution + Kelly Mode Selector
Status: ready_for_review
Priority: high
Safety: needs_review
Goal: Autonomous strategy select/compose/generate with triple evidence gate (backtest→paper→live ≥80% win rate), Telegram proposal system (auto-approve at 95% conviction, 24h timeout), and progressive Kelly Mode 1/2/3 unlock (Mode 3 requires operator Telegram approval + 100% win rate + 50 trades + 99% conviction).
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] strategy-registry.js — catalog + persist strategy records                                (worker: codex)
- [x] strategy-gate.js — triple evidence gate: backtest/paper/live all ≥80%                   (worker: codex)
- [x] strategy-composer.js — selectBest / compose / generate candidates                        (worker: codex)
- [x] strategy-evolution-bus.js — EventEmitter async queue with backpressure (max 5)           (worker: codex)
- [x] strategy-evolution-engine.js — orchestrator: bus→gate→proposal→registry + hourly check  (worker: codex)
- [x] strategy-proposal.js — Telegram proposal format + auto-approve + operator response       (worker: codex)
- [x] kelly-mode-selector.js — Mode1(bankroll/N) Mode2(bankroll-deployed) Mode3(full+approval) (worker: codex)
- [x] capital-sizing.js patch — inject effectiveBankroll from kelly-mode-selector              (worker: codex)
- [x] config.js patch — add strategy.evolution config block                                    (worker: codex)
- [x] Write unit tests: all 7 new modules + capital-sizing-kelly-mode integration              (worker: codex)
- [x] Review & finalize                                                                        (worker: claude)
Added: 2026-05-21
Spec: docs/superpowers/specs/2026-05-21-strategy-evolution-design.md
Plan: docs/superpowers/plans/2026-05-21-strategy-evolution.md

---

## PR-009: Full Integration Audit — Test All Features, Fix All Errors
Status: ready_for_review
Priority: high
Safety: safe
Goal: Jalankan seluruh test suite Ponyou, temukan semua error dan bug, pastikan semua fitur (orchestration layer, data pipeline, strategi, skill registry, security guards, capital sizing, Kelly, RPC, collaboration MCP) saling terhubung dan berjalan benar end-to-end.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] Jalankan full vitest suite — catat semua FAIL + error output                              (worker: codex)
- [x] Fix import/export errors antar modul (circular deps, missing exports)                     (worker: codex)
- [x] Fix integration: orchestration layer ↔ strategy registry ↔ evolution engine              (worker: claude)
- [x] Fix integration: capital-sizing ↔ kelly-mode-selector ↔ risk_guard                       (worker: claude)
- [x] Fix integration: conviction-memory ↔ trade-attribution ↔ strategy-gate                   (worker: claude)
- [x] Fix integration: collaboration MCP ↔ agent-router ↔ decision-workflow                    (worker: claude)
- [x] Fix integration: skill_registry ↔ directRpcTrading ↔ rpcFailover ↔ priorityFeeManager   (worker: claude) [DEFERRED — blocked by PR-007 Safety:needs_review gate]
- [x] Fix integration: dex-visibility + cabal-play + three-candle + day-phase ↔ strategy-composer (worker: claude)
- [x] Fix integration: wallet-ping-agent ↔ wallet-discovery ↔ smart-wallet-strategy            (worker: claude)
- [x] Verifikasi semua security guards terhubung ke agent main loop                            (worker: claude)
- [x] Re-run full suite — target 0 FAIL, 0 uncaught errors                                    (worker: claude)
- [x] Review & finalize                                                                        (worker: claude)
Added: 2026-05-21

---

## PR-010: Gap-Filling Specialist Agent
Status: pending
Priority: medium
Safety: safe
Goal: Buat agent khusus yang mendeteksi dan mengatasi gap ketika screener agent dan management agent tidak mampu memecahkan semua fitur atau task terlalu besar — agent ini bisa decompose task besar, routing ke sub-agent yang tepat, dan memastikan tidak ada fitur yang tertinggal tanpa handler.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Analisis gap pattern: task apa yang sering gagal / tidak tertangani oleh screener + management agent (worker: gemini)
- [ ] gap-detector.js — scan PR_QUEUE untuk task unchecked > N hari, modul tanpa test, fitur tanpa wiring ke agent loop (worker: codex)
- [ ] task-decomposer.js — terima task besar, pecah jadi atomic sub-tasks, route ke Gemini/Codex/Claude sesuai skill matrix (worker: codex)
- [ ] gap-agent.js — orchestrator: jalankan detector → decompose → dispatch → verify completion (worker: codex)
- [ ] Integrasi ke autowork loop: jika PR stuck > 24h tanpa progress, trigger gap-agent otomatis (worker: codex)
- [ ] Write tests untuk gap-detector dan task-decomposer (worker: codex)
- [ ] Review & finalize (worker: claude)
Added: 2026-05-21

---

## PR-011: Vault Profit Sweep + Trading Plan 30
Status: pending
Priority: high
Safety: needs_review
Goal: (1) Vault sweep: auto-kirim % profit harian/mingguan ke wallet vault yang bisa dikonfigurasi — threshold %, interval hari, on/off toggle, jumlah minimum sweep. (2) Trading Plan 30: mode trading dengan target 30 trades per sesi yang bisa di-setting, diaktifkan/dimatikan, dengan tracking progress dan auto-stop saat target tercapai.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] vault-profit-sweep.js revisi — tambah configurable: sweepPct, sweepIntervalDays, minSweepSol, vaultWallet, enabled toggle (worker: codex)
- [ ] Auto-sweep trigger: setelah setiap trade ditutup, cek apakah threshold harian/mingguan terpenuhi → kirim ke vault (worker: codex)
- [ ] Telegram notif saat sweep terjadi: jumlah SOL dikirim, wallet tujuan, sisa balance (worker: codex)
- [ ] trading-plan-30.js — mode trading dengan target N trades (default 30) per sesi, configurable, on/off toggle (worker: codex)
- [ ] Trading plan tracking: progress counter, auto-stop saat target tercapai, reset manual via Telegram /resetplan (worker: codex)
- [ ] Config block: vault.sweep.* dan tradingPlan.* di user-config.json (worker: codex)
- [ ] Write tests: sweep threshold, auto-stop at target, vault send gate, toggle on/off (worker: codex)
- [ ] Review & finalize (worker: claude)
Added: 2026-05-21

---

## Codex Co-Leader Notes
- 2026-05-21: Codex co-leader loop enabled via ops/codex-coleader-loop.sh. Claude remains final review/decision gate; Codex handles build/test tasks.
