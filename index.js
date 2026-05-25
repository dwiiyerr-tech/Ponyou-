import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { createRugCircuitBreaker } from "./rug-circuit-breaker.js";
import { agentLoop } from "./agent.js";
import AgentRouter from "./agent-router.js";
import { log } from "./logger.js";
import { getWalletBalances } from "./tools/wallet.js";
import { applyFeeEntryGuard, getSolanaGasFee, shouldSkipEntriesForGasFee } from "./tools/solana-rpc.js";
import { discoverTokens, getTokenSecurityDetails, getTokenKlines } from "./tools/dexscreener.js";
import { preSwapGuard, swapToken } from "./tools/jupiter.js";
import { config, computeDeployAmount, computeVolatilityAdjustedSize } from "./config.js";
import { computeRegimeSizeMultiplier } from "./market-safety.js";
import {
  filterNarrativeContagion,
  isRugExitReason,
  recordRuggedNarrativesForExit,
} from "./narrative-contagion.js";
import { analyzeHolderStructure } from "./holder-memory.js";
import { summarizeSmartWalletHistory } from "./smart-wallet-history.js";
import { getPerformanceSummary, recordTradeOutcome, getPerformanceHistory, recordLessonOutcome, updateDarwinWeights, getDarwinAnalytics } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled, createLiveMessage, formatPnLTable, sendHTML, fmt, htmlEscape } from "./telegram.js";
import {
  strategy, checkROI, run4FilterProtocol, getMcapTier, getTierExecutionProfile,
  checkPartialTP,
} from "./strategy.js";
import { buildRiskPolicy, evaluateExitPolicy } from "./risk-policy.js";
import {
  getStrategy, listStrategies, setActiveStrategy, setStrategyOverride,
  getActiveStrategyId, STRATEGY_IDS,
} from "./strategies.js";
import {
  listPendingIntents, getIntent, consumeIntent,
} from "./intents.js";
import { trackPosition, recordClose, getTrackedPosition, getState, getStateSummary, syncOpenPositions, markPartialTPDone, updatePeakPnl, cleanStaleTestPositions, flushState } from "./state.js";
import { pruneClosedPositions } from "./state-pruner.js";
import { atomicWriteJson } from "./atomic-write.js";
import { calculateRSI, calculateSuperTrend, calculateVolatilityPercentile } from "./utils/indicators.js";
import {
  startTimer, elapsedMs, recordLatency, recordError, recordCounter,
  setGauge, getStats, flushMetrics, recordCumulativePnl,
} from "./metrics.js";
import {
  readKillState, isKilled, setSessionBaseline, reportBalance,
  recordSwapOutcome, trip as tripKillSwitch, reset as resetKillSwitch,
} from "./kill-switch.js";
import { runFastTrackBatch } from "./fast-buy.js";
import { startGeyserStream } from "./geyser.js";
import { attachExitMonitor, checkPriceDrop } from "./geyser-exit-monitor.js";
import { createRugMonitor, SEVERITY as RUG_SEVERITY } from "./rug-monitor.js";
import { Connection } from "@solana/web3.js";
import { createRpcQuorum } from "./tools/rpc-quorum.js";
import { createFeeOracle } from "./tools/fee-oracle.js";
import { setRpcQuorum, setFeeOracle, shutdownSingletons } from "./tools/exec-edge-singletons.js";
import { captureEntryMetadata } from "./tools/entry-metadata.js";
import {
  initWalletManager, getActiveWallet, markWalletError,
  resetWalletErrors, getWalletCapitalSol, isMultiWalletEnabled, getAllWallets, buildCapitalAwareWalletPlan, getWalletByAddress,
  shutdownWalletManager,
} from "./tools/wallet-manager.js";

import {
  getTradingPlan, initTradingPlan, checkSessionGate,
  updateSessionCapital, getPlanSummary, recordTrade,
  advanceDay, isInProfitMode, getDynamicPositionLimit,
  getConsecutiveLosses,
} from "./trading-plan.js";
import {
  recordMarketSnapshot, getMarketIntelligence,
  getRecommendedAdjustments, recordMarketResearchEnrichment,
} from "./market-intelligence.js";
import {
  scoreRugRisk, isDevBlocked, isTokenBlacklisted, recordRug, getRugMemory,
} from "./lessons.js";
import {
  getLearningModeStatus, activateLearningMode, markAnalysisRun,
  buildLossAnalysisPrompt, recordLossAnalysis, shouldRunAnalysis,
  getActiveLossContext,
} from "./learning-mode.js";
import {
  recordObservations, processObservations, buildObservationAnalysisPrompt,
  buildSuccessAnalysisPrompt
} from "./learning-continuous.js";
import {
  getCoinConviction, recordCoinObservation, recordObservationOutcomes, recordTradeConvictionOutcome,
  getNarrativeConviction,
} from "./conviction-memory.js";
import {
  buildTokenRegime, getRegimeAssessment, recordRegimeObservation, recordRegimeTradeOutcome,
} from "./regime-memory.js";
import { recordExecutionQuality, getExecutionQualityAssessment } from "./execution-quality-memory.js";
import { assessTradeAttribution, recordTradeAttribution } from "./trade-attribution.js";
import { harvestMarketRugs } from "./tools/rug-harvester.js";
import { preScreenBatch } from "./tools/trash-filter.js";
import { detectAnomaly, hasAnyActiveFlag } from "./tools/rug-anomaly.js";
import { analyzeRugWithLLM } from "./tools/rug-llm-analysis.js";
import { simulateSell } from "./tools/sell-simulator.js";
import { screenDayPhaseTokens, isWeekendEntryWindow, isWeekdayExitWindow, formatWatchlistForNotification } from "./tools/day-phase-screener.js";
import { initStagedEntry, checkStagedEntryTrigger, advanceStagedEntry, getStage1Amount } from "./tools/staged-entry.js";
import { getRugCheckReport, rugCheckToSignals } from "./tools/rugcheck.js";
import { getWalletSnapshot } from "./tools/solscan.js";
import { blacklistDev, checkDevBlacklist, getDevBlacklist } from "./tools/dev-blacklist.js";
import { recordNarrativeOutcome, detectNarrativeVelocity, trackCrossBatchVelocity, getCrossBatchVelocity } from "./tools/narratives.js";
import { aggregateSignal } from "./signal-aggregator.js";
import { registerDefaultFeatures, runAllFeatures, listFeatures, getHealthSummary, enableFeature, disableFeature, autoResetBreakers } from "./feature-registry.js";
import { analyzeCabalPlay, CabalAgentAction } from "./tools/cabal-play-analyzer.js";
import { runAllMaintenance } from "./data-maintenance.js";
import { addSmartWallet, listSmartWallets } from "./smart-wallets.js";
import { computeMarketRegime, getMaxPositions as getHeatmapMaxPositions } from "./market-heatmap.js";
import { discoverSmartWallets } from "./tools/wallet-discovery.js";
import { bulkRegister as bulkRegisterTickers } from "./tools/ticker-registry.js";
import {
  isVaultDue, computeVaultAmount, executeVaultTransfer,
  recordVaultTransfer, getVaultStatus, buildVaultNotification, computeProfitSweepAmount,
} from "./vault.js";
import { isTokenOnCooldown, setTokenCooldown } from "./trade-cooldowns.js";
import {
  generateDailyReport, formatReportTelegram, wasTodayReported,
} from "./daily-report.js";
import { getTokenInfo } from "./tools/token.js";
import {
  analyzeMomentum, checkEntryConfirmation, adjustSizeByRSI,
  checkTrendBreakExit, getMomentumScore,
} from "./momentum-analysis.js";
import { resolveExecutionMode } from "./runtime-mode.js";
import {
  recordTrade as recordTradingPlanTrade, isSessionComplete,
  getTradingPlanStatus, resetTradingPlan, isTradingPlanEnabled,
} from "./trading-plan-30.js";
import { getCapitalAwareSizing } from "./capital-sizing.js";
import { evaluateCandidateDecision } from "./decision-workflow.js";
import { recordDecision } from "./decision-log.js";
import { assertOperationalReadiness, formatReadinessReport } from "./readiness.js";
import { StrategyEvolutionEngine } from "./strategy-evolution-engine.js";
import { StrategyEvolutionBus } from "./strategy-evolution-bus.js";
import { StrategyRegistry } from "./strategy-registry.js";
import { StrategyGate } from "./strategy-gate.js";
import { StrategyProposal } from "./strategy-proposal.js";
import { StrategyComposer } from "./strategy-composer.js";
import { FundamentalStrategyProducer } from "./fundamental-strategy-producer.js";
import { StrategyRuntimeSelector, setRuntimeSelector } from "./strategy-runtime-selector.js";
import {
  readAutomationCommand, publishAutomationState, persistAutomationPreference,
  issueSupervisorCommand, publishSupervisorState, readSupervisorState,
} from "./automation-control.js";
import {
  getDailyTradeGuardStatus, recordDailyTradeOutcome,
  decideDailyTradeGuard, isDailyTradeGuardEntryBlocked,
} from "./daily-trade-guard.js";
import { withProgressiveSlippage, getExitSlippage } from "./exit-slippage.js";
import { isPartialTPLanded, markPartialTPLanded, clearPartialTPGuard } from "./partial-tp-guard.js";

log("startup", "Ponyou AI Agent starting...");
const executionMode = resolveExecutionMode();
log("startup", `Mode: ${executionMode.label}${executionMode.isDemo ? " — real swaps on devnet (fake SOL)" : " — live mainnet (real SOL)"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "minimax/minimax-m2.7"}`);

// Devnet faucet: auto-fund demo wallet with devnet SOL on startup
if (executionMode.isDemo) {
  import("./tools/devnet-faucet.js").then(async ({ ensureDevnetBalance, getDevnetBalance }) => {
    try {
      const walletModule = await import("./tools/wallet.js");
      const balance = await walletModule.getWalletBalances();
      if (balance?.wallet) {
        const bal = await getDevnetBalance(balance.wallet);
        log("devnet", `Wallet ${balance.wallet.slice(0, 8)}… balance: ${bal?.sol?.toFixed(4) || "?"} SOL`);
        const funded = await ensureDevnetBalance(balance.wallet);
        if (funded.funded && funded.signature) {
          log("devnet", `Faucet funded ${funded.amount_sol} SOL`);
        }
      }
    } catch (e) {
      log("devnet_warn", `Faucet init: ${e.message}`);
    }
  }).catch(() => {});
}

// PID file guard: prevent duplicate instances
(async () => {
  const { writeFileSync: _wfs, readFileSync: _rfs, existsSync: _es, unlinkSync: _us } = await import("fs");
  const PID_FILE = new URL("./.agent.pid", import.meta.url).pathname;
  if (_es(PID_FILE)) {
    const oldPid = parseInt(_rfs(PID_FILE, "utf8").trim(), 10);
    try { process.kill(oldPid, 0); log("startup", `Replacing stale PID ${oldPid}`); } catch (_) { /* stale */ }
  }
  _wfs(PID_FILE, String(process.pid));
  process.on("exit", () => { try { _us(PID_FILE); } catch (_) {} });
})();

// Clean stale test artifacts that may have leaked into state.json
cleanStaleTestPositions();

const MAX_CANDIDATES_PER_CYCLE = 20;

// ─── Data Maintenance ─────────────────────────
const maintenanceResult = runAllMaintenance();
log("startup", `Data maintenance: ${maintenanceResult.migrated} files, ${maintenanceResult.conviction_pruned} conviction pruned, ${maintenanceResult.lessons_removed} lessons removed, ${maintenanceResult.rug_blacklist_capped} blacklist capped`);

// ─── Feature Registry ──────────────────────────
registerDefaultFeatures();
log("startup", `Feature registry: ${listFeatures().length} signals registered`);

export { computeRegimeSizeMultiplier } from "./market-safety.js";

// Initialize multi-agent router for research/narrative tasks.
const agentRouter = new AgentRouter({
  callLLM: async (messages) => {
    const userMsg = messages.find(m => m.role === "user")?.content || "";
    const { content } = await agentLoop(userMsg, 5, [], "GENERAL", config.llm.generalModel, 1024);
    return content;
  },
  rufloEnabled: false, // disable ruflo for now
});
log("startup", `AgentRouter initialized — Gemini: disabled (using Claude direct), Codex: true`);

// Strategy Evolution Engine — opt-in via config.strategy.evolution.enabled
// Two-stage opt-in:
//   strategy.evolution.enabled            → engine + composer + registry + gate live
//   strategy.fundamentalProducer.enabled  → producer also runs (defaults to dryRun)
let _fundamentalProducer = null;
let _evolutionEngine = null; // module-level for degradation cron access
if (config.strategy?.evolution?.enabled) {
  const _strategyRegistry = new StrategyRegistry({ persistPath: "./data/strategy-registry.json" });
  const _strategyBus = new StrategyEvolutionBus({ maxQueue: config.strategy.evolution.maxCandidateQueue ?? 5 });
  const _strategyGate = new StrategyGate({});
  const _strategyProposal = new StrategyProposal({
    sendTelegram: sendMessage,
    autoApproveConvictionMin:   config.strategy.evolution.autoApproveConvictionMin ?? 0.95,
    autoApproveMinMaturityDays: config.strategy.fundamentalProducer?.minDataAgeDays ?? 30,
    proposalTimeoutMs:          (config.strategy.evolution.proposalTimeoutHours ?? 24) * 60 * 60 * 1000,
  });
  const _strategyComposer = new StrategyComposer({
    registry: _strategyRegistry,
    // LLM generator is intentionally null in Phase-1 — composer.generate() will
    // simply return null and the producer falls back to compose-only.
    llmGenerator: null,
  });
  _evolutionEngine = new StrategyEvolutionEngine({
    bus: _strategyBus,
    gate: _strategyGate,
    registry: _strategyRegistry,
    proposal: _strategyProposal,
    degradationThreshold: config.strategy.evolution.degradationThreshold ?? 0.75,
  });
  _evolutionEngine.start();
  log("startup", "Strategy Evolution Engine started (strategy.evolution.enabled=true).");

  // Runtime selector — when enabled, allows agent to PICK from the evolved
  // registry at trade time instead of always using the static PRESET.
  // Off by default; even when enabled, defaults to "shadow" mode (logs the
  // diff without applying), so the operator can compare evolved vs preset
  // for a few days before flipping to "live".
  const runtimeSelectorCfg = config.strategy?.runtimeSelector || {};
  if (runtimeSelectorCfg.enabled) {
    const _runtimeSelector = new StrategyRuntimeSelector({
      registry: _strategyRegistry,
      config: runtimeSelectorCfg,
      logger: {
        info: (...args) => log("strategy_selector", args.map(String).join(" ")),
        warn: (...args) => log("strategy_selector_warn", args.map(String).join(" ")),
        error: (...args) => log("strategy_selector_error", args.map(String).join(" ")),
      },
    });
    setRuntimeSelector(_runtimeSelector);
    log("startup", `Strategy Runtime Selector active (mode=${runtimeSelectorCfg.mode || "shadow"}).`);
  }

  if (config.strategy?.fundamentalProducer?.enabled) {
    _fundamentalProducer = new FundamentalStrategyProducer({
      bus: _strategyBus,
      composer: _strategyComposer,
      registry: _strategyRegistry,
      memories: {
        getCoinConviction,
        getNarrativeConviction,
        summarizeSmartWalletHistory,
        analyzeHolderStructure,
        getRegimeAssessment,
        getExecutionQualityAssessment,
      },
      config: config.strategy.fundamentalProducer,
      logger: {
        info: (...args) => log("fundamental_producer", args.map(String).join(" ")),
        warn: (...args) => log("fundamental_producer_warn", args.map(String).join(" ")),
        error: (...args) => log("fundamental_producer_error", args.map(String).join(" ")),
      },
    });
    // No contextProvider here — the screening cycle calls _fundamentalProducer.tick(ctx)
    // when it has fresh candidates. start() flips the running flag for status checks.
    _fundamentalProducer.start();
    log("startup", `FundamentalStrategyProducer started (dryRun=${config.strategy.fundamentalProducer.dryRun}).`);
  }
}

export function getFundamentalProducer() {
  return _fundamentalProducer;
}

export function getEvolutionEngine() {
  return _evolutionEngine;
}

export function getAgentRouter() {
  return agentRouter;
}

async function enrichMarketResearchWithAgentRouter({ marketIntel, candidates }) {
  if (!marketIntel || !Array.isArray(candidates) || candidates.length === 0) return null;

  const topTokens = candidates.slice(0, 6).map(t => ({
    symbol: t.symbol,
    mint: t.mint,
    mcap: t.mcap,
    volume: t.volume,
    swaps: t.swaps,
    buy_vol: t.buy_vol,
    sell_vol: t.sell_vol,
    hot_level: t.hot_level,
    narrative_tags: t.narrative_tags,
  }));
  const marketQuery = [
    "Market research task for Solana memecoin screening.",
    "Summarize current narrative strength, crowding risk, and one concise caution.",
    "Do not make buy/sell decisions or sizing recommendations.",
    `Market condition: ${marketIntel.condition} - ${marketIntel.description}`,
    `Top discovered tokens: ${JSON.stringify(topTokens)}`,
  ].join("\n");

  const researchResult = await agentRouter.invoke(marketQuery, {
    preferAgent: "claude",
    timeoutMs: 45_000,
    confidenceGate: { safetySensitive: false, minConfidence: 0.6 },
  });
  if (researchResult.error) {
    log("market_research_error", researchResult.error);
    return null;
  }

  const saved = await recordMarketResearchEnrichment({
    agent: researchResult.agent,
    duration_ms: researchResult.durationMs,
    condition: marketIntel.condition,
    summary: String(researchResult.result || "").slice(0, 2000),
  });
  log("market_research", `AgentRouter enrichment saved via ${researchResult.agent}`);
  return saved;
}

// ─── Init Multi-Wallet ────────────────────────────────────────
initWalletManager();
const startupReadiness = assertOperationalReadiness({
  executionMode,
  runtime: {
    hasActiveWallet: !!getActiveWallet(),
  },
});
for (const warning of startupReadiness.warnings || []) {
  log("readiness_warn", warning);
}
log("readiness", startupReadiness.summary);
if ((startupReadiness.warnings || []).length > 0) {
  log("readiness", formatReadinessReport(startupReadiness));
}

const staleCleaned = cleanStaleTestPositions();
if (staleCleaned > 0) log("startup", `Removed ${staleCleaned} stale test positions from state`);
const { pruned: prunedArchive } = pruneClosedPositions();
if (prunedArchive > 0) log("startup", `Archived ${prunedArchive} old closed positions`);

// ─── Auto-init trading plan ───────────────────────────────────
if (!getTradingPlan() && config.pilot.enabled) {
  initTradingPlan({
    initialCapitalUsd:       config.pilot.initialCapitalUsd,
    dailyTargetPct:          config.pilot.dailyTargetPct,
    dailyStopLossPct:        config.pilot.dailyStopLossPct,
    sessionPauseDurationMin: config.pilot.sessionPauseDurationMin,
    learningModeDurationMin: config.pilot.learningModeDurationMin,
    days:                    config.pilot.planDays,
  });
  log("plan", `Plan initialized: $${config.pilot.initialCapitalUsd} → ${config.pilot.planDays}d @ ${config.pilot.dailyTargetPct}%/day`);
}

// ─── Timers ───────────────────────────────────────────────────
const timers = { managementLastRun: null, screeningLastRun: null };

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  return Math.max(0, intervalMin * 60 - (Date.now() - lastRun) / 1000);
}

function formatCountdown(secs) {
  if (secs <= 0) return "now";
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  const plan = getPlanSummary();
  const learn = getLearningModeStatus();
  const planStr = plan
    ? ` | Day ${plan.day}/${plan.days_total} P&L:${plan.today_pnl_pct > 0 ? "+" : ""}${plan.today_pnl_pct}%${plan.profit_mode ? " 🔥" : ""}`
    : "";
  const learnStr = learn.active ? ` | 🧠LEARN ${learn.resume_in_min}m` : "";
  const market = getMarketIntelligence();
  return `[mgmt:${mgmt}|scrn:${scrn}${planStr}${learnStr}|${market.condition}]\n> `;
}

