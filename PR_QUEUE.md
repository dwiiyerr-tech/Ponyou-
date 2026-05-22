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
Status: done
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
Status: done
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

## PR-011: Vault Profit Sweep + Trading Plan 30
Status: done
Priority: high
Safety: needs_review
Goal: (1) Vault sweep: auto-kirim % profit harian/mingguan ke wallet vault yang bisa dikonfigurasi — threshold %, interval hari, on/off toggle, jumlah minimum sweep. (2) Trading Plan 30: mode trading dengan target 30 trades per sesi yang bisa di-setting, diaktifkan/dimatikan, dengan tracking progress dan auto-stop saat target tercapai.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] vault-profit-sweep.js revisi — tambah configurable: sweepPct, sweepIntervalDays, minSweepSol, vaultWallet, enabled toggle (worker: codex)
- [x] Auto-sweep trigger: setelah setiap trade ditutup, cek apakah threshold harian/mingguan terpenuhi → kirim ke vault (worker: claude)
- [x] Telegram notif saat sweep terjadi: jumlah SOL dikirim, wallet tujuan, sisa balance (worker: claude)
- [x] trading-plan-30.js — mode trading dengan target N trades (default 30) per sesi, configurable, on/off toggle (worker: claude)
- [x] Trading plan tracking: progress counter, auto-stop saat target tercapai, reset manual via Telegram /resetplan (worker: claude)
- [x] Config block: vault.sweep.* dan tradingPlan.* di user-config.json (worker: claude)
- [x] Write tests: sweep threshold, auto-stop at target, vault send gate, toggle on/off (worker: claude)
- [x] Review & finalize (worker: claude)
Added: 2026-05-21

---

## PR-012: Web Dashboard — localhost monitoring + control UI
Status: done
Priority: high
Safety: safe
Goal: Express + WebSocket localhost dashboard with 3 tabs (Dashboard, Commands, Settings), 13-step setup wizard, file-based IPC to bot process. Standalone process (node dashboard.js), state read from JSON files, WebSocket pushes live state every 2s.
Workers:
  research: claude
  build: codex
  review: claude
