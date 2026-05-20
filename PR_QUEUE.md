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

## PR-001: Daily Trade Guard — win/loss limit gate with Telegram decision flow
Status: done
Priority: high
Safety: safe
Goal: Implement a per-day win/loss counter that blocks new entries when a configurable limit is reached, sends a Telegram decision prompt (/continue or /stoptrade), and feeds outcome data into deep learning mode.
Tasks:
- [x] Create daily-trade-guard.js with state management
- [x] Add normalizeDailyTradeGuardConfig to config.js
- [x] Wire recordDailyTradeOutcome into trade exit handler in index.js
- [x] Add /continue and /stoptrade Telegram command handlers
- [x] Add /dailyguard and /resetguard commands
- [x] Add dailyGuard status line to /status output
- [x] Add buildDailyGuardAnalysisPrompt to learning-mode.js
- [x] Write tests/daily-trade-guard.test.js (4 tests, all passing)
Added: 2026-05-21
Completed: 2026-05-21

---

## PR-002: DexVisibilityRiskAnalyzer — DEX visibility risk analysis module
Status: pending
Priority: high
Safety: safe
Goal: TypeScript module that classifies Dex Paid/Ads/Boost as positive signals (early launch, low volume, high organic score) or distribution risk (post-pump visibility, high holder concentration, dev wallet exiting). Returns RiskStatus enum + reasons array. No trades executed.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Define TypeScript interfaces: DexVisibilityInput, DexVisibilityOutput   (worker: codex)
- [ ] Implement RiskStatus enum: POSITIVE, NEUTRAL, DANGER, HIGH_RISK          (worker: codex)
- [ ] Implement analyzeDexVisibilityRisk(tokenData) with all scoring rules     (worker: codex)
- [ ] Write unit tests: positive case, danger case, neutral case               (worker: codex)
- [ ] Review & finalize                                                         (worker: claude)
Added: 2026-05-21

---

## PR-003: ThreeCandleConfirmationStrategy — staged-entry FOMO protection module
Status: pending
Priority: high
Safety: safe
Goal: TypeScript decision module that prevents FOMO buys on sharp red candles. Implements first-dip wait, 10% mark position on bounce, full entry only on second-dip confirmation with buy pressure + volume. Returns action enum + confirmationScore + positionSizing. No trades executed.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Define CandleStrategyState enum (11 states) and AgentAction enum (6 actions)  (worker: codex)
- [ ] Define CandleStrategyInput and CandleStrategyOutput interfaces                (worker: codex)
- [ ] Implement analyzeThreeCandleConfirmation() with all 7 strategy rules          (worker: codex)
- [ ] Implement confirmationChecklist scoring (5 checks, threshold < 3 blocks)      (worker: codex)
- [ ] Write unit tests: 7 cases covering all actions and edge states                (worker: codex)
- [ ] Review & finalize                                                              (worker: claude)
Added: 2026-05-21

---

## PR-004: CabalPlayAnalyzer — coordinated wallet detection module
Status: pending
Priority: high
Safety: safe
Goal: TypeScript module detecting GROUP_CABAL, SOLO_CABAL, CONFLICT_CABAL, DISTRIBUTION_RISK, FOMO_RISK patterns from on-chain wallet data. Returns cabalType, riskLevel, action, cabalScore, confidence, reasons. Never returns BUY/SELL. Analysis layer only.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Define CabalType and CabalAgentAction enums                                   (worker: codex)
- [ ] Define CabalPlayInput and CabalPlayOutput interfaces                           (worker: codex)
- [ ] Implement analyzeCabalPlay() with all 5 detection patterns and routing rules  (worker: codex)
- [ ] Write unit tests: 8 cases (group, solo, conflict, distribution, FOMO, etc.)   (worker: codex)
- [ ] Review & finalize                                                              (worker: claude)
Added: 2026-05-21

---