async function getPortfolioSnapshot() {
  if (!isMultiWalletEnabled()) {
    const balance = await withTimeout(getWalletBalances(), CYCLE_RPC_TIMEOUT_MS, "getWalletBalances");
    const tokens = (balance.tokens || []).map(token => ({
      ...token,
      wallet_address: balance.wallet || null,
      position_key: balance.wallet ? `${token.mint}::${balance.wallet}` : token.mint,
    }));
    return {
      ...balance,
      tokens,
      wallet_balances: [balance],
    };
  }

  const wallets = getAllWallets().filter(w => w.status !== "disabled");
  const balances = await Promise.all(
    wallets.map(w => getWalletBalances(w.address).catch(() => ({
      wallet: w.address, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet fetch failed",
    })))
  );

  const aggregate = {
    wallet: null,
    sol: 0,
    sol_price: balances.find(b => b.sol_price > 0)?.sol_price || 0,
    sol_usd: 0,
    usdc: 0,
    tokens: [],
    total_usd: 0,
    wallet_balances: balances,
  };

  for (const balance of balances) {
    aggregate.sol += balance.sol || 0;
    aggregate.sol_usd += balance.sol_usd || 0;
    aggregate.usdc += balance.usdc || 0;
    aggregate.total_usd += balance.total_usd || 0;
    for (const token of balance.tokens || []) {
      aggregate.tokens.push({
        ...token,
        wallet_address: balance.wallet || null,
        position_key: balance.wallet ? `${token.mint}::${balance.wallet}` : token.mint,
      });
    }
  }

  aggregate.sol = Number(aggregate.sol.toFixed(6));
  aggregate.sol_usd = Number(aggregate.sol_usd.toFixed(2));
  aggregate.usdc = Number(aggregate.usdc.toFixed(2));
  aggregate.total_usd = Number(aggregate.total_usd.toFixed(2));
  return aggregate;
}

let _cronTasks = [];
let _managementBusy = false;
let _screeningBusy = false;
let _lastSolPrice = null;
// cronStarted is hoisted here so startCronJobs / stopCronJobs (defined below
// and exported) can safely reference it from another module's evaluation order.
let cronStarted = false;
let _dashboardIpcTimer = null;
let _ttyPromptTimer = null;
let _automationCommandTimer = null;

function withTimeout(promise, ms, label = "op") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms)),
  ]);
}

const CYCLE_RPC_TIMEOUT_MS = 45_000; // 45s timeout for RPC calls in cron cycles

function stripThink(t) {
  return t ? t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : t;
}

function formatDailyTradeGuardLine() {
  const s = getDailyTradeGuardStatus(config.dailyTradeGuard);
  if (!s.enabled) return "Daily Guard OFF";
  const label = s.status === "pending_decision"
    ? "WAITING"
    : s.status === "stopped"
      ? "STOPPED"
      : s.status === "continued"
        ? "CONTINUED"
        : "RUNNING";
  return `Daily Guard ${label} · W ${s.wins}/${s.max_wins_per_day} · L ${s.losses}/${s.max_losses_per_day}`;
}

function buildDailyGuardLearningContext(status, source = "telegram") {
  const pending = status?.last_decision?.pendingDecision || status?.pending_decision || null;
  const threshold = pending?.threshold || "manual";
  return {
    daily_guard: true,
    source,
    symbol: pending?.symbol || "DAILY_GUARD",
    mint: pending?.mint || null,
    pnl_pct: Number.isFinite(pending?.pnl_pct) ? pending.pnl_pct : null,
    exit_reason: threshold === "win" ? "DAILY_WIN_LIMIT" : threshold === "loss" ? "DAILY_LOSS_LIMIT" : "DAILY_GUARD_STOP",
    market_condition: getMarketIntelligence().condition,
    daily_guard_status: {
      date: status?.date,
      wins: status?.wins || 0,
      losses: status?.losses || 0,
      trades: status?.trades || 0,
      max_wins_per_day: status?.max_wins_per_day,
      max_losses_per_day: status?.max_losses_per_day,
      decision: status?.last_decision?.action || status?.status,
    },
  };
}

async function stopTradingForDailyGuard(source = "telegram") {
  const status = decideDailyTradeGuard("stop", config.dailyTradeGuard);
  const ctx = buildDailyGuardLearningContext(status, source);
  const duration = config.dailyTradeGuard?.learningModeDurationMin || config.pilot.learningModeDurationMin;
  const activated = activateLearningMode(ctx, ctx.exit_reason, duration);
  if (activated && shouldRunAnalysis()) {
    runLossAnalysis().catch(e => log("learning_error", e.message));
  }
  return { status, activated };
}

async function handleDailyTradeGuardOutcome(isWin, meta = {}) {
  const result = recordDailyTradeOutcome(isWin, meta, config.dailyTradeGuard);
  if (!result.enabled) return result;
  if (!result.triggered) return result;

  const thresholdLabel = result.threshold === "win" ? "win" : "loss";
  log("daily_guard", `${thresholdLabel} limit reached ${result.count}/${result.limit}`);

  if (telegramEnabled()) {
    const lines = [
      `🧭 <b>Daily Trade Guard</b>`,
      `${thresholdLabel.toUpperCase()} limit tercapai: <b>${result.count}/${result.limit}</b>`,
      `Hari ini: W ${result.wins}/${result.max_wins_per_day} · L ${result.losses}/${result.max_losses_per_day}`,
      fmt.divider(),
      `Lanjut trade? <code>/continue</code>`,
      `Stop dan masuk deep learning? <code>/stoptrade</code>`,
      fmt.it("Catatan: guard membangun conviction probabilistik, bukan janji coin pasti profit."),
    ];
    await sendHTML(lines.join("\n"));
  }

  return result;
}


// ─── Strategy / Confirm-Mode Telegram Commands ────────────────

/**
 * Handle Charon-style strategy + confirm-mode commands.
 * Returns true if the message was a known command (handled), false otherwise.
 *
 * Supported:
 *   /menu                         — show strategy + plan + open positions + confirm state
 *   /strategy                     — show current active strategy
 *   /strategy <id>                — switch active strategy
 *   /strategies                   — list all presets
 *   /stratset <id> <key> <value>  — override one field of a strategy
 *   /confirm on|off               — toggle confirm mode at runtime
 *   /pending                      — list pending intents
 *   /yes <id>                     — approve & execute a pending intent
 *   /no <id>                      — reject a pending intent
 */
async function handleStrategyTelegramCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];

  if (cmd === "/menu") {
    const active = getStrategy();
    const plan = getPlanSummary();
    const pending = listPendingIntents();
    const slPct = (active.stoploss * 100).toFixed(1);
    const trail = active.trailing_stop?.enabled ? "on" : "off";
    const ptp   = active.partial_tp?.enabled ? `${active.partial_tp.sell_pct}%@+${active.partial_tp.at_pct}%` : "off";
    const confirm = config.trading.confirmMode ? "🟡 ON" : "🟢 OFF";
    const automation = cronStarted ? "🟢 ON" : "🔴 OFF";
    const dailyGuard = formatDailyTradeGuardLine();
    const supervisor = readSupervisorState();
    const agentPower = supervisor?.desiredRunning
      ? (supervisor?.agentRunning ? "🟢 ON" : "🟡 BOOTING")
      : "🔴 OFF";
    const planLine = plan
      ? `Day ${plan.day}/${plan.days_total} · PnL ${fmt.pct(plan.today_pnl_pct ?? 0)} · target +${plan.daily_target_pct}%`
      : `belum diinisialisasi`;

    const lines = [
      `🤖 <b>Ponyou</b>`,
      fmt.divider(),
      `<b>Strategy</b> · ${htmlEscape(active.name)} (<code>${active.id}</code>)`,
      `SL ${slPct}% · trail ${trail} · partTP ${ptp} · LLM ${active.use_llm ? "on" : "off"}`,
      ``,
      `<b>Confirm</b> · ${confirm} · pending ${pending.length}`,
      `<b>Agent Power</b> · ${agentPower}`,
      `<b>Automation</b> · ${automation}`,
      `<b>Daily Guard</b> · ${htmlEscape(dailyGuard)}`,
      `<b>Plan</b> · ${planLine}`,
      fmt.divider(),
      fmt.it("/strategy /strategies /stratset /health /feature /confirm /dailyguard /auto /dayphase /devcheck /agent /pending /yes /no /pnl /status /plan /resetplan"),
    ];
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/health") {
    const health = getHealthSummary();
    const lines = [`🩺 <b>Feature Health</b>`, fmt.divider()];
    lines.push(`<b>${health.healthy}/${health.total_features}</b> healthy · ${health.tripped} tripped · ${health.disabled} disabled`);
    lines.push(``);
    for (const f of health.features) {
      const icon = f.breaker_tripped ? "🔴" : f.enabled ? "🟢" : "⚫";
      const latency = f.latency_p50_ms > 0 ? `${f.latency_p50_ms}ms` : "-";
      lines.push(`${icon} <b>${f.feature}</b> (w:${f.weight}) err:${f.error_rate_pct}% p50:${latency} score:${f.last_score}`);
      if (f.breaker_tripped) lines.push(`   ⚠️ BREAKER TRIPPED (${f.breaker_trips} trips)`);
    }
    lines.push(``, fmt.it("/feature <name> on|off — toggle feature"));
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/feature") {
    const args = (body || "").trim().split(/\s+/);
    const name = args[0];
    const action = args[1];
    if (!name || !action) {
      const features = listFeatures().map(f =>
        `${f.enabled ? "🟢" : "⚫"} ${f.name} (w:${f.weight})`
      ).join("\n");
      await sendHTML(`<b>Feature Toggle</b>\n${features}\n\nUsage: <code>/feature conviction off</code>`);
      return true;
    }
    if (action === "on" || action === "enable") {
      enableFeature(name);
      await sendHTML(`✅ Feature <b>${htmlEscape(name)}</b> enabled`);
    } else if (action === "off" || action === "disable") {
      disableFeature(name);
      await sendHTML(`⏸️ Feature <b>${htmlEscape(name)}</b> disabled`);
    } else {
      await sendHTML(`Usage: <code>/feature ${htmlEscape(name)} on|off</code>`);
    }
    return true;
  }

  if (cmd === "/strategies") {
    const list = listStrategies();
    const lines = [`🎯 <b>Strategies</b>`, fmt.divider()];
    for (const s of list) {
      const mark = s.active ? "●" : "○";
      lines.push(`${mark} <b>${htmlEscape(s.id)}</b> — ${htmlEscape(s.name)}`);
      lines.push(`   SL ${s.stoploss_pct.toFixed(1)}% · trail ${s.trailing ? "on" : "off"} · partTP ${htmlEscape(String(s.partial_tp))} · LLM ${s.use_llm ? "on" : "off"}`);
    }
    lines.push(``, fmt.it("Switch: /strategy <id>"));
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/strategy") {
    const id = parts[1];
    if (!id) {
      const active = getStrategy();
      await sendHTML(`🎯 Active: <b>${active.name}</b> (<code>${active.id}</code>)\nSwitch: /strategy &lt;id&gt;\nList: /strategies`);
      return true;
    }
    if (!STRATEGY_IDS.includes(id)) {
      await sendHTML(`❌ Unknown strategy <code>${id}</code>. Valid: ${STRATEGY_IDS.join(", ")}`);
      return true;
    }
    setActiveStrategy(id);
    const active = getStrategy();
    await sendHTML(`✅ Switched to <b>${active.name}</b> (<code>${id}</code>)\n${active.description}`);
    return true;
  }

  if (cmd === "/stratset") {
    const [, id, key, ...rest] = parts;
    const value = rest.join(" ");
    if (!id || !key || !value) {
      await sendHTML([
        `Usage: <code>/stratset &lt;id&gt; &lt;key&gt; &lt;value&gt;</code>`,
        ``,
        `Example: <code>/stratset sniper stoploss -0.20</code>`,
        ``,
        `Keys: stoploss, trailing_enabled, trailing_offset, trailing_distance,`,
        `partial_tp_enabled, partial_tp_at, partial_tp_sell, use_llm, llm_min_confidence,`,
        `min_mcap_usd, max_mcap_usd, min_holders, maxAllowedFlags`,
      ].join("\n"));
      return true;
    }
    if (!STRATEGY_IDS.includes(id)) {
      await sendHTML(`❌ Unknown strategy <code>${id}</code>. Valid: ${STRATEGY_IDS.join(", ")}`);
      return true;
    }
    const parsed = setStrategyOverride(id, key, value);
    await sendHTML(`✅ <code>${id}.${key} = ${parsed}</code> (hot-applied)`);
    return true;
  }

  if (cmd === "/agent") {
    const mode = (parts[1] || "").toLowerCase();
    if (mode === "on" || mode === "off") {
      const enabled = mode === "on";
      issueSupervisorCommand({ action: "set_power", enabled, source: "telegram" });
      await publishSupervisorState({ desiredRunning: enabled, source: "telegram_command" });
      await sendHTML(`✅ Agent process power <b>${enabled ? "ON" : "OFF"}</b> command queued to supervisor.`);
    } else {
      await sendHTML(`Usage: <code>/agent on</code> or <code>/agent off</code>`);
    }
    return true;
  }

  if (cmd === "/devcheck") {
    const bl = getDevBlacklist();
    if (bl.total === 0) {
      await sendHTML("✅ <b>Dev Blacklist</b> — empty. No devs blacklisted yet.");
    } else {
      const lines = [
        `<b>Dev Blacklist</b> — ${bl.total} entries`,
        `🔴 Critical: ${bl.critical} | 🟠 High: ${bl.high} | 🟡 Medium: ${bl.medium} | ⚪ Low: ${bl.low}`,
        bl.expired > 0 ? `⏰ Expired: ${bl.expired}` : "",
        "",
        ...bl.entries.slice(0, 5).map(e =>
          `${e.tier === "CRITICAL" ? "🔴" : e.tier === "HIGH" ? "🟠" : "🟡"} ${e.creator.slice(0, 10)}... | ${e.rug_count} rug(s) | ${e.reason?.slice(0, 40)}`
        ),
      ];
      await sendHTML(lines.filter(Boolean).join("\n"));
    }
    return true;
  }

  if (cmd === "/dayphase") {
    await sendHTML("🔍 <b>Day Phase Screening...</b>");
    try {
      const { watchlist, stats } = await screenDayPhaseTokens();
      const entryStatus = isWeekendEntryWindow()
        ? "✅ Weekend — entry window OPEN"
        : "⏳ Entry window: Saturday-Sunday";
      const exitStatus = isWeekdayExitWindow()
        ? "📤 Weekday exit window OPEN"
        : "";
      await sendHTML([
        `<b>Day Phase Trade Scan</b>`,
        `Discovered: ${stats.discovered} | Screened: ${stats.screened} | Passed: ${stats.passed}`,
        `High: ${stats.high_confidence} | Medium: ${stats.medium_confidence} | Low: ${stats.low_confidence}`,
        entryStatus,
        exitStatus,
        "",
        ...(watchlist.length > 0
          ? [formatWatchlistForNotification(watchlist, 10)]
          : ["No tokens match day-phase criteria right now."]),
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendHTML(`❌ Day-phase scan failed: ${e.message}`);
    }
    return true;
  }

  if (cmd === "/auto") {
    const mode = (parts[1] || "").toLowerCase();
    if (mode === "on" || mode === "off") {
      const enabled = mode === "on";
      setAutomationEnabled(enabled, "telegram", true);
      await sendHTML(`✅ Automation <b>${enabled ? "ON" : "OFF"}</b> — persisted and applied to runtime.`);
    } else {
      await sendHTML(`Automation is <b>${cronStarted ? "ON" : "OFF"}</b>\nUsage: <code>/auto on</code> or <code>/auto off</code>`);
    }
    return true;
  }

  if (cmd === "/confirm") {
    const mode = (parts[1] || "").toLowerCase();
    if (mode === "on" || mode === "off") {
      config.trading.confirmMode = (mode === "on");
      await sendHTML(`✅ Confirm mode <b>${mode.toUpperCase()}</b> (runtime only — set <code>confirmMode</code> in user-config.json to persist)`);
    } else {
      await sendHTML(`Confirm mode is <b>${config.trading.confirmMode ? "ON" : "OFF"}</b>\nUsage: /confirm on|off`);
    }
    return true;
  }


  if (cmd === "/dailyguard") {
    const mode = (parts[1] || "").toLowerCase();
    if (mode === "on" || mode === "off") {
      config.dailyTradeGuard.enabled = mode === "on";
      await sendHTML(`✅ Daily Guard <b>${mode.toUpperCase()}</b> (runtime).`);
      return true;
    }
    if (["limit", "limits"].includes(mode)) {
      const n = Number(parts[2]);
      if (!Number.isFinite(n) || n <= 0) {
        await sendHTML(`Usage: <code>/dailyguard limit 3</code>`);
        return true;
      }
      config.dailyTradeGuard.maxWinsPerDay = Math.floor(n);
      config.dailyTradeGuard.maxLossesPerDay = Math.floor(n);
      await sendHTML(`✅ Daily Guard limit W/L = <b>${Math.floor(n)}</b> (runtime).`);
      return true;
    }
    if (mode === "win" || mode === "wins" || mode === "loss" || mode === "losses") {
      const n = Number(parts[2]);
      if (!Number.isFinite(n) || n <= 0) {
        await sendHTML(`Usage: <code>/dailyguard win 3</code> atau <code>/dailyguard loss 3</code>`);
        return true;
      }
      if (mode.startsWith("win")) config.dailyTradeGuard.maxWinsPerDay = Math.floor(n);
      else config.dailyTradeGuard.maxLossesPerDay = Math.floor(n);
      await sendHTML(`✅ Daily Guard ${htmlEscape(mode)} = <b>${Math.floor(n)}</b> (runtime).`);
      return true;
    }
    if (mode === "reset") {
      decideDailyTradeGuard("reset", config.dailyTradeGuard);
      await sendHTML(`✅ Daily Guard counters reset for today.`);
      return true;
    }

    const s = getDailyTradeGuardStatus(config.dailyTradeGuard);
    const pending = s.pending_decision
      ? `\nPending: ${htmlEscape(s.pending_decision.threshold)} ${s.pending_decision.count}/${s.pending_decision.limit} · pilih <code>/continue</code> atau <code>/stoptrade</code>`
      : "";
    await sendHTML([
      `🧭 <b>Daily Guard</b> · ${s.enabled ? "ON" : "OFF"}`,
      `Status: <b>${htmlEscape(s.status)}</b>`,
      `Hari ini: W ${s.wins}/${s.max_wins_per_day} · L ${s.losses}/${s.max_losses_per_day}`,
      pending,
      fmt.divider(),
      fmt.it("/dailyguard on|off · /dailyguard limit 3 · /dailyguard win 3 · /dailyguard loss 3 · /dailyguard reset"),
    ].filter(Boolean).join("\n"));
    return true;
  }

  if (cmd === "/continue") {
    const s = decideDailyTradeGuard("continue", config.dailyTradeGuard);
    await sendHTML(`▶️ Daily Guard: lanjut trading hari ini. W ${s.wins}/${s.max_wins_per_day} · L ${s.losses}/${s.max_losses_per_day}`);
    return true;
  }

  if (cmd === "/resetplan") {
    const s = resetTradingPlan();
    await sendHTML([
      `🔄 <b>Trading plan reset</b>`,
      `Target: ${s.target} trades · Progress: 0/${s.target}`,
      isTradingPlanEnabled() ? `Status: aktif` : `Status: ${fmt.it("disabled — aktifkan di user-config.json")}`,
    ].join("\n"));
    return true;
  }

  if (cmd === "/plan") {
    const s = getTradingPlanStatus();
    if (!s.enabled) {
      await sendHTML(`📋 Trading plan <b>disabled</b>. Aktifkan: <code>tradingPlan.enabled: true</code>`);
      return true;
    }
    await sendHTML([
      `📋 <b>Trading Plan</b>`,
      `Progress: ${s.trades_completed}/${s.target} trades (${s.progress_pct}%)`,
      s.session_complete ? `✅ Session selesai! /resetplan untuk mulai baru.` : `Sisa: ${s.remaining} trades`,
    ].join("\n"));
    return true;
  }

  if (cmd === "/stoptrade") {
    const { status, activated } = await stopTradingForDailyGuard("telegram");
    await sendHTML([
      `🧠 <b>Trading dihentikan</b> oleh Daily Guard`,
      `Hari ini: W ${status.wins}/${status.max_wins_per_day} · L ${status.losses}/${status.max_losses_per_day}`,
      `Deep learning: <b>${activated ? "ON" : "sudah aktif"}</b> · ${config.dailyTradeGuard?.learningModeDurationMin || config.pilot.learningModeDurationMin}m`,
    ].join("\n"));
    return true;
  }

  if (cmd === "/pending") {
    const pending = listPendingIntents();
    if (!pending.length) {
      await sendHTML(`📭 ${fmt.it("Tidak ada pending intent")}`);
      return true;
    }
    const lines = [`📋 <b>Pending</b>`, fmt.divider()];
    for (const i of pending) {
      const remainMs = new Date(i.expires_at).getTime() - Date.now();
      const remainMin = Math.max(0, Math.ceil(remainMs / 60000));
      lines.push(
        `#${i.id} · ${htmlEscape(i.type)} · ${fmt.sol(Number(i.args?.amount))} → <code>${htmlEscape(fmt.short(i.args?.token_out, 10))}</code> · ${remainMin}m`,
      );
    }
    lines.push(``, fmt.it("/yes <id> · /no <id>"));
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/no") {
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) { await sendHTML(`Usage: /no &lt;intent_id&gt;`); return true; }
    const intent = getIntent(id);
    if (!intent) { await sendHTML(`❌ Intent #${id} not found.`); return true; }
    if (intent.status !== "pending") { await sendHTML(`⚠️ Intent #${id} already ${intent.status}.`); return true; }
    consumeIntent(id, "rejected", { rejected_by: "telegram" });
    await sendHTML(`🚫 Intent #${id} rejected.`);
    return true;
  }

  if (cmd === "/yes") {
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) { await sendHTML(`Usage: /yes &lt;intent_id&gt;`); return true; }
    await executePendingIntent(id);
    return true;
  }

  if (cmd === "/metrics") {
    const stats = getStats();
    const lines = [`📊 <b>Metrics</b> · uptime ${(stats.session_uptime_ms / 60_000).toFixed(0)}m`];
    for (const [name, s] of Object.entries(stats.series)) {
      if (!s) continue;
      lines.push(
        `${htmlEscape(name)}: n=${s.count} p50=${s.p50?.toFixed(0)}ms ` +
        `p95=${s.p95?.toFixed(0)}ms p99=${s.p99?.toFixed(0)}ms`
      );
    }
    if (Object.keys(stats.counters).length > 0) {
      lines.push("");
      lines.push("<b>Counters</b>");
      for (const [k, v] of Object.entries(stats.counters)) lines.push(`${htmlEscape(k)}: ${v}`);
    }
    await sendHTML(lines.join("\n"));
    await flushMetrics().catch(() => {});
    return true;
  }

  if (cmd === "/kill") {
    tripKillSwitch({ reason: "manual", detail: "tripped via Telegram /kill" });
    await sendHTML("🛑 <b>Kill switch tripped.</b>\nResume with <code>/unkill</code> or delete <code>kill-switch.flag</code>.");
    return true;
  }

  if (cmd === "/unkill") {
    const wasKilled = isKilled();
    resetKillSwitch();
    await sendHTML(wasKilled ? "▶️ Kill switch cleared. Cycles will resume." : "Kill switch was not active.");
    return true;
  }

  if (cmd === "/killstate") {
    const state = readKillState();
    if (!state) await sendHTML("✅ Kill switch <i>not active</i>.");
    else await sendHTML(
      `🛑 <b>Killed</b>\nReason: ${htmlEscape(state.reason)}\nDetail: ${htmlEscape(state.detail || "")}\nSince: ${htmlEscape(state.tripped_at)}`
    );
    return true;
  }

  if (cmd === "/wallets") {
    const wallets = getAllWallets();
    if (!wallets.length || !isMultiWalletEnabled()) {
      const active = getActiveWallet();
      await sendHTML(
        `💼 <b>Wallets</b> · Single-wallet mode\n` +
        (active ? `<code>${htmlEscape(active.address.slice(0, 20))}…</code>` : fmt.it("tidak terkonfigurasi"))
      );
      return true;
    }
    const lines = [`💼 <b>Wallets</b>`, fmt.divider()];
    for (const w of wallets) {
      const icon = w.status === "hot" ? "🟢" : w.status === "cold" ? "🔴" : "⚫";
      const activeTag = w.is_active ? " ← <b>aktif</b>" : "";
      const coldStr = w.status === "cold" && w.cold_until > Date.now()
        ? ` · recover ${Math.ceil((w.cold_until - Date.now()) / 60000)}m`
        : "";
      lines.push(`${icon} ${htmlEscape(w.label)} · ${w.capital_pct}% · err:${w.error_count}${coldStr}${activeTag}`);
      lines.push(`   <code>${htmlEscape(w.address.slice(0, 20))}…</code>`);
    }
    await sendHTML(lines.join("\n"));
    return true;
  }

  return false;
}