Tasks:
- [x] Design & architecture spec approved                                                            (worker: claude)
- [x] Task 1: Install deps (express, ws) + scaffold directory structure                             (worker: claude)
- [x] Task 2: dashboard/state-reader.js + tests                                                     (worker: claude)
- [x] Task 3: dashboard/command-writer.js + tests                                                   (worker: claude)
- [x] Task 4: dashboard/config-writer.js (read/write user-config.json, mask private key) + tests    (worker: claude)
- [x] Task 5: dashboard/ipc.js (write dashboard-cmd.json, poll response 5s timeout) + tests        (worker: claude)
- [x] Task 6: dashboard/log-buffer.js (ring buffer 200 lines) + tests                              (worker: claude)
- [x] Task 7: dashboard/routes/api.js (REST /api/*) + tests                                        (worker: claude)
- [x] Task 8: dashboard/routes/wizard.js (REST /wizard/*) + tests                                  (worker: claude)
- [x] Task 9: dashboard/server.js (Express + WebSocket + 2s push loop)                             (worker: claude)
- [x] Task 10: dashboard/public/style.css (dark theme)                                             (worker: claude)
- [x] Task 11: dashboard/public/app.js (WebSocket client + tab switching + UI logic)               (worker: claude)
- [x] Task 12: dashboard/public/index.html (3-tab UI)                                              (worker: claude)
- [x] Task 13: dashboard/public/wizard.html (13-step setup wizard)                                 (worker: claude)
- [x] Task 14: dashboard.js entrypoint + index.js patch (handleDashboardCommand + IPC poll)        (worker: claude)
- [x] Task 15: Integration test — smoke test passes, 612/612 full suite                            (worker: claude)
- [x] Review & finalize                                                                             (worker: claude)
Added: 2026-05-22
Plan: docs/superpowers/plans/2026-05-22-dashboard.md

---

## PR-013: Dynamic Exit Slippage — CRITICAL Safety Fix
Status: done
Priority: high
Safety: needs_review
Goal: Ganti hardcoded slippage 1.0 di semua exit calls dengan dynamic progressive slippage: attempt 1=1%, attempt 2=5%, attempt 3=10%, attempt 4=20%. Jika semua gagal, kirim Telegram alert "POSITION STUCK — manual intervention needed". Config: maxExitAttempts (default 4), exitSlippageSteps (default [1,5,10,20]).
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] Audit semua exit call sites di index.js — catat line numbers (worker: claude)
- [x] exit-slippage.js — module dengan getExitSlippage(attempt), validateSlippageConfig() (worker: claude)
- [x] Patch index.js — wrap semua exit calls dengan retry loop + progressive slippage (worker: claude)
- [x] Telegram alert jika semua attempt gagal: "⚠️ POSITION STUCK: {symbol} — exit failed after 4 attempts" (worker: claude)
- [x] Config block: exitSlippage.* di user-config.json dan config.js (worker: claude)
- [x] Write tests: progressive steps, max attempt alert, config defaults (worker: claude)
- [x] Review & finalize (worker: claude)
Added: 2026-05-22
Audit-source: Gemini + Claude verified (lines 1323, 1332, 1406, 1416 index.js)

---

## PR-014: Integration Gaps — Narrative Feedback + Zombie Wallets + Partial TP Guard
Status: done
Priority: high
Safety: needs_review
Goal: Fix 3 integration gaps yang terverifikasi: (1) recordRuggedNarrativesForExit tidak pernah dipanggil di index.js — semua exit paths harus feed ke narrative blocklist. (2) getAllWallets() tidak filter by decay score — zombie wallets makan Geyser subscription slots. (3) Partial TP idempotency guard — cek jika partial TP sudah landing sebelum retry untuk hindari double-sell.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] Wire recordRuggedNarrativesForExit ke semua exit paths di index.js (tidak hanya "rug" reason) (worker: claude)
- [x] getAllWallets() filter: tambah applyScoreDecay check, skip wallet dengan multiplier < 0.5 (worker: codex)
- [x] partial-tp-guard.js — idempotency key per posisi+attempt, cek onchain tx sebelum retry (worker: codex)
- [x] Write tests: narrative feedback untuk slow-rug exits, decay filter, partial TP dedup (worker: codex)
- [x] Review & finalize (worker: claude)
Added: 2026-05-22
Audit-source: Gemini + Claude verified

---

## PR-015: State Pruning + Kelly Outlier Cap
Status: done
Priority: medium
Safety: safe
Goal: (1) state-pruner.js — arsipkan posisi closed > 7 hari ke closed-positions-archive.json, pruning otomatis tiap startup dan tiap 24 jam. (2) Kelly outlier cap — clamp payoffRatio max 5x, enforce min 10 trades sebelum Kelly aktif, tambah volatility dampener untuk memecoin high-variance.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] state-pruner.js — pruneClosedPositions(maxAgeDays=7), archivePath, auto-trigger (worker: codex)
- [ ] Wire state-pruner ke startup dan 24h interval di index.js (worker: codex)
- [ ] kelly-mode-selector.js patch — clamp payoffRatio ≤ 5, minSampleTrades=10, volatility dampener (worker: codex)
- [ ] Write tests: pruning threshold, Kelly cap, min sample enforcement (worker: codex)
- [ ] Review & finalize (worker: claude)
Added: 2026-05-22
Audit-source: Gemini + Claude verified

---

## PR-016: Dashboard Security — Auth + IPC File Lock
Status: done
Priority: medium
Safety: safe
Goal: (1) Dashboard auth: Bearer token sederhana di header — token di-generate saat startup, disimpan di dashboard-token.txt, dikonfirmasi via cookie/localStorage di browser. (2) IPC file lock: gunakan rename-atomic pattern (tmp write + rename) untuk dashboard-cmd.json agar tidak ada race condition baca/tulis.
Workers:
  research: claude
  build: codex
  review: claude
Tasks:
- [ ] dashboard/auth.js — generateToken(), validateToken(req), middleware Express (worker: codex)
- [ ] Wire auth middleware ke semua routes kecuali GET /wizard/config saat first-time setup (worker: codex)
- [ ] dashboard/public/app.js patch — attach token ke semua fetch requests via localStorage (worker: codex)
- [ ] dashboard/command-writer.js patch — atomic write dengan tmp+rename untuk writeDashboardCmd (worker: codex)
- [ ] dashboard/ipc.js patch — re-read file setelah rename untuk pastikan data konsisten (worker: codex)
- [ ] Write tests: token validation, atomic write, auth middleware rejection (worker: codex)
- [ ] Review & finalize (worker: claude)
Added: 2026-05-22
Audit-source: Gemini + Claude verified

---

## PR-017: Market Heatmap — Dynamic maxPositions + Regime-Aware Sizing
Status: done
Priority: medium
Safety: needs_review
Goal: Market heatmap dari GMGN API data untuk dynamically adjust maxPositions: DEAD market=1, COLD=2, NORMAL=3, HOT=4, FRENZY=5. Integrasikan dengan capital-sizing.js sehingga Kelly sizing aware terhadap overall market regime, bukan hanya per-token signal.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [x] Gemini research: reused existing market-intelligence.js (DEAD/COLD/NORMAL/HOT/EXTREME already tracked) (worker: claude)
- [x] market-heatmap.js — computeMarketRegime(), getMaxPositions(regime), persistence ke market-heatmap-state.json (worker: claude)
- [x] index.js patch — inject heatmapMax into positionLimit, pass to kellyModeOpts.maxPositions (worker: claude)
- [x] index.js patch — refresh heatmap tiap screening cycle (computeMarketRegime() after recordMarketSnapshot) (worker: claude)
- [x] Write tests: regime thresholds, maxPositions mapping, stale data fallback (worker: claude)
- [x] Review & finalize (worker: claude)
Added: 2026-05-22
Audit-source: Gemini recommendation

---

## Codex Co-Leader Notes
- 2026-05-21: Codex co-leader loop enabled via ops/codex-coleader-loop.sh. Claude remains final review/decision gate; Codex handles build/test tasks.