## PR-005: WalletPingAgent — wallet monitoring and alert system
Status: pending
Priority: high
Safety: safe
Goal: TypeScript module monitoring tracked wallets and generating alerts (never auto-buy). Components: WalletQualityScorer (0–100 score, 4 quality levels), WalletEventClassifier, WalletRelationshipExplorer, PingRiskGuard. isDirectBuySignal always false. Routes to DexVisibilityRiskAnalyzer/CabalPlayAnalyzer/ThreeCandleConfirmationStrategy.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Define all enums: WalletEventType, WalletQualityLevel, PingSeverity, WalletPingAction  (worker: codex)
- [ ] Define interfaces: WalletStats, WalletPingInput, WalletPingOutput, RelatedWalletCandidate, RiskFlag  (worker: codex)
- [ ] Implement WalletQualityScorer with 7-factor scoring (0–100)                           (worker: codex)
- [ ] Implement processWalletPing() with all 12 core rules                                  (worker: codex)
- [ ] Implement WalletRelationshipExplorer (related wallet discovery)                       (worker: codex)
- [ ] Write unit tests: 10 cases covering all actions                                       (worker: codex)
- [ ] Review & finalize                                                                     (worker: claude)
Added: 2026-05-21

---

## PR-006: Day Phase Trade — 3–7 day swing skill with 1 SOL balance gate
Status: pending
Priority: medium
Safety: needs_review
Goal: TypeScript/Node.js skill that finds memecoins in cooldown→sideways phase (50–70% dip from ATH, 3–5 day sideways, FDV > $1M, narrative alive). Gated: requires >= 1 SOL wallet balance. Includes DayPhaseAnalyzer (100-point scoring), watchlist classification (Strong/Medium/Weak/Skip), and ExecutionPlanner (DCA weekend entry, 40–70% TP, 7-day max hold). No auto-trade.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Implement DayPhaseAnalyzer with 5-criterion scoring (0–100)                 (worker: codex)
- [ ] Implement phase classification: HYPE/PARABOLIC/COOLDOWN_SIDEWAYS/REVIVAL_DEATH  (worker: codex)
- [ ] Implement watchlist status: Strong/Medium/Weak/Skip                          (worker: codex)
- [ ] Implement 1 SOL balance gate (isDayPhaseTradeUnlocked)                       (worker: codex)
- [ ] Implement ExecutionPlanner (DCA plan, TP targets, invalidation rules)        (worker: codex)
- [ ] Write unit tests for scoring logic and balance gate                          (worker: codex)
- [ ] Review & finalize                                                            (worker: claude)
Added: 2026-05-21

---

## PR-007: Transaksi Murah — Direct RPC Trading engine (Rust + TypeScript)
Status: pending
Priority: medium
Safety: needs_review
Goal: Rust CLI service + TypeScript integration layer for direct Solana RPC trading. Reduces platform fees by bypassing aggregator middleware. Features: simulation-first (blocks execute if sim fails), dynamic priority fee (auto/low/medium/high), RPC failover (primary + 2 backups), risk guard (max 0.25 SOL/trade, reserve 0.05 SOL for fees, slippage cap 300bps). 1 SOL balance gate. DRY_RUN=true default, LIVE_TRADING=false default.
Workers:
  research: gemini
  build: codex
  review: claude
Tasks:
- [ ] Rust engine: balance, simulate, execute, health commands with JSON output    (worker: codex)
- [ ] TypeScript: rpcFailover.ts with latency-based endpoint switching             (worker: codex)
- [ ] TypeScript: priorityFeeManager.ts (auto/low/medium/high modes)               (worker: codex)
- [ ] TypeScript: directRpcTrading.ts with simulation-first gate                   (worker: codex)
- [ ] TypeScript: skill_registry.ts + risk_guard.ts + 1 SOL balance gate          (worker: codex)
- [ ] Write unit tests: balance gate, sim-blocks-execute, RPC failover, DRY_RUN   (worker: codex)
- [ ] Review & finalize                                                            (worker: claude)
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