/**
 * Execute a previously parked confirm-mode intent.
 * Looks up token info & wallet balance to call trackPosition correctly.
 */
async function executePendingIntent(id) {
  const intent = getIntent(id);
  if (!intent) return sendHTML(`❌ #${id} ${fmt.it("not found")}`);
  if (intent.status !== "pending") return sendHTML(`⚠️ #${id} ${fmt.it("already " + intent.status)}`);
  if (intent.expires_at && Date.now() > new Date(intent.expires_at).getTime()) {
    consumeIntent(id, "expired");
    return sendHTML(`⏰ #${id} ${fmt.it("expired")}`);
  }


  const gate = await checkAllGates("pending-intent");
  if (gate.blocked) {
    return sendHTML("⛔ #" + id + " blocked\n" + fmt.code(gate.reason));
  }


  await sendHTML(`⏳ Eksekusi #${id}…`);
  const { args } = intent;
  let result;
  const swapStartedAt = Date.now();
  try {
    result = await swapToken({ ...args, executionContext: { source: "pending-intent", approvedIntent: true } });
  } catch (e) {
    consumeIntent(id, "failed", { error: e.message });
    recordSwapOutcome({ success: false });
    await recordExecutionQuality({
      walletAddress: args.wallet_address || getActiveWallet()?.address || null,
      provider: "auto",
      mode: args.token_in === "SOL" ? "buy" : "sell",
      split: false,
      marketCondition: getMarketIntelligence().condition,
      slippage: Number(args.slippage || 0),
      success: false,
      latencyMs: Date.now() - swapStartedAt,
    });
    return sendHTML(`❌ #${id} swap failed\n${fmt.code(e.message)}`);
  }

  const succeeded = result?.success || result?.dry_run;
  recordSwapOutcome({ success: !!succeeded });
  await recordExecutionQuality({
    walletAddress: result?.wallet_address || args.wallet_address || getActiveWallet()?.address || null,
    provider: result?.execution_provider || "auto",
    mode: args.token_in === "SOL" ? "buy" : "sell",
    split: !!result?.split_execution,
    marketCondition: getMarketIntelligence().condition,
    slippage: Number(args.slippage || result?.slippage || 0),
    success: !!succeeded,
    latencyMs: Date.now() - swapStartedAt,
  });
  if (!succeeded) {
    consumeIntent(id, "failed", { error: result?.error || "unknown" });
    return sendHTML(`❌ #${id} swap rejected\n${fmt.code(JSON.stringify(result).slice(0, 200))}`);
  }

  // Wire up position tracking the same way the screening LLM path does.
  let symbol = args.token_out?.slice(0, 8) || "TOKEN";
  let initial_value_usd = 0;
  let solPriceUsd = 0;
  try {
    const tokenInfo = await getTokenInfo({ query: args.token_out });
    symbol = tokenInfo?.results?.[0]?.symbol || symbol;
    const balance = await getWalletBalances();
    solPriceUsd = balance?.sol_price || 0;
    // Retry once if sol_price is missing — wallet API can return stale data
    if (!solPriceUsd || solPriceUsd <= 0) {
      const retry = await getWalletBalances();
      solPriceUsd = retry?.sol_price || 0;
    }
    // If STILL missing, log explicit warning — position tracked but PnL will be 0%
    if (!solPriceUsd || solPriceUsd <= 0) {
      log("intent_warn", `solPriceUsd still 0 after retry for #${id} — position PnL will read 0%`);
    }
    initial_value_usd = (args.amount || 0) * solPriceUsd;
  } catch (e) {
    log("intent_warn", `metadata fetch failed for #${id}: ${e.message}`);
  }

  // Await the disk flush: if the bot crashes between swap-success and persist,
  // we'd lose track of the freshly-deployed position. Critical for confirm-mode
  // BUYs where the user explicitly approved a real swap.
  const executions = Array.isArray(result?.executions) && result.executions.length > 0
    ? result.executions
    : [{
        wallet_address: result?.wallet_address || args.wallet_address || getActiveWallet()?.address || null,
        amount: args.amount,
      }];
  for (const exec of executions) {
    const walletAddress = exec.wallet_address || result?.wallet_address || args.wallet_address || getActiveWallet()?.address || null;
    await trackPosition({
      position: args.token_out,
      pool: "jupiter",
      pool_name: symbol,
      amount_sol: exec.amount || 0,
      initial_value_usd: (exec.amount || 0) * solPriceUsd,
      signal_snapshot: {
        mint: args.token_out,
        symbol,
        market_condition: getMarketIntelligence().condition,
        workflow: { verdict: "manual" },
        execution_context: {
          wallet_address: walletAddress,
          provider: result?.execution_provider || "auto",
          slippage: Number(args.slippage || result?.slippage || 0),
        },
      },
      wallet_address: walletAddress,
    });
    if (_rugMonitor) {
      const positionKey = walletAddress ? `${args.token_out}::${walletAddress}` : args.token_out;
      try {
        const meta = await captureEntryMetadata(args.token_out, rugMonitorFetchers);
        const deployerBal = meta.top_holders_snapshot?.find(h => h.wallet === meta.deployer_wallet)?.balance ?? 0;
        _rugMonitor.attachPosition(positionKey, { ...meta, deployer_balance_at_entry: deployerBal });
        log("rug_monitor", `attached ${positionKey} (partial=${meta.partial})`);
      } catch (e) {
        log("rug_monitor", `attach failed for ${positionKey}: ${e.message}`);
      }
    }
  }
  recordTrade(null);
  consumeIntent(id, "executed", { result: result?.hash || result?.signature || "ok" });

  return sendHTML(
    `✅ <b>Intent #${id}</b>\n` +
    `Token: <code>${htmlEscape(symbol)}</code> · ${fmt.sol(Number(args.amount))}`
  );
}

// ─── Gate Checks ──────────────────────────────────────────────

/**
 * Cek semua gate sebelum entry/management.
 * Returns { blocked: boolean, reason: string }
 */
async function checkAllGates(source = "") {
  // 0. Kill switch (highest priority — file-flag persists across restart so
  //    a tripped state isn't bypassed by `npm start`). Manual reset:
  //    `rm kill-switch.flag` or call reset() from a REPL.
  const killState = readKillState();
  if (killState) {
    return {
      blocked: true,
      reason: `KILL_SWITCH: ${killState.reason} — ${killState.detail}`,
    };
  }

  // 1. Rug wave circuit breaker
  const cbStatus = _rugCircuitBreaker.getStatus();
  if (cbStatus.locked) {
    log("rug_circuit_breaker", `Hard lock active — ${cbStatus.resumeInMin}min remaining`);
    return { blocked: true, reason: `RUG_CIRCUIT_BREAKER: ${cbStatus.lockReason} — resume in ${cbStatus.resumeInMin}min` };
  }

  // 2. Session pause (target hit)
  if (config.pilot.enabled) {
    const gate = checkSessionGate();
    if (gate.just_resumed) {
      log("plan", `Session resumed — ${source}`);
      if (telegramEnabled()) {
        const p = getPlanSummary();
        sendHTML(`▶️ <b>Sesi lanjut</b> · Day ${p?.day}/${p?.days_total}`);
      }
    }
    if (gate.paused) {
      log("plan", `Gate: paused (${gate.reason}), ${gate.resume_in_min}min — skip ${source}`);
      return { blocked: true, reason: `TARGET_PAUSE: resume in ${gate.resume_in_min}min` };
    }
  }

  // 2. Learning mode (loss sedang dianalisis)
  const learn = getLearningModeStatus();
  if (learn.just_ended) {
    log("learning", "Learning mode selesai — melanjutkan trading");
    if (telegramEnabled()) sendHTML(`▶️ <b>Learning mode selesai</b>`);
  }
  if (learn.active) {
    // Jalankan analisis LLM sekali jika belum
    if (shouldRunAnalysis()) {
      runLossAnalysis().catch(e => log("learning_error", e.message));
    }
    return { blocked: true, reason: `LEARNING_MODE: resume in ${learn.resume_in_min}min` };
  }


  // 3. Daily trade guard blocks new entries while Telegram decision is pending.
  // Management exits stay allowed so open risk can still be reduced.
  if (["screening", "geyser", "pending-intent", "fast-track"].includes(source)) {
    const guard = isDailyTradeGuardEntryBlocked(config.dailyTradeGuard);
    if (guard.blocked) {
      log("daily_guard", `Gate: ${guard.reason} — skip ${source}`);
      return { blocked: true, reason: guard.reason };
    }
  }

  return { blocked: false };
}

/**
 * Update session P&L dan handle trigger.
 */
async function refreshSessionPnl(totalUsd) {
  if (!config.pilot.enabled) return;
  // Skip P&L update if no wallet configured — avoids false -100% in DRY_RUN/test mode
  if (!process.env.WALLET_PRIVATE_KEY) return;
  // Skip jika nilai wallet invalid — wallet API gagal sering balikin 0,
  // jangan biarkan itu di-interpret sebagai loss 100%.
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
    if (executionMode.isLive) {
      log("plan_warn", `refreshSessionPnl skipped: invalid totalUsd=${totalUsd}`);
    }
    return;
  }
  // Kill-switch drawdown check: anchored to the first valid balance the bot
  // observed this session. setSessionBaseline is idempotent, so re-calling is
  // cheap. reportBalance returns true if it just tripped the switch.
  setSessionBaseline(totalUsd);
  setGauge("wallet_total_usd", totalUsd);
  reportBalance(totalUsd);

  const result = updateSessionCapital(totalUsd);

  if (result.action === "pause_target") {
    const plan = getPlanSummary();
    const logMsg = `Target hit +${result.pnl_pct.toFixed(2)}%, pause ${config.pilot.sessionPauseDurationMin}min`;
    log("plan", logMsg);
    if (telegramEnabled()) {
      const lines = [
        `🎯 <b>Target harian tercapai</b>`,
        `PnL: ${fmt.pct(result.pnl_pct)} (${fmt.usd(result.pnl_usd)})`,
        `Day ${plan?.day}/${plan?.days_total} · pause ${config.pilot.sessionPauseDurationMin}m`,
      ];
      sendHTML(lines.join("\n"));
    }
  } else if (result.action === "trigger_learning") {
    // Aktifkan learning mode
    const balance = await getWalletBalances().catch(() => ({}));
    const lossContext = {
      pnl_pct: result.pnl_pct,
      pnl_usd: result.pnl_usd,
      exit_reason: "DAILY_STOPLOSS",
      market_condition: getMarketIntelligence().condition,
      session_start_usd: getPlanSummary()?.today_start_usd,
    };
    const activated = activateLearningMode(lossContext, "DAILY_STOPLOSS", config.pilot.learningModeDurationMin);
    if (activated) {
      log("plan", `Learning mode triggered — daily SL ${result.pnl_pct.toFixed(2)}%`);
      if (telegramEnabled()) {
        const lines = [
          `🧠 <b>Learning mode</b>`,
          `Daily stop-loss · ${fmt.pct(result.pnl_pct)}`,
          `Pause ${config.pilot.learningModeDurationMin}m · no new entries`,
        ];
        sendHTML(lines.join("\n"));
      }
    }
  }
}

// ─── Loss Analysis (Learning Mode) ────────────────────────────

/**
 * Jalankan analisis LLM untuk mengerti kenapa loss terjadi.
 * Dipanggil sekali selama learning mode aktif.
 */
async function runLossAnalysis() {
  const lossContext = getActiveLossContext();
  if (!lossContext) return;

  markAnalysisRun();
  log("learning", "Menjalankan analisis loss LLM...");

  const recentTrades = getPerformanceHistory({ limit: 5 });
  const marketCond = getMarketIntelligence().condition;
  const prompt = buildLossAnalysisPrompt(lossContext, recentTrades, marketCond);

  try {
    const { content } = await agentLoop(
      prompt,
      8,
      [],
      "GENERAL",
      config.llm.generalModel,
      1024
    );

    const result = recordLossAnalysis({
      lossContext,
      analysisText: stripThink(content),
      marketCondition: marketCond,
    });

    log("learning", `Analisis selesai. ${result.lessons_added} lessons ditambahkan.`);
    if (telegramEnabled()) {
      const body = htmlEscape((stripThink(content) || "").slice(0, 500));
      const lines = [
        `🧠 <b>Analisis loss</b> · ${fmt.pct(lossContext.pnl_pct)}`,
        `Trigger: ${htmlEscape(lossContext.exit_reason || "?")} · ${result.lessons_added} lessons baru`,
        fmt.divider(),
        body,
      ];
      sendHTML(lines.join("\n"));
    }
  } catch (e) {
    log("learning_error", `Analisis LLM gagal: ${e.message}`);
  }
}

/**
 * Jalankan analisis sukses (Profit > 20%).
 */
async function runSuccessAnalysis(tradeContext) {
  log("learning", `Menjalankan analisis sukses: ${tradeContext.symbol}...`);
  const marketCond = getMarketIntelligence().condition;
  const prompt = buildSuccessAnalysisPrompt(tradeContext, marketCond);

  try {
    const { content } = await agentLoop(prompt, 5, [], "GENERAL", config.llm.generalModel, 1024);
    const result = recordLossAnalysis({
      lossContext: tradeContext,
      analysisText: stripThink(content),
      marketCondition: marketCond,
      analysisRole: "SUCCESS_ANALYSIS",
    });
    log("learning", `Analisis sukses selesai. ${result.lessons_added} lessons ditambahkan.`);
  } catch (e) {
    log("learning_error", `Success analysis failed: ${e.message}`);
  }
}

/**
 * Jalankan siklus belajar kontinyu (evaluasi observasi).
 */
export async function runContinuousLearningCycle() {
  log("learning", "Memulai continuous learning cycle...");
  const results = await processObservations();
  
  if (!results || results.length === 0) {
    log("learning", "Tidak ada observasi yang perlu dievaluasi saat ini.");
    return;
  }

  recordObservationOutcomes(results);

  const prompt = buildObservationAnalysisPrompt(results);
  if (!prompt) return;

  try {
    const { content } = await agentLoop(prompt, 5, [], "GENERAL", config.llm.generalModel, 1024);
    const result = recordLossAnalysis({
      lossContext: { exit_reason: "OBSERVATION" },
      analysisText: stripThink(content),
      marketCondition: getMarketIntelligence().condition,
      analysisRole: "OBSERVATION_ANALYSIS",
    });
    
    if (telegramEnabled() && result.lessons_added > 0) {
      const body = htmlEscape((stripThink(content) || "").slice(0, 400));
      const lines = [
        `🧠 <b>Continuous learning</b> · +${result.lessons_added} lessons`,
        fmt.divider(),
        body,
      ];
      sendHTML(lines.join("\n"));
    }
  } catch (e) {
    log("learning_error", `Observation analysis failed: ${e.message}`);
  }
}

// ─── Vault Cycle ──────────────────────────────────────────────

export async function runVaultCycle({ silent = false } = {}) {
  if (!config.vault.walletAddress && !process.env.VAULT_WALLET) {
    if (!silent) log("vault", "Vault wallet tidak dikonfigurasi — skip");
    return null;
  }

  const due = isVaultDue();
  if (!due.due && !due.first_vault) {
    log("vault", `Vault belum jatuh tempo. ${due.days_remaining?.toFixed(1)} hari lagi.`);
    return null;
  }

  log("vault", "Memulai vault cycle...");

  try {
    const balance = await getWalletBalances();
    const { amount_sol, available_sol } = computeVaultAmount(balance.sol);

    if (amount_sol < 0.001) {
      log("vault", `Saldo terlalu kecil untuk vault: ${amount_sol} SOL`);
      return null;
    }

    const result = await executeVaultTransfer(amount_sol, balance.sol_price || 0);

    if (result.success || result.dry_run) {
      if (result.dry_run) recordVaultTransfer(result);
      const msg = buildVaultNotification(result);
      log("vault", `Vault sukses: ${amount_sol} SOL`);
      if (!silent && telegramEnabled()) sendHTML(msg);
    } else {
      log("vault_error", `Vault gagal: ${result.error}`);
      if (!silent && telegramEnabled()) sendHTML(`❌ <b>Vault gagal</b>\n${htmlEscape(result.error || "?")}`);
    }

    return result;
  } catch (e) {
    log("vault_error", e.message);
    return { success: false, error: e.message };
  }
}

// ─── Daily Report Cycle ───────────────────────────────────────

export async function runDailyReport({ silent = false } = {}) {
  if (!config.report.enabled) return null;

  log("report", "Generating laporan harian...");
  try {
    const { report, text, filePath } = generateDailyReport();
    log("report", `Laporan disimpan: ${filePath}`);
    if (!silent && telegramEnabled()) await sendHTML(text);
    else if (!silent) console.log("\n" + text + "\n");
    return report;
  } catch (e) {
    log("report_error", e.message);
    return null;
  }
}

// ─── Individual Trade Loss → Learning Mode ────────────────────

/**
 * Dipanggil setelah setiap trade close dengan hasil loss.
 * Jika loss signifikan, aktifkan learning mode.
 */
function handleTradeLoss({ symbol, mint, pnl_pct, entry_usd, exit_usd, hold_minutes, exit_reason, rug_signals, launchpad, market_condition }) {
  // Cek circuit breaker (consecutive losses) — trigger lebih awal dari -10% threshold
  const maxLosses = config.pilot.maxConsecutiveLosses || 0;
  const consecutive = getConsecutiveLosses();
  const tripped = maxLosses > 0 && consecutive >= maxLosses;

  // Trigger learning jika: stop-loss/hard-cut hit, loss > -5%, atau consecutive tripped.
  // Belajar dari SEMUA loss, bukan hanya yang besar. Loss kecil adalah sinyal awal.
  const isStopOrCut = exit_reason?.includes("Stop Loss") || exit_reason?.includes("Hard Cut") || exit_reason?.includes("stop_loss") || exit_reason?.includes("Trailing Stop");
  if (!tripped && pnl_pct > -5 && !isStopOrCut) return;

  const triggerType = tripped ? "SERIES_LOSS" : "STOP_LOSS";
  const lossContext = {
    symbol, mint, pnl_pct, entry_usd, exit_usd,
    hold_minutes, exit_reason, rug_signals, launchpad, market_condition,
    consecutive_losses: consecutive,
  };

  const activated = activateLearningMode(lossContext, triggerType, config.pilot.learningModeDurationMin);
  if (activated) {
    const reasonStr = tripped
      ? `${consecutive} loss berturut (tilt)`
      : `loss ${pnl_pct?.toFixed(2)}%`;
    log("learning", `Learning mode: ${symbol} ${reasonStr}`);
    if (telegramEnabled()) {
      const subline = tripped
        ? `Streak: ${consecutive}/${maxLosses}`
        : `Reason: ${htmlEscape(exit_reason || "?")}`;
      const lines = [
        `🧠 <b>Learning · ${tripped ? "Tilt protection" : "Trade loss"}</b>`,
        `${htmlEscape(symbol || "?")} (${fmt.short(mint, 8)}) · PnL ${fmt.pct(pnl_pct)} · ${Math.floor(hold_minutes || 0)}m`,
        subline,
        `Pause ${config.pilot.learningModeDurationMin}m`,
      ];
      sendHTML(lines.join("\n")).catch(() => {});
    }
  }
}

// ─── Deterministic Exits ──────────────────────────────────────

async function checkDeterministicExits(tokens) {
  const exits = [];
  const market = getMarketIntelligence();
  const condition = market.condition || "NORMAL";

  // Resolve active strategy once per cycle — its exit params
  // (stoploss, trailing, partial TP) now feed into risk policy.
  const activeStrategy = getStrategy(null, { regime: condition });

  for (const token of tokens) {
    const riskPolicy = buildRiskPolicy({
      marketCondition: condition,
      token,
      config,
      strategyParams: activeStrategy, // wire strategy exit params
    });
    const tracked = getTrackedPosition(token.position_key || token.mint, token.wallet_address || null);
    if (!tracked) continue;

    const ageMinutes = (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000;
    const currentPnlPct = tracked.initial_value_usd > 0
      ? ((token.usd - tracked.initial_value_usd) / tracked.initial_value_usd) * 100
      : 0;
    const currentPrice = Number(
      token?.priceUsd
      ?? token?.price_usd
      ?? token?.price
      ?? (token?.balance > 0 ? token.usd / token.balance : 0)
    );
    const entryPrice = Number(
      tracked?.entry_price
      ?? tracked?.lastKnownPrice
      ?? tracked?.signal_snapshot?.entry_price
      ?? tracked?.signal_snapshot?.priceUsd
      ?? tracked?.signal_snapshot?.price_usd
      ?? tracked?.signal_snapshot?.price
      ?? 0
    );
    if (currentPrice > 0 && entryPrice > 0) {
      const dropped = checkPriceDrop(
        { ...tracked, mint: token.mint, entry_price: entryPrice },
        currentPrice,
        (mint, reason, detail) => {
          log("exit_signal", `Price drop signal: ${mint.slice(0, 8)} — ${reason}: ${detail}`);
          if (telegramEnabled()) {
            sendHTML(`⚠️ <b>Price Drop Alert</b>\nMint: <code>${mint.slice(0, 8)}</code>\n${detail}`).catch(() => {});
          }
        }
      );
      if (dropped) {
        log("exit_signal", `Emergency price drop detected for ${token?.mint?.slice(0, 8)}`);
      }
    }

    // Persist the new peak — mutating `tracked` in memory isn't enough because
    // a restart wipes the cache and resets the trailing-stop reference to 0.
    if (currentPnlPct > (tracked.peak_pnl_pct || 0)) {
      tracked.peak_pnl_pct = currentPnlPct;
      updatePeakPnl(token.position_key || token.mint, currentPnlPct, token.wallet_address || null);
    }

    // Rug monitor (onHigh callback) sets this flag when a HIGH-severity signal fires.
    // Must be checked here so the position actually gets sold — the flag alone does nothing.
    if (tracked.rug_force_exit) {
      exits.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: tracked.rug_force_exit_reason || "rug_force_exit",
        pnl_pct: currentPnlPct,
        is_loss: currentPnlPct < 0,
        wallet_address: token.wallet_address || null,
        position_key: token.position_key || token.mint,
      });
      continue;
    }

    const exitPolicy = evaluateExitPolicy({
      pnlPct: currentPnlPct,
      peakPnlPct: tracked.peak_pnl_pct || 0,
      policy: riskPolicy,
    });

    if (exitPolicy.hardCutLoss) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.hardCutLossReason, pnl_pct: currentPnlPct, is_loss: true, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint });
      continue;
    }
    if (exitPolicy.hardStopLoss) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.hardStopLossReason, pnl_pct: currentPnlPct, is_loss: true, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint });
      continue;
    }
    // Immediate take-profit override (hybrid mode): policy takeProfitPct triggers any time
    if (exitPolicy.takeProfit) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.takeProfitReason, pnl_pct: currentPnlPct, is_loss: false, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint });
      continue;
    }

    // Partial TP: sell a fraction once when PnL crosses threshold, keep the rest running.
    const partial = checkPartialTP(currentPnlPct, tracked.partial_tp_done === true);
    if (partial.trigger && token.balance > 0) {
      const posKey = token.position_key || token.mint;
      if (isPartialTPLanded(posKey)) {
        log("strategy", `PARTIAL TP skipped — already landed for ${token.symbol}`);
        continue;
      }
      const sellAmount = token.balance * (partial.sell_pct / 100);
      log("strategy", `PARTIAL TP: ${token.symbol} — ${partial.reason}`);
      const partialStartAt = Date.now();
      const { result: partialRes, attempt: partialAttempt, stuck: partialStuck } = await withProgressiveSlippage(
        (slippage) => swapToken({
          token_in: token.mint, token_out: "SOL",
          amount: sellAmount, slippage,
          wallet: token.wallet_address ? getWalletByAddress(token.wallet_address)?.keypair || null : null,
        })
      );
      await recordExecutionQuality({
        walletAddress: token.wallet_address || null,
        provider: partialRes?.execution_provider || "auto",
        mode: "sell",
        split: false,
        marketCondition: getMarketIntelligence().condition,
        slippage: getExitSlippage(partialAttempt),
        success: !!(partialRes.success || partialRes.dry_run),
        latencyMs: Date.now() - partialStartAt,
      });
      if (partialRes.success || partialRes.dry_run) {
        await markPartialTPLanded(posKey);
        markPartialTPDone(token.position_key || token.mint, token.wallet_address || null);
        if (telegramEnabled()) {
          sendHTML(
            `💰 <b>Partial TP</b> · ${htmlEscape(token.symbol || "?")}\n` +
            `Sold ${partial.sell_pct}% @ ${fmt.pct(currentPnlPct)}`
          ).catch(() => {});
        }
      } else if (partialStuck) {
        log("strategy", `PARTIAL TP STUCK for ${token.symbol}: all ${partialAttempt} exit attempts failed`);
        if (telegramEnabled()) {
          sendHTML(
            `⚠️ <b>POSITION STUCK</b>: ${htmlEscape(token.symbol || "?")} — partial TP exit failed after ${partialAttempt} attempts. Manual intervention needed.`
          ).catch(() => {});
        }
      } else {
        log("strategy", `PARTIAL TP swap failed for ${token.symbol}: ${partialRes.error || "?"}`);
      }
      // Position stays open with reduced size — let other exit checks below
      // run on subsequent cycles, not this one.
      continue;
    }

    const roiCheck = checkROI(ageMinutes, currentPnlPct, condition);
    if (roiCheck.exit) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: roiCheck.reason, pnl_pct: currentPnlPct, is_loss: currentPnlPct < 0, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint });
      continue;
    }
    if (exitPolicy.trailingStop) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.trailingStopReason, pnl_pct: currentPnlPct, is_loss: false, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint });
    }
  }
  return exits;
}

// ─── Staged Entry Check ───────────────────────────────────────

/**
 * Check all open positions for pending staged entry triggers.
 * Runs every management cycle. When a stage triggers, execute
 * the swap and update the position's avg entry price.
 */
async function checkStagedEntries(tokens, balance) {
  const stagedBuys = [];
  const solPrice = balance?.sol_price || 0;

  for (const token of tokens) {
    const tracked = getTrackedPosition(token.position_key || token.mint, token.wallet_address || null);
    if (!tracked) continue;

    const staged = tracked?.signal_snapshot?.staged_entry;
    if (!staged?.enabled) continue;
    if (staged.completed_stages >= staged.stages) continue;

    const currentPnlPct = tracked.initial_value_usd > 0
      ? ((token.usd - tracked.initial_value_usd) / tracked.initial_value_usd) * 100
      : 0;
    const currentPrice = token?.priceUsd || token?.price_usd || (token?.balance > 0 ? token.usd / token.balance : 0);
    const ageMinutes = (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000;

    const trigger = checkStagedEntryTrigger(staged, currentPnlPct, currentPrice, ageMinutes);

    if (trigger.trigger && trigger.next_amount_sol > 0) {
      stagedBuys.push({
        mint: token.mint,
        symbol: token.symbol,
        position_key: token.position_key || token.mint,
        wallet_address: token.wallet_address || null,
        amount_sol: trigger.next_amount_sol,
        reason: trigger.reason,
        staged,
        tracked,
        currentPrice,
      });
    }
  }

  // Execute staged buys
  for (const buy of stagedBuys) {
    log("staged_entry", `${buy.symbol}: Stage ${buy.staged.next_stage}/${buy.staged.stages} triggered — ${buy.reason}. Buying ${buy.amount_sol.toFixed(4)} SOL`);
    try {
      const { result: res } = await withProgressiveSlippage(
        (slippage) => swapToken({
          token_in: "SOL",
          token_out: buy.mint,
          amount: buy.amount_sol,
          slippage,
          wallet: buy.wallet_address ? getWalletByAddress(buy.wallet_address)?.keypair || null : null,
        })
      );

      if (res?.success || res?.dry_run) {
        // Update staged entry tracking
        const updated = advanceStagedEntry(buy.staged, buy.currentPrice);
        buy.tracked.signal_snapshot.staged_entry = updated;

        // Update position: add SOL amount, recompute avg entry value
        const oldAmount = buy.tracked.amount_sol || 0;
        const oldValue = buy.tracked.initial_value_usd || 0;
        const newAmount = oldAmount + buy.amount_sol;
        const newValue = oldValue + (buy.amount_sol * solPrice);
        buy.tracked.amount_sol = newAmount;
        buy.tracked.initial_value_usd = newValue;

        // Persist updated position
        await trackPosition({
          position: buy.mint,
          pool: buy.tracked.pool || "jupiter",
          pool_name: buy.symbol,
          amount_sol: newAmount,
          initial_value_usd: newValue,
          signal_snapshot: buy.tracked.signal_snapshot,
          wallet_address: buy.wallet_address,
        });

        recordCounter("swaps_executed");
        log("staged_entry", `${buy.symbol}: Stage ${updated.completed_stages}/${updated.stages} complete. Avg entry: $${updated.avg_entry_price_usd?.toFixed(6)}. Total SOL: ${newAmount.toFixed(4)}`);

        if (telegramEnabled()) {
          sendHTML(
            `📥 <b>Staged Entry</b> · ${htmlEscape(buy.symbol || "?")}\n` +
            `Stage ${updated.completed_stages}/${updated.stages} · +${buy.amount_sol.toFixed(3)} SOL\n` +
            `Avg entry: $${updated.avg_entry_price_usd?.toFixed(6)}\n` +
            `Total: ${newAmount.toFixed(4)} SOL`
          ).catch(() => {});
        }
      } else {
        log("staged_entry_warn", `${buy.symbol}: Stage ${buy.staged.next_stage} swap failed — ${res?.error || "unknown"}. Will retry next cycle.`);
      }
    } catch (e) {
      log("staged_entry_error", `${buy.symbol}: Stage swap error: ${e.message}`);
    }
  }

  return stagedBuys;
}

// ─── Management Cycle ─────────────────────────────────────────

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;

  const gate = await checkAllGates("management");
  if (gate.blocked) { _managementBusy = false; return gate.reason; }

  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let liveMessage = null;
  const _cycleStart = startTimer();

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management", "Evaluating positions...");
    }

    const balance = await getPortfolioSnapshot();
    const tokens = (balance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    // Refresh session P&L
    const totalUsd = (balance.sol_usd || 0) + tokens.reduce((s, t) => s + (t.usd || 0), 0);
    await refreshSessionPnl(totalUsd);

    syncOpenPositions(tokens.map(t => t.position_key || t.mint));

    if (tokens.length === 0) {
      mgmtReport = "No open token positions.";
      return mgmtReport;
    }

    // ─── Step 1: Staged entries (DCA buys) ───────
    // Check BEFORE exits — don't exit a position that's about to get a staged buy
    const stagedBuys = await checkStagedEntries(tokens, balance);

    // ─── Step 2: Deterministic exits ─────────────
    const deterministicExits = await checkDeterministicExits(tokens);
    for (const exit of deterministicExits) {
      log("strategy", `EXIT: ${exit.symbol} — ${exit.reason}`);
      const tokenData = tokens.find(t => (t.position_key || t.mint) === (exit.position_key || exit.mint));
      const exitStartAt = Date.now();
      const { result: res, attempt: exitAttempt, stuck: exitStuck } = await withProgressiveSlippage(
        (slippage) => swapToken({
          token_in: exit.mint, token_out: "SOL",
          amount: tokenData?.balance, slippage,
          wallet: exit.wallet_address ? getWalletByAddress(exit.wallet_address)?.keypair || null : null,
        })
      );
      recordSwapOutcome({ success: !!(res.success || res.dry_run) });
      await recordExecutionQuality({
        walletAddress: exit.wallet_address || null,
        provider: res?.execution_provider || "auto",
        mode: "sell",
        split: false,
        marketCondition: getMarketIntelligence().condition,
        slippage: getExitSlippage(exitAttempt),
        success: !!(res.success || res.dry_run),
        latencyMs: Date.now() - exitStartAt,
      });
      if (exitStuck) {
        log("strategy", `EXIT STUCK: ${exit.symbol} — all ${exitAttempt} exit attempts failed`);
        if (telegramEnabled()) {
          sendHTML(
            `⚠️ <b>POSITION STUCK</b>: ${htmlEscape(exit.symbol || "?")} — exit failed after ${exitAttempt} attempts. Manual intervention needed.`
          ).catch(() => {});
        }
        continue;
      }
      if (res.success || res.dry_run) {
        // Await close-flush: a crash before this lands on disk means the next
        // management cycle would re-attempt the exit on a position already
        // sold, hitting Jupiter with zero balance. Cheap insurance.
        await recordClose(exit.position_key || exit.mint, exit.reason, exit.wallet_address || null);
        _rugMonitor?.detachPosition(exit.position_key || exit.mint);
        await clearPartialTPGuard(exit.position_key || exit.mint);
        recordRuggedNarrativesForExit({ reason: exit.reason, token: tokenData || {} });
        const tradePnl = exit.pnl_pct || 0;
        recordTrade(!exit.is_loss);
        await handleDailyTradeGuardOutcome(!exit.is_loss, {
          symbol: exit.symbol,
          mint: exit.mint,
          pnl_pct: tradePnl,
          exit_reason: exit.reason,
        });
        recordCounter("swaps_executed");

        if (/rug/i.test(exit.reason)) {
          const cb = _rugCircuitBreaker.recordExit(exit.mint, exit.reason);
          if (cb.tripped && telegramEnabled()) {
            const s = _rugCircuitBreaker.getStatus();
            sendHTML(
              `🚨 <b>RUG CIRCUIT BREAKER TRIPPED</b>\n` +
              `${s.recentCount} rug exits in ${Math.round(s.windowMs / 60000)}min\n` +
              `Hard lock: <b>${s.resumeInMin}min</b> — no new entries`
            ).catch(() => {});
          }
        }

        // Record performance
        const tracked = getTrackedPosition(exit.position_key || exit.mint, exit.wallet_address || null);
        const holdMinutes = tracked ? (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000 : 0;
        const executionQuality = getExecutionQualityAssessment({
          walletAddress: exit.wallet_address || tracked?.wallet_address || null,
          provider: res?.execution_provider || tracked?.signal_snapshot?.execution_context?.provider || "auto",
          mode: "sell",
          split: false,
          marketCondition: tokenData?.market_condition || getMarketIntelligence().condition,
          slippage: Number(tracked?.signal_snapshot?.execution_context?.slippage || 1.0),
        });
        const attribution = assessTradeAttribution({
          tracked,
          exit: {
            ...exit,
            hold_minutes: holdMinutes,
            exit_reason: exit.reason,
          },
          tokenData,
          executionQuality,
        });
        const exitSolReceived = res?.amount_out != null ? Number(res.amount_out) / 1e9 : null;
        const entrySolSpent = tracked?.amount_sol ?? null;
        const swapFeeSol = res?.tx_fee_lamports != null ? Number(res.tx_fee_lamports) / 1e9 : null;
        const realizedPnlPct = entrySolSpent > 0 && exitSolReceived != null
          ? ((exitSolReceived - entrySolSpent) / entrySolSpent) * 100
          : null;
        recordTradeOutcome({
          mint: exit.mint,
          symbol: exit.symbol,
          entry_usd: tracked?.initial_value_usd,
          exit_usd: tokenData?.usd,
          pnl_pct: tradePnl,
          hold_minutes: holdMinutes,
          exit_reason: exit.reason,
          rug_detected: /rug/i.test(exit.reason),
          attribution,
          entry_sol: entrySolSpent,
          exit_sol: exitSolReceived,
          swap_fee_sol: swapFeeSol,
          actual_realized_pct: realizedPnlPct,
        });
        await recordTradeAttribution({
          mint: exit.mint,
          symbol: exit.symbol,
          pnl_pct: tradePnl,
          hold_minutes: holdMinutes,
          exit_reason: exit.reason,
          ...attribution,
        });
        recordTradeConvictionOutcome({
          mint: exit.mint,
          symbol: exit.symbol,
          pnl_pct: tradePnl,
          exit_reason: exit.reason,
        });
        // Cumulative PnL tracking
        const tradeUsdDelta = (tracked?.initial_value_usd || 0) > 0
          ? (tracked.initial_value_usd * tradePnl) / 100
          : (tokenData?.usd || 0) - (tracked?.initial_value_usd || 0);
        recordCumulativePnl(tradeUsdDelta);
        await recordRegimeTradeOutcome({
          marketCondition: tokenData?.market_condition || getMarketIntelligence().condition,
          tier: tokenData?.tier_execution?.tier || tokenData?.tier?.label || "UNKNOWN",
          narrative: tokenData?.conviction?.narrative_cluster?.narrative || (Array.isArray(tokenData?.narrative_tags) ? (typeof tokenData.narrative_tags[0] === "string" ? tokenData.narrative_tags[0] : tokenData.narrative_tags[0]?.narrative) : null) || "OTHER",
          verdict: tracked?.signal_snapshot?.workflow?.verdict || "active",
          pnl_pct: tradePnl,
        });

        const tpTriggered = /immediate tp|roi|trailing stop/i.test(exit.reason || "") && (exit.pnl_pct || 0) >= (config.management.autoTakeProfitPct ?? 50);
        if (tpTriggered) {
          const cooldownHours = config.management.antiGreedCooldownHours ?? 12;
          await setTokenCooldown(exit.mint, cooldownHours, "auto_tp");
          const profitSweep = computeProfitSweepAmount(
            Math.max(0, (tokenData?.usd || 0) - (tracked?.initial_value_usd || 0)),
            balance.sol_price || 0
          );
          if (profitSweep.amount_sol > 0) {
            const sweepResult = await executeVaultTransfer(profitSweep.amount_sol, balance.sol_price || 0);
            if (sweepResult.dry_run) {
              recordVaultTransfer({
                amount_sol: sweepResult.amount_sol,
                amount_usd: sweepResult.amount_usd,
                tx: sweepResult.tx,
                vault_wallet: sweepResult.vault_wallet,
              });
            }
          }
        }

        // Auto-sweep trigger: check vault due after every trade close
        if (!tpTriggered) {
          const vaultCheck = isVaultDue();
          if (vaultCheck.due) {
            runVaultCycle({ silent: true }).catch(e => log("vault_error", `post-trade vault: ${e.message}`));
          }
        }

        // Trading plan: record trade completion
        recordTradingPlanTrade({ symbol: exit.symbol, mint: exit.mint, pnl_pct: tradePnl });

        // Feed narrative engine — credit/penalize the narrative(s) this trade belongs to
        try {
          recordNarrativeOutcome({
            symbol: exit.symbol,
            name: tracked?.pool_name,
            pnl_pct: tradePnl,
          });
        } catch (e) { log("narrative_error", e.message); }

        // Update lesson effectiveness if lessons were tracked during entry
        if (tracked?.active_lessons?.length > 0) {
          recordLessonOutcome(tracked.active_lessons, tradePnl);
        }

        // Update Darwin signal weights if signals were tracked
        if (tracked?.active_signals?.length > 0) {
          updateDarwinWeights(tracked.active_signals, tradePnl, config.darwin);
        }

        // Trigger learning mode jika loss
        if (config.pilot.enabled && exit.is_loss) {
          handleTradeLoss({
            symbol: exit.symbol, mint: exit.mint,
            pnl_pct: tradePnl,
            entry_usd: tracked?.initial_value_usd,
            exit_usd: tokenData?.usd,
            hold_minutes: tracked ? (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000 : 0,
            exit_reason: exit.reason,
            market_condition: getMarketIntelligence().condition,
          });
        } else if (config.pilot.enabled && (exit.pnl_pct || 0) >= 20) {
          // Success analysis for big wins
          runSuccessAnalysis({
            symbol: exit.symbol, mint: exit.mint,
            pnl_pct: tradePnl,
            hold_minutes: tracked ? (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000 : 0,
            exit_reason: exit.reason,
          }).catch(e => log("learning_error", e.message));
        }

        if (telegramEnabled()) {
          const isRug = /rug/i.test(exit.reason);
          const icon = isRug ? "☠️" : exit.is_loss ? "🛑" : "🎯";
          const lines = [
            `${icon} <b>${isRug ? "RUG EXIT" : "Exit"}</b> · ${htmlEscape(exit.symbol || "?")}`,
            `PnL: ${fmt.pct(exit.pnl_pct)}`,
            fmt.it(exit.reason),
          ];
          sendHTML(lines.join("\n"));
        }
      } else {
        log("swap_error", `EXIT failed for ${exit.symbol}: ${res.error || "unknown error"}`);
      }
    }

    // ─── Step 2: LLM management ──────────────────
    const remainingBalance = await getPortfolioSnapshot();
    const remainingTokens = (remainingBalance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    if (remainingTokens.length > 0) {
      const planSummary = getPlanSummary();
      const { content } = await agentLoop(`
MANAGEMENT CYCLE
Tokens held: ${JSON.stringify(remainingTokens)}
${planSummary ? `Plan: Day ${planSummary.day} | P&L: ${planSummary.today_pnl_pct}% | Profit Mode: ${planSummary.profit_mode}` : ""}

Review holdings. Exit jika ada rug signal atau trend reversal berat.
ROI/Trailing/StopLoss ditangani otomatis — fokus ke kualiatif saja.
      `, config.llm.managerMaxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result }) => {
          await liveMessage?.toolFinish(name, result, !result?.error);
          if (name === "swap_token") {
            recordSwapOutcome({ success: !!(result?.success || result?.dry_run) });
          }
          if (name === "swap_token" && (result.success || result.dry_run)) {
            const tokenOut = result.token_out || result.would_swap?.token_out;
            const tokenIn = result.token_in || result.would_swap?.token_in;
            const walletAddress = result.wallet_address || result.would_swap?.wallet_address || null;
            if (tokenOut === "SOL" || tokenOut === "So11111111111111111111111111111111111111112") {
              const llmPosKey = walletAddress ? `${tokenIn}::${walletAddress}` : tokenIn;
              await recordClose(tokenIn, "LLM Manager Decision", walletAddress);
              _rugMonitor?.detachPosition(llmPosKey);
              await clearPartialTPGuard(llmPosKey);
              recordRuggedNarrativesForExit({ reason: "LLM Manager Decision", token: {} });
              recordTrade(true); // assume LLM exits for profit
              await handleDailyTradeGuardOutcome(true, {
                mint: tokenIn,
                symbol: tokenIn?.slice(0, 8),
                exit_reason: "LLM Manager Decision",
              });
            }
          }
        },
      });
      mgmtReport = content;
    } else {
      mgmtReport = deterministicExits.length > 0 ? `Closed ${deterministicExits.length} via Strategy.` : "All positions managed.";
    }
  } catch (e) {
    log("cron_error", e.message);
    mgmtReport = `Error: ${e.message}`;
    recordError("management_cycle");
  } finally {
    _managementBusy = false;
    recordLatency("management_cycle", elapsedMs(_cycleStart));
    if (!silent && telegramEnabled() && mgmtReport) {
      const body = stripThink(mgmtReport);
      if (liveMessage) await liveMessage.finalize(body);
      else sendHTML(`🔄 <b>Mgmt</b>\n${htmlEscape(body)}`);
    }
  }
  return mgmtReport;
}

// ─── Screening Cycle ──────────────────────────────────────────

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) return null;
  _screeningBusy = true;

  if (isSessionComplete()) {
    _screeningBusy = false;
    const s = getTradingPlanStatus();
    log("trading_plan", `Session complete: ${s.trades_completed}/${s.target} trades. Screening blocked. /resetplan to restart.`);
    return `Trading plan selesai (${s.trades_completed}/${s.target}). /resetplan untuk mulai sesi baru.`;
  }

  const gate = await checkAllGates("screening");
  if (gate.blocked) { _screeningBusy = false; return gate.reason; }

  timers.screeningLastRun = Date.now();
  log("cron", "Starting screening cycle");
  let screenReport = null;
  let liveMessage = null;
  const _cycleStart = startTimer();

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔍 Screening", "Scanning alpha...");
    }

    const balance = await getPortfolioSnapshot();
    const openTokens = (balance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    // ─── Profit-aware position limit ──────────────
    // Strategy presets don't carry a `protections` block — fall back to
    // config.risk.maxPositions (default 3) as the base cap.
    const baseMaxPositions = strategy?.protections?.max_open_trades
      ?? config.risk?.maxPositions
      ?? 3;
    const heatmapMax = getHeatmapMaxPositions(baseMaxPositions);
    const effectiveMax = Math.min(baseMaxPositions, heatmapMax);
    const positionLimit = config.pilot.enabled
      ? getDynamicPositionLimit(effectiveMax)
      : effectiveMax;

    if (openTokens.length >= positionLimit) {
      const profitMode = isInProfitMode();
      log("protection", `Max positions: ${openTokens.length}/${positionLimit}${profitMode ? " (profit mode)" : ""}`);
      _screeningBusy = false;
      return `Max positions reached (${openTokens.length}/${positionLimit})`;
    }

    const bankrollSol = balance.sol || 0;
    const totalExposedSol = Object.values(getState()?.positions || {})
      .filter(p => !p?.closed)
      .reduce((sum, p) => sum + (p.amount_sol || 0), 0);
    const maxPortfolioExposureFraction = config.risk?.maxPortfolioExposureFraction ?? 0.35;
    if (bankrollSol > 0 && totalExposedSol / bankrollSol >= maxPortfolioExposureFraction) {
      log("screening", `Portfolio exposure cap reached (${(totalExposedSol / bankrollSol * 100).toFixed(1)}% >= ${maxPortfolioExposureFraction * 100}%)`);
      return; // skip this screening cycle
    }

    const recentTrades = getPerformanceHistory({ limit: 30 });
    const activeWallet = getActiveWallet();
    const walletSol = isMultiWalletEnabled() && activeWallet
      ? getWalletCapitalSol(activeWallet.address, balance.sol)
      : balance.sol;
    const deployAmount = computeDeployAmount(walletSol, { solPriceUsd: balance.sol_price });
    const walletPlanSummary = buildCapitalAwareWalletPlan(
      balance.sol,
      deployAmount,
      Math.min(config.fastTrack.maxNewPerCycle ?? 1, config.multiWallet?.maxWalletsPerBatch ?? 2)
    );
    const gasFee = await getSolanaGasFee();
    const entryBlockedByFee = shouldSkipEntriesForGasFee(gasFee);
    if (entryBlockedByFee) {
      log("fee_guard", `Fee level extreme (${gasFee.median} micro-lamports) — skip entry this cycle`);
    }
    const discovery = await discoverTokens({ timeframe: "1m" });
    const candidates = discovery.tokens || [];
    const cappedCandidates = candidates.slice(0, MAX_CANDIDATES_PER_CYCLE);
    if (candidates.length > MAX_CANDIDATES_PER_CYCLE) {
      log("screening", `Capping candidates ${candidates.length} -> ${MAX_CANDIDATES_PER_CYCLE} to avoid API burst`);
    }

    // ─── Market intelligence ─────────────────────
    const marketSnap = await recordMarketSnapshot(cappedCandidates);
    const marketIntel = getMarketIntelligence();
    const heatmap = computeMarketRegime();
    log("market", `Market: ${marketIntel.condition} (confidence: ${marketSnap.confidence}) → heatmap ${heatmap.regime} maxPos=${heatmap.max_positions}`);
    enrichMarketResearchWithAgentRouter({ marketIntel, candidates: cappedCandidates })
      .catch(e => log("market_research_error", e.message));

    if (marketIntel.condition === "DEAD") {
      _screeningBusy = false;
      return "Market DEAD — skip entries";
    }

    // Auto market adaptation now only informs ranking/notes; it must not
    // mutate live screening config in-place.
    const marketAdjustments = config.pilot.autoAdaptToMarket
      ? getRecommendedAdjustments(marketIntel.condition)
      : null;
    if (marketAdjustments?.skip_entry) {
      _screeningBusy = false;
      return `Market adaptation recommends skip_entry for ${marketIntel.condition}`;
    }

    // ─── Filter + Rug Memory ─────────────────────
    const narrativeFiltered = filterNarrativeContagion(cappedCandidates);
    if (narrativeFiltered.length < cappedCandidates.length) {
      log("screening", `Narrative contagion: removed ${cappedCandidates.length - narrativeFiltered.length}/${cappedCandidates.length} candidates`);
    }

    // ─── Layer 0: Pre-Screening Trash Filter ─────
    // Zero-API-cost checks using DexScreener data only.
    // Reject obvious trash/honeypot BEFORE spending Helius credits.
    const rugMemory = getRugMemory();
    const recentRugs = getPerformanceHistory({ limit: 20 }).filter(t => t.rug_detected);
    const preScreenResult = preScreenBatch(narrativeFiltered, { rugMemory, recentRugs });
    const preScreened = preScreenResult.passed;
    if (preScreenResult.stats.blocked > 0) {
      log("screening", `Trash filter blocked ${preScreenResult.stats.blocked}/${narrativeFiltered.length} — saved API calls`);
    }

    // ─── Feature Health Maintenance ──────────────
    autoResetBreakers({ maxAgeMs: 10 * 60 * 1000 });

    // ─── Narrative Velocity Detection ─────────────
    const narrativeVelocity = detectNarrativeVelocity(cappedCandidates);
    if (narrativeVelocity.trendingNarratives.length > 0) {
      log("narrative", `Velocity trending: ${narrativeVelocity.trendingNarratives.join(", ")}`);
    }
    // Persist velocity across cycles so sustained narratives gain compound momentum
    trackCrossBatchVelocity(narrativeVelocity);
    const crossBatchVelocity = getCrossBatchVelocity();

    const scoredCandidates = [];
    const batchTokens = [];
    for (const token of preScreened.slice(0, 8)) {
      if (isTokenBlacklisted(token.mint)) continue;
      if (await isTokenOnCooldown(token.mint)) continue;
      if (token.creator && isDevBlocked(token.creator)) continue;
      batchTokens.push(token);
    }

    // ─── Parallel API fetch phase ──────────────────
    const apiResults = await Promise.all(
      batchTokens.map(async (token) => {
        const [security, tokenInfo, rugCheck] = await Promise.allSettled([
          getTokenSecurityDetails({ mint: token.mint }),
          getTokenInfo({ query: token.mint }).catch(e => ({ error: e.message })),
          getRugCheckReport(token.mint), // FREE — RugCheck API
        ]);
        return {
          token,
          security: security.status === "fulfilled" ? security.value : { error: security.reason?.message },
          tokenInfo: tokenInfo.status === "fulfilled" ? tokenInfo.value : { error: tokenInfo.reason?.message },
          rugCheck: rugCheck.status === "fulfilled" ? rugCheck.value : { error: rugCheck.reason?.message },
        };
      })
    );

    for (const { token, security, tokenInfo, rugCheck } of apiResults) {
      if (security?.error) {
        log("filter", `${token.symbol}: SKIP — security fetch failed: ${security.error}`);
        continue;
      }
      // ── RugCheck integration: convert RugCheck report → Ponyou signals
      const rugCheckSignals = rugCheck?.indexed ? rugCheckToSignals(rugCheck) : {};

      // ── Dev blacklist check (market-cap-aware)
      const creatorAddr = token.creator || security?.security?.creator || null;
      const devBl = checkDevBlacklist(creatorAddr);
      if (devBl.blocked) {
        log("dev_blacklist", `${token.symbol}: BLOCKED — dev ${creatorAddr?.slice(0, 10)} is ${devBl.tier} blacklisted (${devBl.entry?.reason})`);
        continue;
      }
      // Flagged devs add to rug score
      let devBlBonus = 0;
      if (devBl.flagged) {
        devBlBonus = devBl.tier === "MEDIUM" ? 12 : 6;
      }

      const rugRisk = scoreRugRisk({
        mint: token.mint,
        creator: creatorAddr,
        launchpad: token.launchpad,
        mcap: token.mcap || 0,
        rug_signals: {
          ...(security?.rug_signals || {}),
          _trash_flags: token._trash_flags || [],
          ...rugCheckSignals,                               // RugCheck enrichment
          _dev_blacklist_tier: devBl.tier,                  // dev blacklist context
        },
      });

      // Add dev blacklist penalty AFTER scoreRugRisk (separate concern)
      if (devBlBonus > 0) {
        rugRisk.score = Math.min(100, rugRisk.score + devBlBonus);
        rugRisk.reasons.push(`Dev ${devBl.tier} blacklisted (${devBl.entry?.rug_count || 1} rugs, +${devBlBonus})`);
      }

      // ─── Anomaly Detection (embedding similarity) ────
      // Compare token feature vector against all known rugs.
      // Catches novel patterns that don't exact-match any fingerprint.
      let anomalyResult = null;
      if (rugRisk.score < 60 && hasAnyActiveFlag(security?.rug_signals || {})) {
        anomalyResult = detectAnomaly(security?.rug_signals || {});
        if (anomalyResult.anomaly_detected) {
          log("rug_anomaly", `${token.symbol}: ANOMALY ${anomalyResult.anomaly_score}/100 — similar to ${anomalyResult.closest_matches?.map(m => m.symbol).join(", ")}`);
          // Anomaly boost: push rug score up based on similarity
          const anomalyBoost = Math.round(anomalyResult.anomaly_score * 0.25);
          rugRisk.score = Math.min(100, rugRisk.score + anomalyBoost);
          if (anomalyBoost >= 8) {
            rugRisk.reasons.push(`Anomaly: ${anomalyResult.anomaly_score}% similarity to ${anomalyResult.closest_matches?.length || 0} known rugs (+${anomalyBoost})`);
          }
        }
      }

      // ─── LLM Analysis for ambiguous tokens ────────────
      // Tokens with rug score 25-55 are ambiguous — not clearly
      // safe, not clearly a rug. Ask the LLM for a second opinion.
      if (rugRisk.score >= 25 && rugRisk.score < 60) {
        const rugCorpusSize = anomalyResult?.rug_corpus_size ?? 0;
        const llmAnalysis = await analyzeRugWithLLM(token, security?.rug_signals || {}, anomalyResult, rugCorpusSize);
        if (!llmAnalysis.skipped && llmAnalysis.adjustment !== 0) {
          rugRisk.score = Math.min(100, Math.max(0, rugRisk.score + llmAnalysis.adjustment));
          rugRisk.reasons.push(`LLM analysis: ${llmAnalysis.verdict} (adj ${llmAnalysis.adjustment >= 0 ? '+' : ''}${llmAnalysis.adjustment}) — ${llmAnalysis.reason?.slice(0, 60)}`);
          log("rug_llm", `${token.symbol}: LLM adjusted rug score by ${llmAnalysis.adjustment >= 0 ? '+' : ''}${llmAnalysis.adjustment} → ${rugRisk.score} (${llmAnalysis.verdict})`);
        }
      }

      // ─── Cabal Play Analysis ──────────────────
      const cabalInput = {
        same_funder_holders: security?.rug_signals?.same_funder_holders,
        same_funder_cluster_size: security?.rug_signals?.same_funder_cluster_size,
        bundle_buyers_pct: security?.rug_signals?.bundle_buyers_pct,
        bundle_wallets_count: security?.rug_signals?.bundle_wallets_count,
        fresh_funded_holders: security?.rug_signals?.fresh_funded_holders,
        max_single_holder_pct: security?.holders?.max_single_holder_pct,
        top10_holders_pct: security?.holders?.top10_holders_pct,
        smartWalletBuys: security?.smart_money?.buys,
        smartWalletSells: security?.smart_money?.sells,
      };
      const cabal = analyzeCabalPlay(cabalInput);

      if (rugRisk.score >= 60) {
        log("filter", `${token.symbol}: SKIP rug score ${rugRisk.score}`);
        // Auto-blacklist confirmed honeypots so they never waste another cycle
        if (rugRisk.score >= 100) {
          const honeypotReasons = rugRisk.reasons.join("; ");
          if (!isTokenBlacklisted(token.mint)) {
            recordRug({
              mint: token.mint,
              symbol: token.symbol,
              creator: creatorAddr,
              launchpad: token.launchpad,
              rug_signals: security?.rug_signals || {},
              exit_reason: `honeypot_autoblacklist: ${honeypotReasons}`,
            });
            // Also blacklist the dev with market-cap-aware tiering
            if (creatorAddr) {
              blacklistDev({ creator: creatorAddr, mint: token.mint, symbol: token.symbol, mcap: token.mcap || 0, reason: `honeypot: ${honeypotReasons.slice(0, 80)}` });
            }
            log("trash_filter", `Auto-blacklisted honeypot: ${token.symbol || token.mint.slice(0, 8)} — ${honeypotReasons}`);
          }
        }
        continue;
      }

      // Block entry for cabal patterns that demand it
      if (cabal.action === CabalAgentAction.BLOCK_ENTRY) {
        log("cabal", `${token.symbol}: BLOCKED — ${cabal.cabalType} score=${cabal.cabalScore} ${cabal.reasons.slice(0,2).join("; ")}`);
        continue;
      }
      if (cabal.cabalType !== "NONE") {
        log("cabal", `${token.symbol}: ${cabal.cabalType} score=${cabal.cabalScore} action=${cabal.action}`);
      }

      if (tokenInfo?.error) {
        log("filter", `${token.symbol}: SKIP — getTokenInfo failed: ${tokenInfo.error}`);
        continue;
      }

      // Active strategy for tier execution + downstream context
      const activeStrategy = getStrategy(null, { regime: marketIntel.condition });
      const globalFees = tokenInfo.results?.[0]?.global_fees_sol || 0;
      const tierInfo = getMcapTier(token.mcap);
      const tierExec = getTierExecutionProfile(token.mcap, activeStrategy?.id || null);
      if (tierExec.sell_only) {
        log("filter", `${token.symbol}: SKIP sell-only tier ${tierExec.tier}`);
        continue;
      }
      const enhancedToken = { ...token, global_fees_sol: globalFees, tier: tierInfo, _trash_flags: token._trash_flags || [] };

      const filterResult = await run4FilterProtocol(enhancedToken, security, gasFee);

      // ─── Technical Indicators & Momentum Analysis ────────
      let technicals = null;
      let momentumValid = false;
      let momentumScore = 0;
      let momentumEntry = { pass: true };
      let volatilityPercentile = 50;
      let volatilityAdjustedSize = deployAmount;

      if (config.indicators.enabled && tierExec.use_technicals) {
        log("screening", `${token.symbol}: Fetching klines for momentum analysis...`);
        const klineData = await getTokenKlines({
          mint: token.mint,
          pair_address: token.pair_address,
          resolution: config.indicators.intervals[0] === "5_MINUTE" ? "5m" : "1m",
          limit: config.indicators.candles || 100
        });

        if (klineData.candles && klineData.candles.length > 5) {
          const momentum = analyzeMomentum(klineData.candles);

          if (momentum.valid) {
            momentumValid = true;
            momentumScore = getMomentumScore(momentum);
            momentumEntry = checkEntryConfirmation(momentum);

            technicals = {
              rsi: momentum.rsi ? parseFloat(momentum.rsi.toFixed(2)) : null,
              supertrend: momentum.supertrend ? { trend: momentum.trend, value: momentum.supertrend.value } : null,
              momentum_score: momentumScore,
              entry_confirmed: momentumEntry.pass,
            };

            // Calculate volatility and adjust position size
            volatilityPercentile = calculateVolatilityPercentile(klineData.candles, 14);
            volatilityAdjustedSize = computeVolatilityAdjustedSize(deployAmount, volatilityPercentile);

            log("screening", `${token.symbol}: RSI=${technicals.rsi} ST=${momentum.trend} MOMENTUM=${momentumScore} VOL=${volatilityPercentile.toFixed(0)}% SIZE=${volatilityAdjustedSize} ENTRY=${momentumEntry.pass}`);
          }
        }
      }

      const preKellyAmount = parseFloat(((volatilityAdjustedSize || deployAmount) * (tierExec.size_multiplier || 1)).toFixed(4));
      const tokenEdgeScore = Math.max(5, Math.min(95,
        100 -
        (rugRisk.score || 0) +
        Math.max(0, momentumScore / 4) +
        (filterResult.passed ? 8 : -5)
      ));
      const recentWinRate = recentTrades.length > 0
        ? recentTrades.filter(t => (t.profit_pct || 0) > 0).length / recentTrades.length
        : 0;
      const kelly = config.kelly?.enabled
        ? getCapitalAwareSizing({
            bankrollSol: walletSol,
            solPriceUsd: balance.sol_price || 0,
            baseDeployAmountSol: preKellyAmount,
            trades: recentTrades,
            context: {
              marketCondition: marketIntel.condition,
              tokenEdgeScore,
              holderStructureRisk: security?.holder_analysis?.holder_structure_risk || security?.rug_signals?.holder_structure_risk || "LOW",
            },
            regime: marketIntel.condition,
            fraction: config.kelly?.fraction ?? 0.5,
            minFraction: config.kelly?.minFraction ?? 0.1,
            maxFraction: config.kelly?.maxFraction ?? 0.8,
            minSampleTrades: config.kelly?.minSampleTrades ?? 5,
            capitalSizing: config.capitalSizing,
            kellyModeOpts: config.kelly?.kellyMode ? {
              deployedSol: totalExposedSol,
              maxPositions: getHeatmapMaxPositions(config.positions?.maxOpen ?? 3),
              winRate: recentWinRate,
              liveTrades: recentTrades.length,
              conviction: 0,
              mode3Approved: config.kelly?.mode3Approved ?? false,
              semanticMemoryEntries: 0,
            } : null,
          })
        : {
            deploy_amount_sol: preKellyAmount,
            kelly_fraction: 0,
            effective_fraction: 0,
            inputs: {},
            used_fallback: true,
            should_skip: false,
            tier: "MICRO",
            method: "fallback",
            capital_usd: 0,
            capped_at: null,
      };
      const sizedAmount = kelly.deploy_amount_sol || preKellyAmount;
      const conviction = getCoinConviction(token.mint, token, { narrativeVelocity, crossBatchVelocity });
      const narrativeTags = Array.isArray(token.narrative_tags)
        ? token.narrative_tags
        : [];

      // ─── Unified Signal Scoring (BEFORE decision) ──
      const featureResult = runAllFeatures({
        token: { ...enhancedToken, ...filterResult, rug_score: rugRisk.score },
        conviction,
        velocity: narrativeVelocity,
        crossBatch: crossBatchVelocity,
        kelly,
        technicals,
        regime: { stance: "unknown" },
        workflow: { verdict: "probe" },
        narrativeTags,
        marketCondition: marketIntel.condition,
        cabal,
      });

      const signal = aggregateSignal({
        conviction,
        velocity: narrativeVelocity,
        crossBatch: crossBatchVelocity,
        regime: {},
        kelly,
        technicals,
        marketCondition: marketIntel.condition,
        narrativeTags,
      });

      // Feature aggregate boosts conviction floor for trending/strong signals
      const boostedConviction = {
        ...conviction,
        conviction_score: Math.min(100, conviction.conviction_score + Math.max(0, (featureResult.aggregate - 30) * 0.3)),
        feature_aggregate: featureResult.aggregate,
      };

      const workflow = config.decisionWorkflow?.enabled
        ? evaluateCandidateDecision({
            token: {
              ...enhancedToken,
              ...filterResult,
              rug_score: rugRisk.score,
              kelly,
              narrative_tags: narrativeTags,
              momentum_entry_pass: momentumEntry.pass,
              volatility_adjusted_size: sizedAmount,
            },
            conviction: boostedConviction,
            marketCondition: marketIntel.condition,
            config: config.decisionWorkflow,
            narrativeVelocity,
          })
        : {
            verdict: "active",
            caution_score: 0,
            reasons: [],
            size_multiplier: 1,
            recommended_amount_sol: sizedAmount,
            fast_track_eligible: true,
            llm_can_buy: true,
          };
      const preRegimeAmount = workflow.recommended_amount_sol || sizedAmount;
      const regime = config.regimeMemory?.enabled
        ? getRegimeAssessment({
            ...enhancedToken,
            narrative_tags: narrativeTags,
            conviction,
            workflow,
            market_condition: marketIntel.condition,
            tier_execution: tierExec,
          })
        : {
            regime_score: 0,
            confidence_score: 0,
            stance: "unknown",
            size_multiplier: 1,
          };
      const passed = filterResult.passed && !kelly.should_skip && workflow.llm_can_buy;
      const flags = [...(filterResult.flags || [])];
      if (kelly.should_skip) {
        const skipReason = kelly.tier === "MICRO"
          ? `MICRO tier skip — regime ${marketIntel.condition} tidak kondusif untuk modal kecil`
          : `Kelly sizing rejected entry (edge=${kelly.kelly_fraction})`;
        flags.push(skipReason);
      }
      if (workflow.verdict === "shadow") {
        flags.push("Workflow shadow-only: conviction masih terlalu rendah");
      }
      if (workflow.verdict === "skip") {
        flags.push(`Workflow skip: ${workflow.reasons.join(", ") || "caution score terlalu tinggi"}`);
      }

      let recommendedAmount = preRegimeAmount;
      if (config.regimeMemory?.enabled) {
        const cap = config.regimeMemory?.tailwindMultiplierCap ?? 1.15;
        const floor = config.regimeMemory?.headwindMultiplierFloor ?? 0.4;
        const sizeMultiplier = Math.max(floor, Math.min(cap, regime.size_multiplier || 1));
        recommendedAmount = Number((preRegimeAmount * sizeMultiplier).toFixed(4));
      }

      scoredCandidates.push({
        ...enhancedToken, ...filterResult,
        passed,
        flags,
        rug_score: rugRisk.score,
        rug_reasons: rugRisk.reasons,
        market_condition: marketIntel.condition,
        profit_mode: isInProfitMode(),
        tier_execution: tierExec,
        kelly,
        conviction,
        cabal,
        signal,
        feature_aggregate: featureResult.aggregate,
        feature_scores: featureResult.scores,
        regime,
        workflow,
        technicals,
        momentum_score: momentumScore,
        momentum_entry_pass: momentumEntry.pass,
        volatility_percentile: volatilityPercentile,
        volatility_adjusted_size: recommendedAmount,
        recommended_deploy_amount_sol: recommendedAmount,
      });
    }

    // Catat semua candidates (termasuk yang tidak lolos) untuk belajar nanti
    if (scoredCandidates.length > 0) {
      for (const candidate of scoredCandidates) {
        await recordCoinObservation(candidate);
        await recordRegimeObservation(candidate);
        recordDecision({
          type: "screening_candidate",
          mint: candidate.mint,
          symbol: candidate.symbol,
          passed: candidate.passed,
          verdict: candidate.workflow?.verdict || "active",
          caution_score: candidate.workflow?.caution_score ?? 0,
          conviction_score: candidate.conviction?.conviction_score ?? 0,
          regime_score: candidate.regime?.regime_score ?? 0,
          sizing_tier: candidate.kelly?.tier ?? null,
          sizing_method: candidate.kelly?.method ?? null,
          sizing_capital_usd: candidate.kelly?.capital_usd ?? null,
          sizing_capped_at: candidate.kelly?.capped_at ?? null,
        });
      }
      recordObservations(scoredCandidates);
      // Build ticker registry — learn symbol→mint mappings from real market data
      try { bulkRegisterTickers(scoredCandidates); } catch (e) { log("ticker_error", e.message); }

      // Feed fundamental signals to the strategy producer. Internal throttle
      // (maxPerHour) prevents spam — tick is safe to call every screening cycle.
      if (_fundamentalProducer) {
        try {
          const sampleTokens = scoredCandidates.slice(0, 8);
          const sampleWallets = listSmartWallets({ minDecayMultiplier: 0.5 })
            .slice(0, 12)
            .map(w => w.address);
          await _fundamentalProducer.tick({
            sampleTokens,
            sampleWallets,
            regime: computeMarketRegime?.()?.regime || null,
          });
        } catch (e) { log("fundamental_producer_error", e.message); }
      }
    }

    let passingCandidates = scoredCandidates
      .filter(c => c.passed)
      .sort((a, b) =>
        (b.feature_aggregate || 0) - (a.feature_aggregate || 0) ||
        (b.conviction?.conviction_score || 0) - (a.conviction?.conviction_score || 0) ||
        (a.workflow?.caution_score || 0) - (b.workflow?.caution_score || 0)
      );
    const planSummary = getPlanSummary();

    if (entryBlockedByFee) {
      passingCandidates = applyFeeEntryGuard(passingCandidates, gasFee);
    } else if (passingCandidates.length > 0) {
      const guardedCandidates = [];
      for (const candidate of passingCandidates) {
        const amountSol = Number(candidate.recommended_deploy_amount_sol || deployAmount || 0.01);
        const guard = await preSwapGuard({
          mint: candidate.mint,
          amountSol: Number.isFinite(amountSol) && amountSol > 0 ? amountSol : 0.01,
        });
        if (!guard.allowed) {
          log("pre_swap_guard", `${candidate.symbol || candidate.mint}: ${guard.reason}`);
          continue;
        }
        if (guard.warn) {
          log("pre_swap_guard", `${candidate.symbol || candidate.mint}: ${guard.warn}`);
        }

        // ─── Pre-flight sell simulation ──────────────
        // Verify on-chain that the token CAN actually be sold.
        // Catches Token-2022 + custom program honeypots that would
        // trap capital. Run BEFORE committing to a swap.
        const sellSim = await simulateSell(candidate.mint, { timeoutMs: 5000 });
        if (sellSim.can_sell === false) {
          log("sell_sim_block", `${candidate.symbol || candidate.mint}: BLOCKED — sell simulation failed: ${sellSim.reason}`);
          if (!isTokenBlacklisted(candidate.mint)) {
            recordRug({
              mint: candidate.mint,
              symbol: candidate.symbol,
              rug_signals: { _sell_sim_blocked: true, _sell_sim_reason: sellSim.reason },
              exit_reason: `sell_sim_blocked: ${sellSim.reason}`,
            });
          }
          continue;
        }
        if (sellSim.can_sell === null) {
          // Simulation inconclusive — flag but don't block
          log("sell_sim_warn", `${candidate.symbol || candidate.mint}: sell simulation inconclusive — ${sellSim.reason}`);
        }

        guardedCandidates.push(candidate);
      }
      passingCandidates = guardedCandidates;
    }

    // ─── Fast-track lane (skip LLM for unambiguous BUYs) ────────
    // Off by default. When enabled, candidates passing the strict
    // deterministic gate get deployed immediately and removed from the
    // LLM pool; remaining ones still go through the LLM agentLoop.
    if (config.fastTrack?.enabled && passingCandidates.length > 0) {
      const slotsLeft = Math.max(0, positionLimit - openTokens.length);
      const maxNew = Math.min(config.fastTrack.maxNewPerCycle ?? 1, slotsLeft);
      if (maxNew > 0) {
        const fastTrackCandidates = passingCandidates.filter(c => c.workflow?.fast_track_eligible !== false);
        const walletPlan = (config.multiWallet?.autoSpreadEnabled ? walletPlanSummary.selected_wallets : [])
          .slice(0, maxNew)
          .map(slot => ({ ...slot, keypair: getWalletByAddress(slot.address)?.keypair || null }));
        if (walletPlanSummary.spread_ready) {
          log("wallet_mgr", `Capital-aware plan: ${walletPlanSummary.summary}`);
        }
        const batch = await runFastTrackBatch({
          candidates: fastTrackCandidates,
          fastTrackConfig: config.fastTrack,
          deployAmountSol: deployAmount,
          solPriceUsd: balance.sol_price || 0,
          maxNew,
          walletPlan,
        });
        if (batch.deployed.length > 0) {
          log("fast_track", `Deployed ${batch.deployed.length} via fast-track: ${batch.deployed.map(t => t.symbol).join(", ")}`);
        }
        const deployedMints = new Set(batch.deployed.map(t => t.mint));
        passingCandidates = passingCandidates.filter(c => !deployedMints.has(c.mint));
      }
    }

    if (passingCandidates.length > 0) {
      log("cron", `${passingCandidates.length} passed — invoking LLM`);
      const { content } = await agentLoop(`
SCREENING CYCLE
Amount: ${deployAmount} SOL
Gas: ${gasFee.level}
Market: ${marketIntel.condition} — ${marketIntel.description}
${planSummary ? `Plan: Day ${planSummary.day} | P&L: ${planSummary.today_pnl_pct}% | Target: +${planSummary.daily_target_pct}%${planSummary.profit_mode ? " | 🔥 PROFIT MODE — no trade limit" : ""}` : ""}
Posisi aktif: ${openTokens.length}/${positionLimit}

CANDIDATES (lolos 4-filter + rug check):
${JSON.stringify(passingCandidates)}
${narrativeVelocity.promptContext ? `\n${narrativeVelocity.promptContext}\n` : ""}${crossBatchVelocity.promptContext ? `${crossBatchVelocity.promptContext}\n` : ""}
WORKFLOW KEPUTUSAN HATI-HATI:
1. Default adalah SKIP jika conviction lemah, caution tinggi, atau edge belum jelas.
2. \`workflow.verdict=probe\` berarti hanya boleh entry kecil sesuai \`recommended_deploy_amount_sol\`.
3. \`workflow.verdict=active\` berarti boleh entry normal sesuai \`recommended_deploy_amount_sol\`.
4. Jangan override \`Kelly\` negatif. Jika \`kelly.should_skip=true\`, jangan buy.
5. Prioritaskan coin dengan conviction yang dibangun dari observasi berulang, bukan FOMO snapshot.
6. OVERRIDE MOMENTUM: Jika narrative velocity terdeteksi (≥3 token dari narasi sama, buy pressure >55%, volume tinggi), conviction trending_boost mengkompensasi cold-start. Token dengan trending_boost >15 dan workflow.verdict=probe boleh di-entry dengan size kecil meskipun conviction masih "unknown". Narasi trending mendahulukan momentum over history.
7. FEATURE AGGREGATE: Setiap candidate punya \`feature_aggregate\` (0-100) dan \`feature_scores\` (per-sinyal). feature_aggregate ≥60 = strong consensus, ≥40 = decent, <25 = weak. Gunakan sebagai TIEBREAKER utama antara candidates dengan verdict setara. Candidate dengan feature_aggregate tertinggi adalah prioritas pertama.

Pilih yang TERBAIK dan lakukan swap_token hanya jika edge jelas.
${planSummary?.profit_mode ? "PROFIT MODE aktif — lebih agresif." : ""}
      `, config.llm.screenerMaxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result }) => {
          await liveMessage?.toolFinish(name, result, !result?.error);
          if (name === "swap_token") {
            recordSwapOutcome({ success: !!(result?.success || result?.dry_run) });
          }
          if (name === "swap_token" && (result.success || result.dry_run)) {
            const token = passingCandidates.find(c =>
              c.mint === result.token_out || c.mint === result.would_swap?.token_out
            );
            if (token) {
              const executions = Array.isArray(result.executions) && result.executions.length > 0
                ? result.executions
                : [{
                    wallet_address: result.wallet_address || result.would_swap?.wallet_address || getActiveWallet()?.address || null,
                    amount: deployAmount,
                  }];
              for (const exec of executions) {
                // Staged entry: only deploy stage-1 amount, not full allocation
                const activeStrat = getStrategy(null, { regime: marketIntel.condition });
                const stagedCfg = activeStrat?.staged_entry;
                const stage1Amount = getStage1Amount(stagedCfg, exec.amount || deployAmount);
                const entryUsd = (stage1Amount * (balance.sol_price || 0)) || 0;

                // Init staged entry tracking for subsequent stages
                let stagedTracking = null;
                if (stagedCfg?.enabled && stagedCfg.stages > 1) {
                  stagedTracking = initStagedEntry(null, activeStrat, stage1Amount, balance.sol_price || 0);
                }

                await trackPosition({
                  position: token.mint,
                  pool: "jupiter",
                  pool_name: token.symbol,
                  amount_sol: stage1Amount,
                  initial_value_usd: entryUsd,
                  signal_snapshot: {
                    mint: token.mint,
                    symbol: token.symbol,
                    market_condition: token.market_condition || marketIntel.condition,
                    rug_score: token.rug_score || 0,
                    conviction: token.conviction || null,
                    regime: token.regime || null,
                    workflow: token.workflow || null,
                    kelly: token.kelly || null,
                    staged_entry: stagedTracking,
                    execution_context: {
                      wallet_address: exec.wallet_address || null,
                      provider: result?.execution_provider || "auto",
                      slippage: Number(result?.slippage || 0),
                    },
                  },
                  wallet_address: exec.wallet_address || null,
                });
              }
              recordTrade(null); // outcome unknown yet
            }
          }
        },
      });
      screenReport = content;
    } else {
      screenReport = `No candidates passed (market: ${marketIntel.condition}).`;
    }
  } catch (e) {
    log("cron_error", e.message);
    screenReport = `Error: ${e.message}`;
    recordError("screening_cycle");
  } finally {
    _screeningBusy = false;
    recordLatency("screening_cycle", elapsedMs(_cycleStart));
    if (!silent && telegramEnabled() && screenReport) {
      const body = stripThink(screenReport);
      if (liveMessage) await liveMessage.finalize(body);
      else sendHTML(`🔍 <b>Screen</b>\n${htmlEscape(body)}`);
    }
  }
  return screenReport;
}

// ─── Turbo Buttons (Geyser real-time stream) ──────────────────
// Wires the Helius Atlas WS feed into the fast-track buy lane so we react
// to smart-wallet swaps within ~1 slot instead of waiting for the next
// DexScreener polling cycle. Fail-soft — if HELIUS_ATLAS_WS_URL isn't set,
// startGeyserStream() returns null and we silently keep polling-only.
let _geyserStream = null;
let _turboStarted = false;
let _exitMonitorCleanup = null;
let _rugMonitor = null;
const _rugCircuitBreaker = createRugCircuitBreaker({
  maxEvents: config.risk?.rugCircuitBreaker?.maxEvents ?? 3,
  windowMs: (config.risk?.rugCircuitBreaker?.windowMinutes ?? 30) * 60 * 1000,
  lockDurationMs: (config.risk?.rugCircuitBreaker?.lockHours ?? 4) * 60 * 60 * 1000,
  log,
});
const _geyserLastByMint = new Map();
let _geyserLastGlobalTs = 0;
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";

async function handleSmartWalletSwap(event) {
  try {
    if (!event || event.kind !== "swap") return;
    if (event.token_in !== "SOL" && event.token_in !== SOL_MINT_STR) return;
    if (!event.token_out || event.token_out === "SOL" || event.token_out === SOL_MINT_STR) return;
    const mint = event.token_out;
    const now = Date.now();
    if (now - (_geyserLastByMint.get(mint) || 0) < 60_000) return;
    if (now - _geyserLastGlobalTs < 5_000) return;
    _geyserLastByMint.set(mint, now);
    _geyserLastGlobalTs = now;
    if (_geyserLastByMint.size > 500) {
      const cutoff = now - 120_000;
      for (const [k, t] of _geyserLastByMint) if (t < cutoff) _geyserLastByMint.delete(k);
    }
    recordCounter("geyser_smart_buy_triggered");
    log("geyser_smart_buy", `wallet=${String(event.wallet || "?").slice(0,8)} mint=${mint.slice(0,8)} slot=${event.slot}`);

    // Update last_active on tracked smart wallet (prevents score decay to zero)
    try {
      const wallets = listSmartWallets();
      const match = wallets.find(w => w.address === event.wallet);
      if (match) {
        match.last_active = new Date().toISOString();
        // best-effort persist — don't block the geyser handler
        import("./smart-wallets.js").then(m => m._updateWallet?.(match)).catch(() => {});
      }
    } catch { /* non-critical */ }
    if (!config.fastTrack?.enabled) {
      log("geyser_smart_buy", "fast-track disabled — signal received but no auto-buy");
      return;
    }

    const gate = await checkAllGates("geyser");
    if (gate.blocked) {
      log("geyser_smart_buy", `entry blocked: ${gate.reason}`);
      return;
    }

    let token = null;
    try {
      const tokenSearch = await getTokenInfo({ query: mint });
      token = tokenSearch?.results?.[0] || null;
    } catch (e) {
      log("geyser_handler_warn", `getTokenInfo: ${e.message}`);
      return;
    }
    if (!token || !token.mint) {
      log("geyser_handler_warn", `no token data for ${mint.slice(0,8)}`);
      return;
    }

    const activeWallet = getActiveWallet();
    const balance = await getWalletBalances(activeWallet?.address || null).catch(() => ({ sol: 0 }));
    const walletSol = isMultiWalletEnabled() && activeWallet
      ? getWalletCapitalSol(activeWallet.address, balance.sol || 0)
      : (balance.sol || 0);
    const deployAmountSol = computeDeployAmount(walletSol);
    if (!(deployAmountSol > 0)) {
      log("geyser_handler_warn", `deployAmountSol=${deployAmountSol} — skip`);
      return;
    }

    const batch = await runFastTrackBatch({
      candidates: [token],
      fastTrackConfig: config.fastTrack,
      deployAmountSol,
      solPriceUsd: 0,
      maxNew: 1,
    });
    log("geyser_smart_buy", `fast-track: deployed=${batch.deployed.length} skipped=${batch.skipped.length}`);
  } catch (e) {
    log("geyser_handler_error", e.message);
  }
}

let _geyserDisconnectAlerted = false;

function handleGeyserDisconnect(attempt) {
  // Only alert once per session so we don't spam Telegram during reconnect storms
  if (attempt === 1 && !_geyserDisconnectAlerted && telegramEnabled()) {
    _geyserDisconnectAlerted = true;
    sendHTML("⚠️ <b>Geyser stream disconnected</b> — reconnecting… (fallback: polling-only)").catch(() => {});
  }
}

async function seedSmartWallets() {
  if (listSmartWallets({ minDecayMultiplier: 0.5 }).length > 0) return; // already populated

  log("smart_wallets", "smart-wallets.json empty — seeding from discovered wallets…");

  // Path 1: Promote from existing discovered-wallets.json (free, no API calls)
  try {
    const { readFileSync } = await import("fs");
    const discovered = JSON.parse(readFileSync("discovered-wallets.json", "utf8"));
    const allWallets = Object.values(discovered).filter(w => w && typeof w === "object" && w.address);
    const elite = allWallets
      .filter(w => (w.stats?.winrate || 0) >= 0.65 && (w.stats?.completed_trades || 0) >= 3)
      .sort((a, b) => (b.stats?.winrate || 0) - (a.stats?.winrate || 0));

    if (elite.length > 0) {
      for (const w of elite.slice(0, 15)) {
        await addSmartWallet({
          address: w.address,
          label: `elite_${w.address.slice(0, 6)}`,
          stats: w.stats || {},
          source_tokens: w.source_tokens || [],
          follow_mode: (w.stats?.winrate || 0) >= 0.75 ? "active" : "probe",
          last_active: w.last_active || new Date().toISOString(),
          notes: `Promoted from discovered: ${(w.stats?.winrate || 0) * 100}% WR / ${w.stats?.completed_trades || 0} trades`,
        });
      }
      log("smart_wallets", `Seeded ${elite.slice(0, 15).length} elite wallets from discovered-wallets.json (${elite.filter(w => w.stats?.winrate >= 0.75).length} active, ${elite.filter(w => w.stats?.winrate >= 0.65 && w.stats?.winrate < 0.75).length} probe)`);

      if (_geyserStream) {
        const addrs = listSmartWallets().map(w => w.address);
        _geyserStream.refreshSubscriptions(addrs);
        log("smart_wallets", `Geyser subscriptions updated: ${addrs.length} wallets`);
      }
      if (telegramEnabled()) {
        const top3 = elite.slice(0, 3).map(w => `${(w.stats?.winrate*100).toFixed(0)}%/${w.stats?.completed_trades}t`).join(", ");
        sendHTML(`✅ <b>Smart wallets seeded</b> — ${elite.slice(0,15).length} from discovery (${elite.length} total eligible)\nTop: ${top3}`).catch(() => {});
      }
      return;
    }
  } catch (e) {
    log("smart_wallets", `Discovered-wallets promotion failed: ${e.message}`);
  }

  // Path 2: Helius-powered discovery (only if API key available)
  if (process.env.SCREENING_MODE === "dexscreener" || !process.env.HELIUS_API_KEY) {
    log("smart_wallets", "No Helius — skip live discovery. Run with HELIUS_API_KEY for fresh wallet scanning.");
    return;
  }

  log("smart_wallets", "Running live Helius discovery…");
  try {
    const result = await discoverSmartWallets({ source_tokens: 5, min_winrate: 0.6, min_trades: 5, auto_add: false });
    if (result.error) { log("smart_wallets", `Auto-seed skipped: ${result.error}`); return; }
    const promoted = (result.qualified || []);
    for (const w of promoted.slice(0, 15)) {
      await addSmartWallet({
        address: w.address,
        label: `auto_${w.address.slice(0, 6)}`,
        stats: { winrate: w.winrate, completed_trades: w.completed_trades, realized_pnl_sol: w.realized_pnl_sol, avg_hold_seconds: w.avg_hold_seconds, unique_tokens: w.unique_tokens },
        source_tokens: w.source_tokens || [],
        selection: w.selection || null,
        follow_mode: w.selection?.follow_mode || "shadow",
        last_active: new Date().toISOString(),
      });
    }
    if (promoted.length > 0) {
      log("smart_wallets", `Seeded ${promoted.length} smart wallets from live discovery`);
      if (_geyserStream) { _geyserStream.refreshSubscriptions(listSmartWallets().map(w => w.address)); }
    }
  } catch (e) {
    log("smart_wallets", `Auto-seed error: ${e.message}`);
  }
}

// ─── Rug Monitor Glue ─────────────────────────────────────────
const rugMonitorFetchers = {
  getMintInfo: async (mint) => {
    try {
      const mod = await import("./tools/rug-signals.js");
      if (typeof mod.fetchMintInfo === "function") return mod.fetchMintInfo(mint);
    } catch (_) {}
    return null;
  },
  getPoolInfo: async (mint) => {
    try {
      const mod = await import("./tools/dexscreener.js");
      const pools = (typeof mod.fetchPools === "function") ? await mod.fetchPools(mint) : null;
      const top = Array.isArray(pools) ? pools[0] : null;
      return top ? { pool_address: top.pairAddress || top.address, lp_usd: top.liquidityUsd || top.liquidity_usd } : null;
    } catch (_) { return null; }
  },
  getTopHolders: async (mint) => {
    try {
      // Use existing getTokenLargeAccounts → resolve owners → return wallet addresses + balances
      const { Connection, PublicKey } = await import("@solana/web3.js");
      const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
      const mintPk = new PublicKey(mint);
      const largest = await conn.getTokenLargestAccounts(mintPk);
      const accounts = (largest?.value || []).slice(0, 10);
      if (accounts.length === 0) return [];
      // Resolve token-account → owner wallet for each
      const parsed = await conn.getMultipleParsedAccounts(accounts.map(a => new PublicKey(a.address)));
      const mintDecimals = 6; // default assumption; exact decimals require mintInfo fetch
      return accounts.map((acc, i) => {
        const info = parsed?.value?.[i]?.data?.parsed?.info;
        const owner = info?.owner || null;
        const balance = acc.uiAmount || (acc.amount / Math.pow(10, mintDecimals));
        return { wallet: owner, address: acc.address, balance };
      });
    } catch (_) { return []; }
  },
  getTokenBalance: async (owner, mint) => {
    try {
      const mod = await import("./tools/rug-signals.js");
      if (typeof mod.fetchTokenBalance === "function") return mod.fetchTokenBalance(owner, mint);
    } catch (_) {}
    return 0;
  },
  getMintAccount: async (mint) => {
    try {
      const mod = await import("./tools/rug-signals.js");
      if (typeof mod.fetchMintInfo === "function") return mod.fetchMintInfo(mint);
    } catch (_) {}
    return { mint_authority: null, freeze_authority: null };
  },
  getLargestAccounts: async (mint) => {
    try {
      const mod = await import("./tools/rug-signals.js");
      if (typeof mod.fetchTopHolders === "function") return mod.fetchTopHolders(mint, 10);
    } catch (_) {}
    return [];
  },
  getPoolLiquidityUsd: async (poolAddr) => {
    try {
      const mod = await import("./tools/dexscreener.js");
      if (typeof mod.fetchPoolByAddress === "function") {
        const p = await mod.fetchPoolByAddress(poolAddr);
        return p?.liquidityUsd ?? p?.liquidity_usd ?? null;
      }
    } catch (_) {}
    return null;
  },
};

function _rugLog(level, signalType, positionKey, meta) {
  const tag = level === "HIGH" ? "🔴" : level === "MEDIUM" ? "🟡" : "🟢";
  const msg = `${tag} [RUG_MONITOR] ${level} on ${positionKey} signal=${signalType} src=${meta?.source || "?"}`;
  log("rug_monitor", msg);
  if (telegramEnabled()) {
    sendHTML(`${tag} <b>RUG_MONITOR ${level}</b>\nPosition: <code>${positionKey}</code>\nSignal: ${signalType}\nSource: ${meta?.source || "?"}`).catch(() => {});
  }
  return msg;
}

const rugMonitorCallbacks = {
  onLow: (positionKey, signalType, meta) => {
    _rugLog("LOW", signalType, positionKey, meta);
  },
  onMedium: (positionKey, signalType, meta) => {
    _rugLog("MEDIUM", signalType, positionKey, meta);
  },
  onHigh: (positionKey, signalType, meta) => {
    _rugLog("HIGH", signalType, positionKey, meta);
    const pos = getState()?.positions?.[positionKey];
    if (pos) {
      pos.rug_force_exit = true;
      pos.rug_force_exit_reason = `rug_monitor_${signalType}`;
      pos.rug_force_exit_ts = Date.now();
    }
  },
};

function startTurboButtons() {
  if (_turboStarted) return;
  _turboStarted = true;
  try {
    _geyserStream = startGeyserStream({ onEvent: handleSmartWalletSwap, onDisconnect: handleGeyserDisconnect });
    if (_geyserStream) {
      log("turbo", "Geyser stream active — real-time smart-wallet monitoring ON");

      _exitMonitorCleanup = attachExitMonitor(
        _geyserStream,
        () => Object.values(getState()?.positions || {}).filter(p => !p?.closed),
        {
          onEmergencyExit: async (mint, reason, detail) => {
            log("geyser_exit_emergency", `EMERGENCY EXIT SIGNAL: ${mint.slice(0, 8)} reason=${reason} — ${detail}`);
            if (telegramEnabled()) {
              sendHTML(`🚨 <b>Emergency Exit Signal</b>\nMint: <code>${mint.slice(0, 8)}</code>\nReason: ${reason}\n${detail}`).catch(() => {});
            }
          },
          onSuspiciousActivity: (mint, reason, detail) => {
            log("geyser_exit_warn", `Suspicious: ${mint.slice(0, 8)} — ${reason}: ${detail}`);
          },
        }
      );
      log("turbo", "Exit monitor attached to Geyser stream");
    } else {
      log("turbo", "Geyser disabled (HELIUS_ATLAS_WS_URL not set) — polling-only");
    }
    if (config.rugMonitor?.enabled) {
      try {
        _rugMonitor = createRugMonitor({
          geyserStream: _geyserStream,
          config: config.rugMonitor,
          callbacks: rugMonitorCallbacks,
          fetchers: rugMonitorFetchers,
          log,
        });
        log("rug_monitor", `enabled (polling=${config.rugMonitor.pollingIntervalSec}s)`);
      } catch (e) {
        log("rug_monitor_error", `init failed: ${e.message}`);
      }
    }
    if (config.executionEdge?.enabled) {
      try {
        const conns = config.executionEdge.rpcEndpoints.map(e => {
          const conn = new Connection(e.url, "confirmed");
          return {
            url: e.url,
            label: e.label,
            call: async (method, ...args) => {
              if (typeof conn[method] === "function") return conn[method](...args);
              throw new Error(`connection does not support ${method}`);
            },
          };
        });
        const rq = createRpcQuorum({
          endpoints: config.executionEdge.rpcEndpoints,
          timeoutMs: config.executionEdge.executor.rpcCallTimeoutMs,
          connectionFactory: () => conns,
          log,
        });
        setRpcQuorum(rq);
        const fo = createFeeOracle({ rpcQuorum: rq, config: config.executionEdge, log });
        fo.start();
        setFeeOracle(fo);
        log("exec_edge", `enabled, fee_oracle started, rpc_quorum active (${config.executionEdge.rpcEndpoints.length} endpoints)`);
      } catch (e) {
        log("exec_edge_error", `init failed: ${e.message}`);
      }
    }
  } catch (e) {
    log("turbo_error", `startGeyserStream failed: ${e.message}`);
  }
}

// ─── Cron Setup ───────────────────────────────────────────────

// Build an explicit minute list offset by 1 so screening never fires on the same
// minute as management (which uses */N starting at :00).
// e.g. intervalMin=30 → "1,31", intervalMin=10 → "1,11,21,31,41,51"
function screeningCronPattern(intervalMin) {
  const minutes = [];
  for (let m = 1; m < 60; m += intervalMin) minutes.push(m);
  return `${minutes.join(",")} * * * *`;
}

export function startCronJobs() {
  _cronTasks.forEach(t => t.stop());
  const tasks = [];

  // ─── Daily Advance: auto-advance trading plan at midnight UTC ──
  // Runs at 00:01 UTC each night. Fetches actual wallet balance,
  // records yesterday's results, and resets session for the new day.
  // Without this, the 30-day compound plan stays on day 1 forever.
  tasks.push(cron.schedule("1 0 * * *", async () => {
    if (!config.pilot?.enabled) return;
    const plan = getTradingPlan();
    if (!plan) return;
    try {
      const balance = await getWalletBalances();
      const totalUsd = (balance?.sol_usd || 0) + (balance?.tokens || []).reduce((s, t) => s + (t.usd || 0), 0);
      if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
        log("plan", `Midnight advance skipped — invalid wallet balance: ${totalUsd}`);
        return;
      }
      const result = advanceDay(totalUsd, getStrategy(null)?.id || null);
      log("plan", `Day advanced: ${result.day - 1} → ${plan.currentDay}. PnL yesterday: ${result.pnl_pct}%. Today's target: $${plan.schedule[plan.currentDay - 1]?.target_usd?.toFixed(2)}`);
      if (telegramEnabled()) {
        const achieved = result.achieved ? "✅" : "❌";
        sendHTML(
          `${achieved} <b>Day ${result.day} closed</b>\n` +
          `PnL: ${fmt.pct(result.pnl_pct)} · ${result.wins}W/${result.losses}L · ${result.trades} trades\n` +
          `Target: ${result.achieved ? "HIT" : "MISSED"} · Day ${plan.currentDay} starts at $${result.actual_usd?.toFixed(2)}`
        ).catch(() => {});
      }
    } catch (e) {
      log("plan_error", `Midnight advance failed: ${e.message}`);
    }
  }));

  // Management (setiap N menit, mulai dari :00)
  tasks.push(cron.schedule(`*/${config.schedule.managementIntervalMin} * * * *`, runManagementCycle));

  // Screening (offset +1 menit dari management agar tidak tabrakan — :01,:31 bukan :00,:30)
  tasks.push(cron.schedule(screeningCronPattern(config.schedule.screeningIntervalMin), runScreeningCycle));

  // Continuous Learning (setiap 30 menit, offset +2 agar tidak tabrakan)
  tasks.push(cron.schedule("2,32 * * * *", runContinuousLearningCycle));

  // Market Rug Harvester (tiap 4 jam — proactive learn rug patterns from market)
  tasks.push(cron.schedule("0 */4 * * *", () => {
    harvestMarketRugs({ source_tokens: 30, max_record: 10 })
      .then(r => log("cron", `Rug harvest: ${r.harvested}/${r.candidates_detected} recorded`))
      .catch(e => log("cron_error", `Rug harvest failed: ${e.message}`));
  }));

  // Daily prune: archive closed positions older than 7 days (3am UTC)
  tasks.push(cron.schedule("0 3 * * *", async () => {
    const { pruned } = pruneClosedPositions();
    if (pruned > 0) log("cron", `Daily prune: archived ${pruned} old closed positions`);
    // Wallet pruning — prevent discovered-wallets.json bloat
    try {
      const { pruneDiscoveredWallets } = await import("./wallet-score-decay.js");
      const { readFileSync, writeFileSync } = await import("fs");
      const wallets = JSON.parse(readFileSync("discovered-wallets.json", "utf8"));
      const result = pruneDiscoveredWallets(wallets, { maxAgeDays: 30, maxWallets: 200 });
      if (result.removed > 0) {
        writeFileSync("discovered-wallets.json", JSON.stringify(result.pruned, null, 2));
        log("cron", `Wallet prune: removed ${result.removed} stale wallets, kept ${result.kept}`);
      }
    } catch (e) { /* file may not exist, OK */ }
  }));

  // Strategy degradation scan — auto-deactivate evolved strategies whose
  // live win rate has dropped below the degradation threshold (4am UTC).
  // Runs daily; only scans strategies with ≥10 live trades.
  tasks.push(cron.schedule("0 4 * * *", async () => {
    try {
      if (typeof _evolutionEngine?.scanAllDegradations === "function") {
        const degraded = await _evolutionEngine.scanAllDegradations();
        if (degraded.length > 0) {
          log("strategy_degradation", `Auto-degraded ${degraded.length} strategies: ${degraded.map(d => d.name).join(", ")}`);
          if (telegramEnabled()) {
            sendHTML(`⚠️ <b>Strategy Degradation</b>\n${degraded.map(d => `${d.name}: WR ${(d.liveWinRate*100).toFixed(0)}% (${d.liveTrades} trades)`).join("\n")}`).catch(() => {});
          }
        }
      }
    } catch (e) { /* best-effort */ }
  }));

  // Day Phase Trade screening — daily sweep for mature sideway tokens (8am UTC)
  // Runs once per day because these tokens don't appear/disappear quickly.
  tasks.push(cron.schedule("0 8 * * *", async () => {
    try {
      const active = getStrategy(null)?.id;
      if (active !== "day_phase_trading") return; // only when strategy is active
      log("day_phase", "Running daily day-phase screening...");
      const { watchlist, stats } = await screenDayPhaseTokens();
      if (watchlist.length > 0 && telegramEnabled()) {
        await sendHTML(formatWatchlistForNotification(watchlist, 10));
      }
      log("day_phase", `Daily sweep: ${stats.passed} candidates (${stats.high_confidence} high confidence)`);
    } catch (e) {
      log("day_phase_error", `Daily screening failed: ${e.message}`);
    }
  }));

  // Smart wallet re-discovery — refresh wallet pool every 6 hours
  // New profitable wallets appear constantly; without this the bot
  // only sees wallets that existed at first boot.
  tasks.push(cron.schedule("0 */6 * * *", async () => {
    try {
      const existing = listSmartWallets({ minDecayMultiplier: 0.5 }).length;
      const result = await discoverSmartWallets({ source_tokens: 8, min_winrate: 0.6, min_trades: 5, auto_add: false });
      const fresh = (result.qualified || []).filter(w => w.winrate >= 0.65);
      let added = 0;
      for (const w of fresh.slice(0, 5)) {
        const wallets = listSmartWallets();
        if (!wallets.some(ex => ex.address === w.address)) {
          await addSmartWallet({
            address: w.address,
            label: `discovered_${w.address.slice(0, 6)}`,
            stats: {
              winrate: w.winrate,
              completed_trades: w.completed_trades,
              realized_pnl_sol: w.realized_pnl_sol,
              avg_hold_seconds: w.avg_hold_seconds,
              unique_tokens: w.unique_tokens,
            },
            source_tokens: w.source_tokens || [],
            follow_mode: "shadow",
            last_active: new Date().toISOString(),
          });
          added++;
        }
      }
      if (added > 0 && _geyserStream) {
        const addrs = listSmartWallets({ minDecayMultiplier: 0.5 }).map(w => w.address);
        _geyserStream.refreshSubscriptions(addrs);
      }
      if (added > 0) log("smart_wallets", `Rediscovery: added ${added} new wallets (pool: ${existing} → ${existing + added})`);
    } catch (e) { /* best-effort */ }
  }));

  // Vault (daily check — cron checks if 7 days elapsed)
  tasks.push(cron.schedule("0 */6 * * *", () => runVaultCycle().catch(e => log("vault_error", e.message))));

  // Daily Report (setiap hari jam dailyReportHourUtc:dailyReportMinuteUtc UTC)
  const reportH = config.report.hourUtc ?? 0;
  const reportM = config.report.minuteUtc ?? 5;
  tasks.push(cron.schedule(`${reportM} ${reportH} * * *`, () => {
    runDailyReport().catch(e => log("report_error", e.message));
  }));

  _cronTasks = tasks;
  cronStarted = true;
  startTurboButtons();
  // Auto-seed smart wallets after Geyser is started so refreshSubscriptions() can wire them in
  seedSmartWallets().catch(e => log("smart_wallets", `seed failed: ${e.message}`));
  // Dashboard IPC — check for commands from dashboard process every 3s
  _dashboardIpcTimer = setInterval(() => checkDashboardCommands().catch(e => log("dashboard_ipc", e.message)), 3000);
  log("cron", `Jobs started: mgmt=${config.schedule.managementIntervalMin}m screen=${config.schedule.screeningIntervalMin}m vault=6h report=${reportH}:${String(reportM).padStart(2,"0")}UTC`);
}

// ─── Dashboard IPC ────────────────────────────────────────────────
export async function checkDashboardCommands() {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const fp = path.join(__dirname, "dashboard-cmd.json");
  const rfp = path.join(__dirname, "dashboard-response.json");
  try {
    if (!fs.existsSync(fp)) return;
    const cmd = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) { fs.unlinkSync(fp); return; }
    if (typeof cmd.cmd !== "string" || cmd.cmd.length === 0 || cmd.cmd.length > 64) { fs.unlinkSync(fp); return; }
    if (cmd.args !== undefined) {
      if (!Array.isArray(cmd.args) || cmd.args.length > 16) { fs.unlinkSync(fp); return; }
      for (const a of cmd.args) {
        if (typeof a !== "string" || a.length > 256) { fs.unlinkSync(fp); return; }
      }
    }
    if (cmd.id === undefined || cmd.id === null) { fs.unlinkSync(fp); return; }
    let lastId = null;
    try { lastId = JSON.parse(fs.readFileSync(rfp, "utf8")).id; } catch {}
    if (cmd.id === lastId) return;
    fs.unlinkSync(fp);
    const text = [cmd.cmd, ...(cmd.args || [])].join(" ").trim();
    await handleIncomingTelegramMessage({ text });
    atomicWriteJson(rfp, { id: cmd.id, response: "(command executed)", ts: new Date().toISOString() });
  } catch (e) {
    log("dashboard_ipc", `IPC error: ${e.message}`);
  }
}

export function stopCronJobs() {
  _cronTasks.forEach(t => t.stop());
  _cronTasks = [];
  cronStarted = false;
  log("cron", "All jobs stopped.");
}

// ─── Shutdown ─────────────────────────────────────────────────

async function shutdown(signal) {
  log("shutdown", signal);
  stopPolling();
  if (_dashboardIpcTimer) { clearInterval(_dashboardIpcTimer); _dashboardIpcTimer = null; }
  if (_ttyPromptTimer) { clearInterval(_ttyPromptTimer); _ttyPromptTimer = null; }
  if (_automationCommandTimer) { clearInterval(_automationCommandTimer); _automationCommandTimer = null; }
  _cronTasks.forEach(t => t.stop());
  if (_geyserStream?.close) _geyserStream.close();
  _geyserStream = null;
  try { _rugMonitor?.shutdown(); } catch (_) {}
  try { shutdownSingletons(); } catch (_) {}
  try { shutdownWalletManager(); } catch (_) {}
  try { await flushState(); } catch (_) {}
  process.exit(0);
}
process.on("unhandledRejection", (reason, promise) => {
  log("fatal", `Unhandled rejection: ${reason?.message || reason}`);
  console.error("[unhandledRejection]", reason);
  flushState().catch(() => {});
});

process.on("uncaughtException", (err) => {
  log("fatal", `Uncaught exception: ${err.message}`);
  console.error("[uncaughtException]", err);
  shutdown("uncaughtException");
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── TTY / Interactive ────────────────────────────────────────

const isTTY = process.stdin.isTTY;
let busy = false;
const sessionHistory = [];
const MAX_HISTORY = 10;
let _ttyInterface = null;

if (isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: buildPrompt() });
  _ttyInterface = rl;
  _ttyPromptTimer = setInterval(() => { if (!busy) { rl.setPrompt(buildPrompt()); rl.prompt(true); } }, 10_000);

  const plan = getPlanSummary();
  const market = getMarketIntelligence();
  const vault = getVaultStatus();
  const vaultDue = isVaultDue();

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║           Ponyou AI Agent — Ready (v2.2)                 ║`);
  console.log(`║  Plan: Day ${String(plan?.day||1).padStart(2,"0")}/${plan?.days_total||30} | Target +${plan?.daily_target_pct||25}%/hari           ║`);
  console.log(`║  Modal: $${String((plan?.today_start_usd||config.pilot.initialCapitalUsd).toFixed(2)).padStart(7)} → $${String((plan?.today_target_usd||0).toFixed(2)).padStart(7)} today    ║`);
  console.log(`║  Market: ${(market.condition || "NORMAL").padEnd(8)} | Stop-Loss: ${config.pilot.dailyStopLossPct}%/hari      ║`);
  console.log(`║  Vault: ${vault.configured ? `${vault.vault_pct}% tiap ${vault.interval_days}hr | ${vaultDue.days_remaining?.toFixed(1)}hr lagi` : "belum dikonfigurasi".padEnd(30)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  console.log(`Perintah CLI: /pilot check, /auto on|off, /off (shutdown), /smart (scan smart money)\n`);

  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // CLI Commands
    if (input.startsWith("/")) {
      const [cmd, ...args] = input.slice(1).split(" ");
      
      if (cmd === "off") {
        console.log("Shutting down Ponyou...");
        await shutdown("CLI_OFF");
        return;
      }

      if (cmd === "auto") {
        const mode = args[0]?.toLowerCase();
        if (mode === "on") {
          setAutomationEnabled(true, "cli", true);
          console.log("Automation ENABLED.");
        } else if (mode === "off") {
          setAutomationEnabled(false, "cli", true);
          console.log("Automation DISABLED.");
        } else {
          console.log("Usage: /auto on|off");
        }
        rl.prompt();
        return;
      }

      if (cmd === "pilot") {
        const action = args[0]?.toLowerCase();
        if (action === "check") {
          const p = getPlanSummary();
          const g = checkSessionGate();
          console.log("\n─── Pilot Status ───");
          if (!p) {
            console.log("Plan belum diinisialisasi.");
          } else {
            console.log(`Day: ${p.day}/${p.days_total}`);
            console.log(`P&L Today: ${(p.today_pnl_pct ?? 0).toFixed(2)}% ($${(p.today_pnl_usd ?? 0).toFixed(2)})`);
            console.log(`Target: ${p.daily_target_pct}% | StopLoss: ${config.pilot.dailyStopLossPct}%`);
            console.log(`Mode: ${p.profit_mode ? "PROFIT MODE" : "NORMAL"}`);
            if (g.paused) console.log(`STATUS: PAUSED (${g.reason}) - Resume in ${g.resume_in_min}m`);
            else console.log("STATUS: RUNNING");
          }
          console.log("────────────────────\n");
        } else {
          console.log("Usage: /pilot check");
        }
        rl.prompt();
        return;
      }

      if (cmd === "smart") {
        await runBusy(async () => {
          console.log("Scanning for Smart Money activity...");
          const smartGoal = "Find the most profitable smart money wallets on Solana and check what tokens they are buying right now. Give me a summary of hype and smart money inflow.";
          const { content } = await agentLoop(smartGoal, config.llm.maxSteps, sessionHistory, "GENERAL");
          sessionHistory.push({ role: "user", content: smartGoal }, { role: "assistant", content });
          if (sessionHistory.length > MAX_HISTORY) sessionHistory.splice(0, 2);
          console.log(`\n${content}\n`);
        });
        return;
      }
    }

    await runBusy(async () => {
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL");
      sessionHistory.push({ role: "user", content: input }, { role: "assistant", content });
      if (sessionHistory.length > MAX_HISTORY) sessionHistory.splice(0, 2);
      console.log(`\n${content}\n`);
    });
  });
}

function refreshPrompt() {
  if (_ttyInterface) { _ttyInterface.setPrompt(buildPrompt()); _ttyInterface.prompt(true); }
}
let _lastAutomationCommandId = null;

function publishRuntimeAutomationState(source = "runtime") {
  return publishAutomationState({
    enabled: cronStarted,
    cronStarted,
    telegramPolling: telegramEnabled(),
    source,
  });
}

function setAutomationEnabled(enabled, source = "runtime", persist = false) {
  if (enabled) startCronJobs();
  else stopCronJobs();
  if (persist) {
    persistAutomationPreference(enabled).catch((err) =>
      log("automation", `persistAutomationPreference failed: ${err?.message || err}`)
    );
  }
  publishRuntimeAutomationState(source);
  return cronStarted;
}

function syncAutomationBootState() {
  const desired = config.automation?.enabled !== false;
  if (desired && !cronStarted) startCronJobs();
  if (!desired && cronStarted) stopCronJobs();
  publishRuntimeAutomationState("boot");
}

function processAutomationCommand() {
  const cmd = readAutomationCommand();
  if (!cmd?.id || cmd.id === _lastAutomationCommandId) return;
  _lastAutomationCommandId = cmd.id;

  if (cmd.action === "set_enabled" && typeof cmd.enabled === "boolean") {
    setAutomationEnabled(cmd.enabled, cmd.source || "external", false);
    log("automation", `External automation command: ${cmd.enabled ? "ON" : "OFF"} (${cmd.source || "external"})`);
  }
}

async function runBusy(fn) {
  if (busy) return;
  busy = true;
  _ttyInterface?.pause();
  try { await fn(); }
  catch (e) { console.error(e.message); }
  finally {
    busy = false;
    refreshPrompt();
    _ttyInterface?.resume();
  }
}

export async function handleIncomingTelegramMessage(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  if (text === "/pnl") {
    const history = getPerformanceHistory({ limit: 10 });
    const table = formatPnLTable(history);
    await sendHTML(table);
    return;
  }

  if (text === "/status") {
    const plan = getPlanSummary();
    const market = getMarketIntelligence();
    const planLine = plan
      ? `Day ${plan.day}/${plan.days_total} · PnL ${fmt.pct(plan.today_pnl_pct ?? 0)}`
      : fmt.it("plan belum diinisialisasi");
    const autoLine = cronStarted ? "🟢 ON" : "🔴 OFF";
    const dailyGuard = formatDailyTradeGuardLine();
    const message = [
      `📊 <b>Status</b>`,
      planLine,
      `Market · ${htmlEscape(market.condition)}`,
      `Automation · ${autoLine}`,
      `Daily Guard · ${htmlEscape(dailyGuard)}`,
    ].join("\n");
    await sendHTML(message);
    return;
  }

  if (text.startsWith("/")) {
    const handled = await handleStrategyTelegramCommand(text).catch(e => {
      sendHTML(`❌ Command error: ${e.message}`).catch(() => {});
      return true;
    });
    if (handled) return;
  }

  if (busy) return;
  busy = true;
  let liveMsg = null;
  try {
    liveMsg = await createLiveMessage("🤖 Ponyou", "Memproses…");

    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, "GENERAL", null, null, {
      onThinkingStart: async () => {},
      onToolStart: async ({ name }) => { await liveMsg?.toolStart(name); },
      onToolFinish: async ({ name, result }) => {
        await liveMsg?.toolFinish(name, result, !result?.error);
        if (name === "swap_token") {
          recordSwapOutcome({ success: !!(result?.success || result?.dry_run) });
        }
      },
    });

    sessionHistory.push({ role: "user", content: text }, { role: "assistant", content });
    if (sessionHistory.length > MAX_HISTORY) sessionHistory.splice(0, 2);

    const clean = stripThink(content) || "";
    if (liveMsg) await liveMsg.finalize(clean);
    else await sendMessage(clean);
  } catch (e) {
    const errLine = `❌ <b>Error</b>\n<code>${htmlEscape(e.message)}</code>`;
    if (liveMsg) await liveMsg.finalize(errLine);
    else await sendHTML(errLine);
  } finally {
    busy = false;
    refreshPrompt();
  }
}

function ensureTelegramAutomationSurface() {
  if (telegramEnabled()) {
    startPolling(handleIncomingTelegramMessage);
  }
}

syncAutomationBootState();
ensureTelegramAutomationSurface();
_automationCommandTimer = setInterval(processAutomationCommand, 2000);

registerCronRestarter(() => { if (cronStarted) startCronJobs(); });
