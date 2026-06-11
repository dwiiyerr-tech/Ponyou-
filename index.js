import "dotenv/config";
// MUST be the first project import: config.js runs applyExecutionMode(), which
// (in paper mode) redirects learning/trade stores into demo/. This has to happen
// before any store module evaluates its path const — several stores load via
// tools/wallet.js below, ahead of the named config import further down.
import "./config.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createRugCircuitBreaker } from "./rug-circuit-breaker.js";
import { heliusCircuitOpen, helius429Hit } from "./tools/rug-signals.js";
import { agentLoop } from "./agent.js";
import AgentRouter, { displayName as agentDisplayName } from "./agent-router.js";
import { agentBus } from "./agents/agent-bus.js";
import { registerAgent, setAgentStatus, getDashboardSummary } from "./agents/agent-registry.js";
import { initHuntersAgent, runHuntersExpedition, getHuntersPrey, getHuntersDashboard } from "./agents/hunters-agent.js";
import { initScreeningAgent, getScreeningDashboard } from "./agents/screening-agent.js";
import { initManagementAgent, isLLMReviewEnabled } from "./agents/management-agent.js";
import { initGeneralAgent, handleGeneralMessage } from "./agents/general-agent.js";
import { initTrashLayer } from "./agents/trash-layer.js";
import { initLearningAgent, getStrategyPerformance } from "./agents/learning-agent.js";
import { shadowWatch } from "./tools/shadow-watchlist.js";
import { initOrchestratorAgent, runOrchestratorCycle, setFullAutomationMode, getOrchestratorDashboard } from "./agents/orchestrator-agent.js";
import { runAutomationQualification, checkAutomationQualification, isAutomationActive, guardAutomatedDecision, getAutomationState, approveAutomation, rejectAutomation, revokeAutomation } from "./agents/automation-rules.js";
import { initProOrchestrator, isProModeActive, isProValidationMode, getProDashboard, proBuyDecision, proSellDecision, proCutlossDecision, proCastNetDecision, runProAnalysis, validateStrategyReadiness } from "./agents/pro-orchestrator.js";
import { checkWalletSignals, getWalletTierStats, discoverWalletTiers, TIER_CONFIG } from "./tools/wallet-tiers.js";
import { log, captureUncaught } from "./logger.js";
captureUncaught(); // register process-level error handlers for Doctor diagnostics
import { getWalletBalances } from "./tools/wallet.js";
import { applyFeeEntryGuard, getSolanaGasFee, shouldSkipEntriesForGasFee } from "./tools/solana-rpc.js";
import { discoverTokens, getTokenSecurityDetails, getTokenKlines } from "./tools/dexscreener.js";
import { preSwapGuard, swapToken } from "./tools/jupiter.js";
import { GMGN_CHAINS } from "./tools/gmgn.js";

// Chain-aware sell for deterministic exits (SL/TP/trailing/rug).
// _bypass_kill_switch: deterministic exits are PROTECTIVE — they must close
// positions even when the operator has triggered /kill (which was likely
// triggered because of the same rug/loss that's being exited now).
function sellByChain(args) {
  return executeTrade({ ...args, _bypass_kill_switch: true });
}
import { config, computeDeployAmount, computeVolatilityAdjustedSize } from "./config.js";
import { computeRegimeSizeMultiplier } from "./market-safety.js";
import {
  filterNarrativeContagion,
  isRugExitReason,
  recordRuggedNarrativesForExit,
} from "./narrative-contagion.js";
import { analyzeHolderStructure } from "./holder-memory.js";
import { summarizeSmartWalletHistory } from "./smart-wallet-history.js";
import { getPerformanceSummary, recordTradeOutcome, getPerformanceHistory, recordLessonOutcome, updateDarwinWeights, getDarwinWeights, getDarwinAnalytics } from "./lessons.js";
import { executeTool, executeTrade, registerCronRestarter, registerPonyouControls, selectFilledExecutions } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled, createLiveMessage, formatPnLTable, sendHTML, fmt, htmlEscape, llmToTelegramHtml, handleCallMessage, registerBotCommands } from "./telegram.js";
import { startUserClient, stopUserClient, isUserClientEnabled, getUserClientStatus } from "./telegram-user-client.js";
import { startHunter, stopHunter, getSocialScore } from "./social-hunter.js";
import { startDiscordListener, stopDiscordListener } from "./discord-listener.js";
import {
  strategy, checkROI, run4FilterProtocol, getMcapTier, getTierExecutionProfile,
  checkPartialTP,
} from "./strategy.js";
import { buildRiskPolicy, evaluateExitPolicy } from "./risk-policy.js";
import {
  getStrategy, listStrategies, setActiveStrategy, setStrategyOverride,
  getActiveStrategyId, getActiveStrategyIds, setActiveStrategies, STRATEGY_IDS,
} from "./strategies.js";
import { matchStrategyForCoin } from "./tools/strategy-matcher.js";
import { detectInsiderPatterns } from "./tools/insider-detector.js";
import { evaluateFomoSetup } from "./tools/entry-fomo-guard.js";
import { evaluateSlowRug, recordLiquiditySample } from "./tools/slow-rug-detector.js";
import { evaluateDevActivity, recordDevSnapshot, extractDevWallet } from "./tools/dev-wallet-tracker.js";
import { evaluateVolumeDivergence, recordPriceVolumeSample } from "./tools/volume-divergence.js";
import { planExit } from "./tools/exit-timing-optimizer.js";
import { checkHolderExitSignals } from "./holder-exit-checks.js";
import { enrichHolderData } from "./tools/holder-data-enricher.js";
import {
  listPendingIntents, getIntent, consumeIntent, claimIntent, finalizeIntent,
} from "./intents.js";
import { trackPosition, recordClose, getTrackedPosition, getState, getStateSummary, syncOpenPositions, markPartialTPDone, updatePeakPnl, cleanStaleTestPositions, flushState, listTrackedPositions } from "./state.js";
import { shouldForceExitStalePaper, withPositionIdentity } from "./paper-wallet.js";
import { pruneClosedPositions } from "./state-pruner.js";
import { pruneOldSnapshots } from "./tools/holder-dump-monitor.js";
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
import {
  initCapitalGuard, reportCapital, checkCapitalGuard,
  resetCapitalGuardLayer, getCapitalGuardStatus,
} from "./capital-guard.js";
import {
  recordStreakOutcome, getStreakMultiplier, getStreakStatus, resetStreak,
} from "./streak-sizer.js";
import { checkRiskReward } from "./rr-guard.js";
import { runFastTrackBatch } from "./fast-buy.js";
import { startGeyserStream } from "./geyser.js";
import { attachExitMonitor, checkPriceDrop } from "./geyser-exit-monitor.js";
import { createRugMonitor, SEVERITY as RUG_SEVERITY } from "./rug-monitor.js";
import { wrapRugMonitorCallbacks } from "./tools/realtime-intel-bridge.js";
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
  rankChainsByActivity, getHottestChain, getAllChainIntelligence,
} from "./market-chain-intel.js";
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
  getNarrativeConviction, getProfitPatternSummary, getConvictionPromptLine, getRecentProfitMints,
} from "./conviction-memory.js";
import { runCodifierCycle, promoteSkillWithApproval, buildApprovalRequest } from "./agents/skill-codifier.js";
import { listStrategySkills, setStrategySkillStatus, setStrategySkillWeight, bootstrapFromPresets } from "./strategy-skills.js";
import { loadTrades } from "./backtest-data/loader.js";
import {
  buildTokenRegime, getRegimeAssessment, recordRegimeObservation, recordRegimeTradeOutcome,
} from "./regime-memory.js";
import { recordExecutionQuality, getExecutionQualityAssessment } from "./execution-quality-memory.js";
import { assessTradeAttribution, recordTradeAttribution } from "./trade-attribution.js";
import { harvestMarketRugs } from "./tools/rug-harvester.js";
import { outerShieldScreen } from "./tools/trash-filter.js";
import { runCommunityAssessment, getDevReputation, scoreDevReputation } from "./tools/community-detector.js";
import { startOnChainListener, getFreshOnChainCandidates, getOnChainListenerStatus } from "./tools/onchain-listener.js";
import { enrichCoin, coinGeckoToSocialVelocity, getTrendingCoins, getSolanaMarkets } from "./tools/coingecko-enrichment.js";
import { runHunterExpedition, injectHunterPrey, selectDeepScreenBatch, getHunterStats, getCachedPrey } from "./tools/hunter-agent.js";
import { getSmartMoneyCandidates, injectWalletPingCandidates, initWalletSignalInjector, checkRugDevDeployer, autoBlockRugDevToken, getWalletSignalStats } from "./tools/wallet-signal-injector.js";
import { getStrategyPositionLimit, canActivateStrategy, canEnterToken, getStrategyMinSolToActivate } from "./tools/position-limits.js";
import { computeTradeFeeBreakdown, calcTruePnl, calcDexFee, calcPlatformFee, extractSlippageFromSwapResult, recordTokenAccountCreated, recordSimCall } from "./tools/fee-tracker.js";
import { detectAnomaly, hasAnyActiveFlag } from "./tools/rug-anomaly.js";
import { analyzeRugWithLLM } from "./tools/rug-llm-analysis.js";
import { analyzeDexVisibilityRisk, RiskStatus as DexRiskStatus } from "./tools/dex-visibility-risk-analyzer.js";
import { simulateSell } from "./tools/sell-simulator.js";
import { screenDayPhaseTokens, isWeekendEntryWindow, isWeekdayExitWindow, formatWatchlistForNotification } from "./tools/day-phase-screener.js";
import { initStagedEntry, checkStagedEntryTrigger, advanceStagedEntry, getStage1Amount } from "./tools/staged-entry.js";
import { getRugCheckReport, rugCheckToSignals } from "./tools/rugcheck.js";
import { blacklistDev, checkDevBlacklist, getDevBlacklist } from "./tools/dev-blacklist.js";
import { recordNarrativeOutcome, detectNarrativeVelocity, trackCrossBatchVelocity, getCrossBatchVelocity } from "./tools/narratives.js";
import { aggregateSignal, triggeredSignals } from "./signal-aggregator.js";
import { computePortfolioDecision, rebalancePortfolioBook, recordSkillAttribution } from "./agents/portfolio-manager.js";
import { registerDefaultFeatures, runAllFeatures, listFeatures, getHealthSummary, enableFeature, disableFeature, autoResetBreakers } from "./feature-registry.js";
import { analyzeCabalPlay, CabalAgentAction } from "./tools/cabal-play-analyzer.js";
import { runAllMaintenance } from "./data-maintenance.js";
import { addSmartWallet, listSmartWallets } from "./smart-wallets.js";
import { importWalletInsight, getWalletPatternScore } from "./tools/wallet-insight-importer.js";
import { computeMarketRegime, getMaxPositions as getHeatmapMaxPositions } from "./market-heatmap.js";
import { discoverSmartWallets } from "./tools/wallet-discovery.js";
import { getVaultOverrides, getVaultContext, getVaultIntelligenceContext, getDevOverrides, getWalletOverrides, getSmartMoneyContext, getPatternOverrides, getChainOverrides } from "./tools/vault-reader.js";
import { logScreeningDecision, logTradeOutcome, refreshVaultSnapshots, ensureIntelligenceTemplates, logSkippedTokens, appendOperatorLesson } from "./tools/vault-writer.js";
import { runWatchdogCycle, collectLiveness, formatLivenessReport } from "./tools/health-watchdog.js";
import { bulkRegister as bulkRegisterTickers } from "./tools/ticker-registry.js";
import {
  isVaultDue, computeVaultAmount, executeVaultTransfer,
  recordVaultTransfer, getVaultStatus, buildVaultNotification, computeProfitSweepAmount,
} from "./vault.js";
import { isTokenOnCooldown, setTokenCooldown } from "./trade-cooldowns.js";
import { recordEpisode, getEpisodicBlock, getEpisodicSummaryBlock } from "./episodic-memory.js";
import { adaptDeployAmount, getAdaptiveRiskPromptLine } from "./adaptive-risk.js";
import { attributeOutcome, getLearnedRulesBlock }       from "./prompt-evolution.js";
import {
  generateDailyReport, formatReportTelegram, wasTodayReported,
} from "./daily-report.js";
import { getTokenInfo } from "./tools/token.js";
import {
  analyzeMomentum, checkEntryConfirmation,
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
import { VaultProposalEngine } from "./agents/vault-proposal.js";
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
await flushMetrics().catch((e) => log("metrics_warn", "startup metrics flush failed: " + e.message));
const executionMode = resolveExecutionMode();
log("startup", `Mode: ${executionMode.label}${executionMode.isDemo ? " — paper trading (mainnet data, simulated execution, no real SOL)" : " — live mainnet (real SOL)"}`);
import("./paper-wallet.js").then(({ isPaperMode, getPaperStartSol }) => {
  if (isPaperMode()) {
    log("startup", `📝 PAPER WALLET active — virtual balance ${getPaperStartSol()} SOL (fake). Trades simulate; balance derives from open positions.`);
    log("startup", "🧠 Learning shared with live — lessons, rug-memory, conviction, patterns accumulate here. Switch to live when readiness gate passes.");
  }
}).catch(() => {});
log("startup", `Model: ${process.env.LLM_MODEL || "minimax/minimax-m2.7"}`);

// Opt-in feature banner. These flags default OFF and live in user-config.json
// (gitignored), so a lost/renamed file silently disables them — it happened
// on 2026-06-10 and went unnoticed. One glance at startup beats discovering
// a dead subsystem days later.
{
  const onOff = (v) => (v ? "ON" : "off");
  const flags = [
    `portfolio=${config.portfolio?.enabled ? config.portfolio.mode : "off"}`,
    `skillLoop=${onOff(config.skillLoop?.enabled)}`,
    `vaultIntel=${onOff(config.vault?.intelligenceEnabled)}`,
    `episodic=${onOff(config.episodicMemory?.enabled)}`,
    `adaptiveRisk=${onOff(config.adaptiveRisk?.enabled)}`,
    `promptEvo=${onOff(config.promptEvolution?.enabled)}`,
    `proValidation=${config.pro?.validationMode === false ? "off" : executionMode.isDemo ? "ON(demo)" : "off(live)"}`,
    `proForceApprove=${onOff(config.pro?.forceApprove)}`,
    `gmgnKey=${process.env.GMGN_API_KEY ? "set" : "MISSING"}`,
    `shyftKey=${process.env.SHYFT_API_KEY ? "set" : "MISSING"}`,
  ];
  log("startup", `Opt-in features: ${flags.join(" | ")}`);
}

// Devnet faucet: auto-fund wallet with devnet SOL only when using devnet RPC.
// Paper-trading demo mode uses mainnet — no faucet needed.
if (executionMode.isDemo && (process.env.RPC_URL || "").includes("devnet")) {
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

// ─── Multi-Agent System Init ──────────────────────────
// Wire all 4 agents: Hunters, Screening, Management, General
registerAgent("hunters",    { role: "hunters",    healthCheck: () => getHuntersDashboard() });
registerAgent("screening",  { role: "screening",  healthCheck: () => getScreeningDashboard() });
registerAgent("management", { role: "management", healthCheck: () => ({ initialized: true }) });
registerAgent("general",    { role: "general",    healthCheck: () => ({ llmReady: !!getAgentRouter() }) });
registerAgent("trash-layer", { role: "hunters",   healthCheck: () => ({ initialized: true }) }); // gatekeeper between hunters→screening
registerAgent("orchestrator", { role: "screening", healthCheck: () => getOrchestratorDashboard() });

initHuntersAgent();
initScreeningAgent({
  runScreeningCycle: runScreeningCycle,
  checkAllGates: checkAllGates,
});
initManagementAgent({
  runManagementCycle: runManagementCycle,
  checkAllGates: checkAllGates,
  telegramEnabled: telegramEnabled,
  llmReviewEnabled: true,
});
// ── General Agent Controls — expose Ponyou state + actions to LLM ───────────
const _generalControls = {
  getStatus: () => {
    const market = getMarketIntelligence();
    const plan   = getPlanSummary();
    const positions = listTrackedPositions ? listTrackedPositions() : [];
    const activeStrat = getStrategy();
    return {
      automation_on:    cronStarted,
      market_condition: market.condition,
      market_description: market.description,
      active_strategy:  activeStrat?.id || "unknown",
      strategy_name:    activeStrat?.name || "unknown",
      open_positions:   positions.length,
      max_positions:    config.risk?.maxPositions || 3,
      today_pnl_pct:    plan?.today_pnl_pct ?? null,
      plan_day:         plan?.day ?? null,
      plan_days_total:  plan?.days_total ?? null,
      confirm_mode:     config.trading?.confirmMode ?? false,
    };
  },
  toggleAutomation: (enable) => {
    if (enable) startCronJobs();
    else stopCronJobs();
    return { automation_on: cronStarted, message: enable ? "Automation started" : "Automation stopped" };
  },
  switchStrategy: (id) => {
    if (!STRATEGY_IDS.includes(id)) return { error: `Unknown strategy: ${id}. Valid: ${STRATEGY_IDS.join(", ")}` };
    setActiveStrategy(id);
    const active = getStrategy();
    return { switched_to: id, strategy_name: active.name, description: active.description };
  },
  toggleFeature: (name, enable) => {
    if (enable) enableFeature(name);
    else disableFeature(name);
    return { feature: name, enabled: enable, message: `Feature "${name}" ${enable ? "enabled" : "disabled"}` };
  },
  getAgents: () => getAllAgentStatuses(),
  getOpenPositions: () => {
    const positions = listTrackedPositions ? listTrackedPositions() : [];
    return { positions, count: positions.length };
  },
  setConfirmMode: (enable) => {
    config.trading.confirmMode = enable;
    return { confirm_mode: enable, message: `Confirm mode ${enable ? "ON" : "OFF"}` };
  },

  // ── Trading Plan Management ──────────────────────────────────────────────
  getPlan: () => {
    const plan = getPlanSummary();
    return {
      day:                plan?.day ?? null,
      days_total:         plan?.days_total ?? null,
      today_pnl_pct:      plan?.today_pnl_pct ?? null,
      daily_target_pct:   config.management?.dailyTargetPct ?? 25,
      daily_stoploss_pct: config.management?.dailyStopLossPct ?? -10,
      deploy_amount_sol:  config.management?.deployAmountSol ?? 0.5,
      max_positions:      config.risk?.maxPositions ?? 3,
      pilot_capital_usd:  config.pilot?.capitalUsd ?? 10,
    };
  },
  updatePlan: ({ dailyTargetPct, dailyStopLossPct, maxPositions, deployAmountSol } = {}) => {
    const changed = [];
    if (Number.isFinite(dailyTargetPct) && dailyTargetPct > 0) {
      config.management.dailyTargetPct = dailyTargetPct;
      changed.push(`dailyTargetPct → ${dailyTargetPct}%`);
    }
    if (Number.isFinite(dailyStopLossPct) && dailyStopLossPct < 0) {
      config.management.dailyStopLossPct = dailyStopLossPct;
      changed.push(`dailyStopLossPct → ${dailyStopLossPct}%`);
    }
    if (Number.isFinite(maxPositions) && maxPositions >= 1) {
      config.risk.maxPositions = Math.round(maxPositions);
      changed.push(`maxPositions → ${maxPositions}`);
    }
    if (Number.isFinite(deployAmountSol) && deployAmountSol > 0) {
      config.management.deployAmountSol = deployAmountSol;
      changed.push(`deployAmountSol → ${deployAmountSol} SOL`);
    }
    return { updated: changed, message: changed.length > 0 ? `Updated: ${changed.join(", ")}` : "No valid changes" };
  },

  // ── Vault Memory (second brain) ──────────────────────────────────────────
  rememberLesson: (text, source = "user") => {
    appendOperatorLesson(text, source).catch(() => {});
    return { saved: true, message: `Pelajaran disimpan ke vault: "${text.slice(0, 60)}..."` };
  },
  getVaultSummary: () => {
    try {
      const ctx = getVaultIntelligenceContext();
      return { summary: ctx || "Vault belum memiliki data intelligence. Jalankan bot beberapa cycle dulu." };
    } catch {
      return { summary: "Vault summary tidak tersedia." };
    }
  },
};

initGeneralAgent({ agentLoop, config, controls: _generalControls });
registerPonyouControls(_generalControls);
initTrashLayer();
initLearningAgent(); // Continuous learning — monitors all hunters + patches trash-layer

// ── Social Hunter — Reddit/CoinGecko/Dex/Nitter/Discord/Telegram ──
registerAgent("social-hunter", {
  role: "hunters",
  healthCheck: () => ({ initialized: true, source: "social-signals.json" }),
});
if (config.useSocialHunter !== false) {
  startHunter();
  setAgentStatus("social-hunter", "running", "Social hunter active — Reddit + CoinGecko + Dex + Nitter");
}
startDiscordListener(); // no-op if DISCORD_BOT_TOKEN not set

initWalletSignalInjector();
initOrchestratorAgent({
  getStrategyFn: (id, opts) => getStrategy(id, opts),
  getMarketIntelFn: () => getMarketIntelligence(),
});
setFullAutomationMode(true); // Enable full automation

setAgentStatus("orchestrator", "running", "Orchestrator active — full automation workflow");
// Portfolio book bootstrap (Phase 2) — register the built-in presets as the
// initial active strategy-skills so the PortfolioManager has a book to run.
// Guarded by config.portfolio.enabled so the registry stays untouched (feature
// fully inert) until an operator opts in. Idempotent.
if (config.portfolio?.enabled) {
  try {
    const { added, total } = bootstrapFromPresets();
    log("portfolio", `book bootstrap: ${added} preset(s) registered (${total} total skills)`);
  } catch (e) { log("portfolio", `book bootstrap failed: ${e.message}`); }
}

initProOrchestrator(); // Pro mode — activates after automation approved
registerAgent("pro-orchestrator", { role: "screening", healthCheck: () => getProDashboard() });
const proDashboard = getProDashboard();
const proValidationMode = proDashboard?.agent?.validationMode === true;
setAgentStatus("pro-orchestrator", isProModeActive() ? "running" : "stopped",
  isProModeActive()
    ? (proValidationMode ? "PRO VALIDATION MODE — demo/paper only" : "PRO MODE — elite decision engine online")
    : "Pro mode locked — awaiting automation approval");
setAgentStatus("trash-layer", "running", "Trash layer active — gatekeeper between Hunters and Screening");
setAgentStatus("hunters", "running", "Hunters active — searching for prey");
setAgentStatus("screening", "running", "Screening active — pipeline ready");
setAgentStatus("management", "running", "Management active — monitoring positions");
setAgentStatus("general", "running", "General — chat & Telegram only (no trading)");

// Emit initial market state so agents know current condition
agentBus.emit("market:update", { condition: getMarketIntelligence().condition });

{
  const s = getDashboardSummary();
  const lockedSuffix = s.locked > 0 ? ` (${s.locked} locked)` : "";
  log("startup", `Multi-Agent System: ${s.running}/${s.expected} agents running${lockedSuffix}`);
}

// Strategy Evolution Engine — opt-in via config.strategy.evolution.enabled
// Two-stage opt-in:
//   strategy.evolution.enabled            → engine + composer + registry + gate live
//   strategy.fundamentalProducer.enabled  → producer also runs (defaults to dryRun)
let _fundamentalProducer = null;
let _evolutionEngine = null; // module-level for degradation cron access
let _strategyRegistry = null; // module-level so Telegram + dashboard can read evolved list
let _strategyProposal = null; // module-level for /approve_UUID /reject_UUID Telegram handlers
let _vaultProposal = null;    // module-level for /approve_vault_* /reject_vault_* handlers

// ── Vault Proposal Engine — bot mengajukan lesson/insight baru ke operator ──
_vaultProposal = new VaultProposalEngine({
  sendTelegram: sendHTML,
  getConfig: () => config,  // allows proposal gate toggle without restart
});
_vaultProposal.restorePending();

if (config.strategy?.evolution?.enabled) {
  _strategyRegistry = new StrategyRegistry({ persistPath: "./data/strategy-registry.json" });
  const _strategyBus = new StrategyEvolutionBus({ maxQueue: config.strategy.evolution.maxCandidateQueue ?? 5 });
  const _strategyGate = new StrategyGate({});
  _strategyProposal = new StrategyProposal({
    sendTelegram: sendMessage,
    autoApproveConvictionMin:   config.strategy.evolution.autoApproveConvictionMin ?? 0.95,
    autoApproveMinMaturityDays: config.strategy.fundamentalProducer?.minDataAgeDays ?? 30,
    proposalTimeoutMs:          (config.strategy.evolution.proposalTimeoutHours ?? 24) * 60 * 60 * 1000,
    // proposalEnabled gate: when false, strategy proposals auto-apply without Telegram approval
    proposalEnabled:            config.strategy.evolution.proposalEnabled !== false,
  });
  const _strategyComposer = new StrategyComposer({
    registry: _strategyRegistry,
    // LLM generator: calls the agent LLM with pro analysis context to create
    // novel strategy candidates. The producer throttles this to 1×/24h, so
    // cost is controlled. Returns null when pro mode is inactive.
    llmGenerator: async (context) => {
      const proIntel = isProModeActive() ? runProAnalysis() : null;
      const regimeList = proIntel?.regimes
        ? Object.entries(proIntel.regimes)
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, 3)
            .map(([name, data]) => `${name} (WR:${(data.winRate*100).toFixed(0)}%, score:${data.score.toFixed(2)})`)
            .join(", ")
        : "N/A";
      const narrativeList = proIntel?.narratives
        ? Object.entries(proIntel.narratives)
            .filter(([, d]) => d.recommendation === "STRONG_BUY" || d.recommendation === "BUY")
            .slice(0, 3)
            .map(([name, data]) => `${name} (WR:${(data.winRate*100).toFixed(0)}%, gems:${data.gems})`)
            .join(", ")
        : "N/A";
      const currentStrategies = [...(_strategyRegistry?.getAll?.() || [])]
        .filter(s => s.status === "active")
        .map(s => `${s.id} (WR:${((s.scores?.live ?? s.scores?.winRate ?? 0)*100).toFixed(0)}%)`)
        .join(", ");

      // Second Brain: pull learned rules, vault lessons, and episodic patterns
      // so the strategy LLM designs from actual live experience, not just market intel.
      const _sbLearnedRules   = config.promptEvolution?.enabled   ? getLearnedRulesBlock()        : null;
      const _sbVaultCtx       = config.vault?.intelligenceEnabled  ? getVaultIntelligenceContext() : getVaultContext();
      const _sbEpisodicPatts  = config.episodicMemory?.enabled     ? getEpisodicSummaryBlock()     : null;

      const prompt = [
        "You are a trading strategy designer for a Solana memecoin bot.",
        "Create ONE new strategy rule set as a JSON object. Be creative but safe.",
        "",
        "Current market intelligence:",
        `  Top regimes: ${regimeList}`,
        `  Top narratives: ${narrativeList}`,
        `  Active strategies: ${currentStrategies || "none yet"}`,
        "",
        "Evidence from fundamental signals:",
        `  ${JSON.stringify(context?.evidence?.scores || {})}`,
        ...(_sbEpisodicPatts  ? ["", _sbEpisodicPatts]  : []),
        ...(_sbLearnedRules   ? ["", _sbLearnedRules]   : []),
        ...(_sbVaultCtx       ? ["", _sbVaultCtx]       : []),
        "",
        "Output ONLY a JSON object with these fields:",
        '  {',
        '    "name": "strategy-name",',
        '    "regime": "HOT|NORMAL|COLD",',
        '    "rules": {',
        '      "signal": "fundamental-strong",',
        '      "minConviction": 65,',
        '      "maxRugScore": 25,',
        '      "minVolume": 5000,',
        '      "maxMcap": 5000000,',
        '      "stopLossPct": -15,',
        '      "takeProfitPct": 30',
        '    },',
        '    "source": "llm-generated"',
        '  }',
        "",
        "Rules must include at minimum a \"signal\" field. Do NOT add BUY/SELL action fields.",
        "Output ONLY the JSON, no markdown, no explanation.",
      ].join("\n");

      try {
        const { content } = await agentLoop(prompt, 4, [], "GENERAL", config.llm.generalModel, 1024);
        log("strategy_composer", `LLM generator response: ${(content || "").slice(0, 200)}`);
        return content;
      } catch (e) {
        log("strategy_composer_error", `LLM generation failed: ${e.message}`);
        return null;
      }
    },
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

export function getStrategyRegistry() {
  return _strategyRegistry;
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
  log("market_research", `AgentRouter enrichment saved via ${agentDisplayName(researchResult.agent)}`);
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
    const tokens = (balance.tokens || []).map(token => withPositionIdentity(token, balance.wallet));
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
      aggregate.tokens.push(withPositionIdentity(token, balance.wallet));
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
let _codifierBusy = false;
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

const CYCLE_RPC_TIMEOUT_MS = 45_000; // 45s timeout for RPC calls in cron cycles (mgmt)
// Screening scores up to 8 candidates, each with a sequential getTokenKlines
// network call (GeckoTerminal ~15s/token when Helius is OFF, Helius backoff can
// add more). 8 tokens × 20s = 160s worst-case; budget set to 180s so a slow-but-
// healthy cycle isn't killed mid-analysis. The busy-guard (_screeningBusy) still
// prevents overlap, and the 5-min cron interval >> this budget.
const SCREENING_CYCLE_TIMEOUT_MS = 180_000; // 180s — covers 8 tokens × ~20s klines

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
  const status = await decideDailyTradeGuard("stop", config.dailyTradeGuard);
  const ctx = buildDailyGuardLearningContext(status, source);
  const duration = config.dailyTradeGuard?.learningModeDurationMin || config.pilot.learningModeDurationMin;
  const activated = activateLearningMode(ctx, ctx.exit_reason, duration);
  if (activated && shouldRunAnalysis()) {
    runLossAnalysis().catch(e => log("learning_error", e.message));
  }
  return { status, activated };
}

async function handleDailyTradeGuardOutcome(isWin, meta = {}) {
  // recordDailyTradeOutcome is now async (file-locked). Await so the
  // threshold-trigger metadata is final before the Telegram notification
  // uses it.
  const result = await recordDailyTradeOutcome(isWin, meta, config.dailyTradeGuard);
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

  if (cmd === "/off") {
    await sendHTML(`🛑 <b>Shutdown requested</b> — graceful stop initiating…`);
    setTimeout(() => { shutdown("/off").catch(() => process.exit(0)); }, 100);
    return true;
  }

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
      fmt.it("/strategy /strategies /stratset /health /feature /confirm /dailyguard /auto /dayphase /devcheck /agent /pending /yes /no /pnl /status /plan /resetplan /vault_proposals /autonomy"),
    ];
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/alive") {
    try {
      const checks = collectLiveness();
      await sendHTML(formatLivenessReport(checks));
    } catch (e) {
      await sendHTML(`watchdog error: ${htmlEscape(e.message)}`);
    }
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
    const subCmd = parts[1];
    const activeIds = getActiveStrategyIds();

    // /strategies add <id> [id2 ...]
    if (subCmd === "add") {
      const toAdd = parts.slice(2);
      if (toAdd.length === 0) { await sendHTML("Usage: /strategies add <id> [id2...]"); return true; }
      const invalid = toAdd.filter(id => !STRATEGY_IDS.includes(id));
      if (invalid.length > 0) { await sendHTML(`❌ Unknown: ${invalid.join(", ")}. Valid: ${STRATEGY_IDS.join(", ")}`); return true; }
      const newIds = [...new Set([...activeIds, ...toAdd])];
      setActiveStrategies(newIds);
      await sendHTML(`✅ Active strategies: <code>${newIds.join(", ")}</code>`);
      return true;
    }

    // /strategies remove <id>
    if (subCmd === "remove") {
      const toRemove = parts[2];
      if (!toRemove) { await sendHTML("Usage: /strategies remove <id>"); return true; }
      const newIds = activeIds.filter(id => id !== toRemove);
      if (newIds.length === 0) { await sendHTML("❌ Cannot remove all strategies. Keep at least one."); return true; }
      setActiveStrategies(newIds);
      await sendHTML(`✅ Removed <code>${toRemove}</code>. Active: <code>${newIds.join(", ")}</code>`);
      return true;
    }

    // /strategies set <id1> [id2 id3 ...]
    if (subCmd === "set") {
      const ids = parts.slice(2);
      if (ids.length === 0) { await sendHTML("Usage: /strategies set <id1> [id2 id3...]"); return true; }
      const invalid = ids.filter(id => !STRATEGY_IDS.includes(id));
      if (invalid.length > 0) { await sendHTML(`❌ Unknown: ${invalid.join(", ")}. Valid: ${STRATEGY_IDS.join(", ")}`); return true; }
      setActiveStrategies(ids);
      await sendHTML(`✅ Active strategies: <code>${ids.join(", ")}</code>`);
      return true;
    }

    // /strategies all
    if (subCmd === "all") {
      setActiveStrategies(STRATEGY_IDS);
      await sendHTML(`✅ All strategies active: <code>${STRATEGY_IDS.join(", ")}</code>`);
      return true;
    }

    // /strategies reset — back to single primary
    if (subCmd === "reset") {
      const primary = getActiveStrategyId();
      setActiveStrategies([primary]);
      await sendHTML(`✅ Reset to single strategy: <code>${primary}</code>`);
      return true;
    }

    // /strategies evolved — list evolved registry
    if (subCmd === "evolved") {
      const evolved = (_strategyRegistry?.getAll?.() || []).filter(s => s.status === "active");
      if (evolved.length === 0) {
        await sendHTML("🧬 <b>Evolved Strategies</b>\n\nNo evolved strategies active yet.\nRun the bot in demo mode to collect data; the producer auto-generates candidates.");
        return true;
      }
      const lines = [`🧬 <b>Evolved Strategies</b> (${evolved.length} active)`, fmt.divider()];
      for (const s of evolved) {
        const wr = s.scores?.live ?? s.scores?.paper ?? s.scores?.backtest ?? null;
        const wrStr = wr != null ? ` WR ${(wr * 100).toFixed(0)}%` : "";
        lines.push(`● <b>${htmlEscape(s.name)}</b> [${s.id.slice(0, 8)}]${wrStr}`);
        lines.push(`   regime: ${s.regime || "any"} · activated: ${s.activatedAt?.slice(0, 10) || "?"}`);
      }
      lines.push(``, fmt.it("/strategies deactivate <id8> — deactivate an evolved strategy"));
      await sendHTML(lines.join("\n"));
      return true;
    }

    // /strategies deactivate <id> — deactivate an evolved strategy
    if (subCmd === "deactivate") {
      const shortId = parts[2];
      if (!shortId) { await sendHTML("Usage: /strategies deactivate <id8> (first 8 chars of evolved ID)"); return true; }
      const all = _strategyRegistry?.getAll?.() || [];
      const match = all.find(s => s.id === shortId || s.id.startsWith(shortId));
      if (!match) { await sendHTML(`❌ Evolved strategy <code>${shortId}</code> not found.`); return true; }
      _strategyRegistry.deactivate(match.id, "operator deactivated via Telegram");
      await sendHTML(`✅ Evolved strategy <b>${htmlEscape(match.name)}</b> deactivated.`);
      return true;
    }

    // /strategies — list (presets + evolved summary)
    const list = listStrategies();
    const evolvedActive = (_strategyRegistry?.getAll?.() || []).filter(s => s.status === "active");
    const lines = [`🎯 <b>Strategies</b> (active: ${activeIds.join(", ")})`, fmt.divider()];
    for (const s of list) {
      const isActive = activeIds.includes(s.id);
      const mark = isActive ? "●" : "○";
      const llmTag = s.use_llm ? "LLM" : "rule";
      lines.push(`${mark} <b>${htmlEscape(s.id)}</b> — ${htmlEscape(s.name)} [${llmTag}]`);
      lines.push(`   SL ${s.stoploss_pct.toFixed(1)}% · trail ${s.trailing ? "on" : "off"} · partTP ${htmlEscape(String(s.partial_tp))}`);
    }
    if (evolvedActive.length > 0) {
      lines.push(``, `🧬 <b>Evolved</b> (${evolvedActive.length} active — auto-applied by runtime selector):`);
      for (const s of evolvedActive) {
        const wr = s.scores?.live ?? s.scores?.paper ?? s.scores?.backtest ?? null;
        lines.push(`  ● <b>${htmlEscape(s.name)}</b> [${s.id.slice(0, 8)}] regime=${s.regime || "any"}${wr != null ? ` WR ${(wr * 100).toFixed(0)}%` : ""}`);
      }
      lines.push(fmt.it("/strategies evolved — full evolved list"));
    } else {
      lines.push(``, fmt.it("🧬 No evolved strategies yet — /strategies evolved for details"));
    }
    lines.push(``, fmt.it("Commands:"));
    lines.push(fmt.it("/strategies set degen scalping — activate 2 strategies"));
    lines.push(fmt.it("/strategies add scalping — add to active set"));
    lines.push(fmt.it("/strategies remove degen — remove from active set"));
    lines.push(fmt.it("/strategies all — activate all strategies"));
    lines.push(fmt.it("/strategies reset — back to single strategy"));
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/strategy") {
    const id = parts[1];
    if (!id) {
      const activeIds = getActiveStrategyIds();
      const active = getStrategy();
      const modeLabel = activeIds.length > 1 ? `Multi [${activeIds.join(", ")}]` : `Single [${active.id}]`;
      await sendHTML(`🎯 Mode: <b>${modeLabel}</b>\nPrimary: <b>${active.name}</b> (<code>${active.id}</code>)\nSwitch: /strategy &lt;id&gt;\nMulti: /strategies set degen scalping`);
      return true;
    }
    if (!STRATEGY_IDS.includes(id)) {
      await sendHTML(`❌ Unknown strategy <code>${id}</code>. Valid: ${STRATEGY_IDS.join(", ")}`);
      return true;
    }
    setActiveStrategy(id); // single-strategy mode: resets to [id]
    setActiveStrategies([id]);
    const active = getStrategy();
    await sendHTML(`✅ Switched to single strategy: <b>${active.name}</b> (<code>${id}</code>)\n${active.description}`);
    return true;
  }

  if (cmd === "/chains") {
    // Persist gmgnChains to user-config.json AND mutate the live config so the
    // next hunter expedition picks it up without a restart (hunter reads
    // config.gmgn.chains each cycle). Execution flags (execEnabled/wallets) stay
    // in user-config.json for safety — chain selection here is discovery-facing.
    const sub = parts[1];
    const cur = Array.isArray(config.gmgn?.chains) && config.gmgn.chains.length ? config.gmgn.chains : ["sol"];
    const persistChains = async (next) => {
      const valid = [...new Set(next.map(c => String(c).toLowerCase()).filter(c => GMGN_CHAINS.includes(c)))];
      if (valid.length === 0) return null;
      config.gmgn.chains = valid; // live effect on next hunt
      const { default: fs } = await import("fs");
      const { default: path } = await import("path");
      const { fileURLToPath } = await import("url");
      const ucPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "user-config.json");
      let uc = {};
      try { if (fs.existsSync(ucPath)) uc = JSON.parse(fs.readFileSync(ucPath, "utf8")); } catch {}
      uc.gmgnChains = valid;
      atomicWriteJson(ucPath, uc);
      return valid;
    };

    if (sub === "status") {
      // Per-chain activity intel recorded by the hunter after GMGN fetches.
      const intel = getAllChainIntelligence(); // Map<chain, snapshot> (fresh only)
      const ranking = rankChainsByActivity();
      const hottest = getHottestChain("sol");
      const lines = [`⛓️ <b>Chain Activity</b>`, fmt.divider()];
      if (intel.size === 0) {
        lines.push(`No fresh per-chain data yet (hunter records it after a GMGN fetch).`);
        lines.push(``, `Active discovery chains: <b>${cur.join(", ")}</b>`);
      } else {
        const condEmoji = { EXTREME: "🔥🔥", HOT: "🔥", NORMAL: "🟢", COLD: "🟦", DEAD: "💤" };
        for (const snap of ranking) {
          const m = snap.metrics || {};
          const hot = snap.chain === hottest ? " ⭐" : "";
          lines.push(`${condEmoji[snap.condition] || "•"} <code>${snap.chain}</code> ${snap.condition} — score <b>${snap.score}</b>${hot}`);
          lines.push(`   swaps≈${m.avg_swaps ?? 0} · vol $${Math.round((m.vol_usd ?? 0) / 1000)}k · tokens ${m.token_count ?? 0} · buy${Math.round((m.buy_ratio ?? 0) * 100)}%${m.rug_active_count ? ` · rugs ${m.rug_active_count}` : ""}`);
        }
        lines.push(``, `Hottest chain: <b>${hottest}</b>`);
      }
      await sendHTML(lines.join("\n"));
      return true;
    }

    if (sub === "set" || sub === "add" || sub === "remove") {
      const args = parts.slice(2).map(c => c.toLowerCase());
      if (args.length === 0) { await sendHTML(`Usage: /chains ${sub} sol base`); return true; }
      const invalid = args.filter(c => !GMGN_CHAINS.includes(c));
      if (invalid.length && sub !== "remove") { await sendHTML(`❌ Unknown: ${invalid.join(", ")}. Valid: ${GMGN_CHAINS.join(", ")}`); return true; }
      let next;
      if (sub === "set") next = args;
      else if (sub === "add") next = [...cur, ...args];
      else next = cur.filter(c => !args.includes(c));
      if (next.length === 0) { await sendHTML("❌ At least one chain must stay active (sol is the safe default)."); return true; }
      const saved = await persistChains(next);
      if (!saved) { await sendHTML(`❌ No valid chains. Valid: ${GMGN_CHAINS.join(", ")}`); return true; }
      const evmOn = saved.some(c => c !== "sol");
      await sendHTML([
        `✅ Active chains: <code>${saved.join(", ")}</code>`,
        `Discovery takes effect next hunt (no restart needed).`,
        evmOn ? `\n⚠️ EVM execution stays OFF until you set <code>gmgnExecEnabled:true</code> + <code>gmgnWallets</code> in user-config.json and RESTART. Discovery is read-only.` : ``,
      ].filter(Boolean).join("\n"));
      return true;
    }

    // /chains — show status
    const execOn = config.gmgn?.execEnabled === true;
    const lines = [`⛓️ <b>Chains</b>`, fmt.divider()];
    for (const c of GMGN_CHAINS) {
      const active = cur.includes(c);
      lines.push(`${active ? "●" : "○"} <code>${c}</code>${c === "sol" ? " (native — Jupiter exec)" : " (GMGN exec)"}`);
    }
    lines.push(``, `Discovery: <b>${cur.join(", ")}</b>`);
    lines.push(`EVM execution: <b>${execOn ? "ON" : "OFF (dry-run/discovery only)"}</b>`);
    lines.push(``, fmt.it("/chains set sol base — activate sol + base discovery"));
    lines.push(fmt.it("/chains add base · /chains remove base"));
    lines.push(fmt.it("/chains status — per-chain activity ranking"));
    await sendHTML(lines.join("\n"));
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

  // ─── Strategy-Skill governance (Phase 3 manual approval gate) ──
  if (cmd === "/skills") {
    const all = listStrategySkills();
    if (all.length === 0) { await sendHTML("No strategy-skills registered yet."); return true; }
    const byStatus = { active: [], shadow: [], draft: [], retired: [] };
    for (const s of all) (byStatus[s.status] || (byStatus[s.status] = [])).push(s);
    const lines = ["<b>Strategy-Skills</b>"];
    for (const st of ["active", "shadow", "draft"]) {
      const list = byStatus[st] || [];
      if (list.length === 0) continue;
      lines.push(`\n<b>${st.toUpperCase()}</b>`);
      for (const s of list) {
        const loop = s.provenance?.author === "loop" ? " 🤖" : "";
        const ready = st === "shadow" && buildApprovalRequest(s.id) ? " ✅<i>ready</i>" : "";
        lines.push(`• <code>${s.id}</code> w=${(s.weight || 0).toFixed(2)}${loop}${ready}`);
      }
    }
    lines.push(`\nPromote: <code>/promoteskill &lt;id&gt;</code> · Reject: <code>/rejectskill &lt;id&gt;</code>`);
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/promoteskill") {
    const id = parts[1];
    if (!id) { await sendHTML("Usage: <code>/promoteskill &lt;id&gt;</code>"); return true; }
    try {
      const skill = promoteSkillWithApproval(id, { approved: true });
      await sendHTML(`✅ Promoted <code>${id}</code> → <b>active</b> @ weight ${skill.weight} (manually approved)`);
    } catch (e) {
      await sendHTML(`❌ Cannot promote <code>${id}</code>: ${e.message}`);
    }
    return true;
  }

  if (cmd === "/rejectskill") {
    const id = parts[1];
    if (!id) { await sendHTML("Usage: <code>/rejectskill &lt;id&gt;</code>"); return true; }
    try {
      setStrategySkillStatus(id, "retired");
      await sendHTML(`🗑️ Retired <code>${id}</code>`);
    } catch (e) {
      await sendHTML(`❌ ${e.message}`);
    }
    return true;
  }

  if (cmd === "/skillweight") {
    const id = parts[1];
    const w = Number(parts[2]);
    if (!id || !Number.isFinite(w)) { await sendHTML("Usage: <code>/skillweight &lt;id&gt; &lt;0..1&gt;</code> — set a strategy's weight in the portfolio book (0 = out)"); return true; }
    try {
      const skill = setStrategySkillWeight(id, w);
      await sendHTML(`✅ <code>${id}</code> book weight = ${skill.weight}`);
    } catch (e) {
      await sendHTML(`❌ ${e.message}`);
    }
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
      await decideDailyTradeGuard("reset", config.dailyTradeGuard);
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
    const s = await decideDailyTradeGuard("continue", config.dailyTradeGuard);
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
    await consumeIntent(id, "rejected", { rejected_by: "telegram" });
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

  if (cmd === "/web") {
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "on" || sub === "off") {
      const pm2Cmd = sub === "on" ? "pm2 start ponyou-dashboard" : "pm2 stop ponyou-dashboard";
      const { exec } = await import("child_process");
      const err = await new Promise((resolve) => exec(pm2Cmd, (e) => resolve(e)));
      if (err) {
        await sendHTML(`⚠️ <b>Gagal ${sub === "on" ? "menyalakan" : "mematikan"} dashboard.</b>\n<code>${htmlEscape(err.message.slice(0, 300))}</code>`);
        return true;
      }
      await sendHTML(sub === "on"
        ? "🌐 <b>Website Dashboard diaktifkan.</b>\nAkses di <code>http://[IP-VPS]:3000</code>"
        : "🛑 <b>Website Dashboard dimatikan.</b>\nResource VPS kembali dihemat.");
      return true;
    }
    await sendHTML("Gunakan <code>/web on</code> untuk menyalakan dashboard, dan <code>/web off</code> untuk mematikan.");
    return true;
  }

  if (cmd === "/guard") {
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "reset") {
      const layerNum = parseInt(parts[2], 10);
      if (![1, 2, 3].includes(layerNum)) {
        await sendHTML("Gunakan <code>/guard reset 1|2|3</code>.\nLayer 4 = kill switch — reset lewat <code>/unkill</code>.");
        return true;
      }
      const ok = resetCapitalGuardLayer(layerNum);
      await sendHTML(ok
        ? `✅ Capital guard layer ${layerNum} di-reset. Baseline di-rebase ke balance terakhir agar tidak langsung trip lagi.`
        : `Layer ${layerNum} tidak sedang aktif.`);
      return true;
    }
    const s = getCapitalGuardStatus();
    const lines = [
      `🛡 <b>Capital Guard</b> ${config.capitalGuard?.enabled ? "(aktif)" : "(NONAKTIF — set capitalGuard.enabled di user-config.json)"}`,
      s.blocked ? `⛔ BLOCKED L${s.active_level}: ${htmlEscape(s.reason || "")}` : "✅ Tidak memblokir entry",
      s.resume_at ? `Resume: <code>${htmlEscape(s.resume_at)}</code>` : null,
      `Daily PnL: ${s.daily_pnl_pct != null ? s.daily_pnl_pct + "%" : "?"} (start $${s.daily_start_usd ?? "?"})`,
      `Peak DD: ${s.peak_dd_pct != null ? s.peak_dd_pct + "%" : "?"} (peak $${s.peak_capital_usd ?? "?"})`,
      `L1 ${s.layer1 ? "🟡 tripped" : "—"} · L2 ${s.layer2 ? "🔴 tripped" : "—"} · L3 ${s.layer3 ? "⛔ tripped" : "—"} · L4 ${s.layer4_tripped ? "🛑 HALT" : "—"}`,
      "Reset layer: <code>/guard reset 1|2|3</code>",
    ].filter(Boolean);
    await sendHTML(lines.join("\n"));
    return true;
  }

  if (cmd === "/streak") {
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "reset") {
      resetStreak();
      await sendHTML("✅ Streak multiplier di-reset ke 1.0.");
      return true;
    }
    const s = getStreakStatus(config.streakSizer || {});
    await sendHTML([
      `🎲 <b>Streak Sizer</b> ${config.streakSizer?.enabled ? "(aktif)" : "(NONAKTIF — set streakSizer.enabled di user-config.json)"}`,
      `Multiplier: <b>${s.multiplier}×</b>${s.at_floor ? " (floor)" : s.at_ceiling ? " (ceiling)" : ""}`,
      `Streak: ${s.win_streak > 0 ? `📈 ${s.win_streak} win` : s.loss_streak > 0 ? `📉 ${s.loss_streak} loss` : "—"}`,
      `Total: ${s.total_wins}W / ${s.total_losses}L`,
      "Reset: <code>/streak reset</code>",
    ].join("\n"));
    return true;
  }

  if (cmd === "/wallets") {
    // Subcommand: /wallets on|off → toggle multi-wallet mode (persists to
    // user-config.json; takes effect after restart since config is pinned at start).
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "on" || sub === "off") {
      const enable = sub === "on";
      // Persist to user-config.json (same direct pattern as /chains).
      // Config is pinned at process start, so this takes effect after restart.
      try {
        const { default: fs } = await import("fs");
        const { default: path } = await import("path");
        const { fileURLToPath } = await import("url");
        const ucPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "user-config.json");
        let uc = {};
        try { if (fs.existsSync(ucPath)) uc = JSON.parse(fs.readFileSync(ucPath, "utf8")); } catch {}
        uc.multiWalletEnabled = enable;
        atomicWriteJson(ucPath, uc);
      } catch (e) {
        await sendHTML(`❌ Gagal menyimpan: ${htmlEscape(e.message)}`);
        return true;
      }
      const cfgWallets = Array.isArray(config.multiWallet?.wallets) ? config.multiWallet.wallets : [];
      const lines = [
        `💼 <b>Multi-Wallet: ${enable ? "ON" : "OFF"}</b>`,
        ``,
        enable
          ? (cfgWallets.length >= 2
              ? `✓ ${cfgWallets.length} wallet slot terkonfigurasi`
              : `⚠️ Hanya ${cfgWallets.length} slot — tambahkan minimal 2 wallet di <code>user-config.json</code> "wallets" + set key di .env (WALLET_KEY_1..10)`)
          : `Mode single-wallet aktif (pakai WALLET_PRIVATE_KEY)`,
        ``,
        fmt.it("⟳ RESTART bot agar perubahan berlaku — config di-pin saat start."),
      ];
      await sendHTML(lines.join("\n"));
      return true;
    }

    const wallets = getAllWallets();
    if (!wallets.length || !isMultiWalletEnabled()) {
      const active = getActiveWallet();
      await sendHTML(
        `💼 <b>Wallets</b> · Single-wallet mode\n` +
        (active ? `<code>${htmlEscape(active.address.slice(0, 20))}…</code>` : fmt.it("tidak terkonfigurasi")) +
        `\n\n${fmt.it("/wallets on — aktifkan multi-wallet")}`
      );
      return true;
    }
    const lines = [`💼 <b>Wallets</b> · Multi-wallet`, fmt.divider()];
    for (const w of wallets) {
      const icon = w.status === "hot" ? "🟢" : w.status === "cold" ? "🔴" : "⚫";
      const activeTag = w.is_active ? " ← <b>aktif</b>" : "";
      const coldStr = w.status === "cold" && w.cold_until > Date.now()
        ? ` · recover ${Math.ceil((w.cold_until - Date.now()) / 60000)}m`
        : "";
      lines.push(`${icon} ${htmlEscape(w.label)} · ${w.capital_pct}% · err:${w.error_count}${coldStr}${activeTag}`);
      lines.push(`   <code>${htmlEscape(w.address.slice(0, 20))}…</code>`);
    }
    lines.push(``, fmt.it("/wallets off — kembali ke single-wallet"));
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
  if (intent.expires_at && Date.now() > new Date(intent.expires_at).getTime()) {
    await consumeIntent(id, "expired");
    return sendHTML(`⏰ #${id} ${fmt.it("expired")}`);
  }

  // Atomically claim before swap — prevents double-execution if two /yes arrive simultaneously
  const claimed = await claimIntent(id);
  if (!claimed) return sendHTML(`⚠️ #${id} ${fmt.it("already " + (intent.status || "claimed"))}`);

  const gate = await checkAllGates("pending-intent");
  if (gate.blocked) {
    await finalizeIntent(id, "failed", { error: gate.reason });
    return sendHTML("⛔ #" + id + " blocked\n" + fmt.code(gate.reason));
  }


  await sendHTML(`⏳ Eksekusi #${id}…`);
  const { args } = intent;
  let result;
  const swapStartedAt = Date.now();
  try {
    result = await executeTrade({ ...args, executionContext: { source: "pending-intent", approvedIntent: true } });
  } catch (e) {
    await finalizeIntent(id, "failed", { error: e.message });
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
  // Partial-fill aware: a split swap can report overall failure while some
  // legs already filled (SOL spent, tokens held). Track those filled legs
  // instead of orphaning the live positions.
  const filledLegs = Array.isArray(result?.executions) && result.executions.length > 0
    ? result.executions.filter(e => e.success || e.dry_run)
    : [];
  if (!succeeded && filledLegs.length === 0) {
    await finalizeIntent(id, "failed", { error: result?.error || "unknown" });
    return sendHTML(`❌ #${id} swap rejected\n${fmt.code(JSON.stringify(result).slice(0, 200))}`);
  }

  // Wire up position tracking the same way the screening LLM path does.
  let symbol = args.token_out?.slice(0, 8) || "TOKEN";
  let initial_value_usd = 0;
  let solPriceUsd = 0;
  let intentEntryPriceUsd = 0;
  try {
    const tokenInfo = await getTokenInfo({ query: args.token_out });
    symbol = tokenInfo?.results?.[0]?.symbol || symbol;
    // C2: capture entry price for checkPriceDrop emergency exit gate.
    intentEntryPriceUsd = Number(tokenInfo?.results?.[0]?.price || 0);
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
  const executions = selectFilledExecutions(result, {
    wallet_address: result?.wallet_address || args.wallet_address || getActiveWallet()?.address || null,
    amount: args.amount,
  });
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
        entry_price: intentEntryPriceUsd,
        market_condition: getMarketIntelligence().condition,
        workflow: { verdict: "manual" },
        execution_context: {
          wallet_address: walletAddress,
          provider: result?.execution_provider || "auto",
          slippage: Number(args.slippage || result?.slippage || 0),
        },
      },
      wallet_address: walletAddress,
      chain: (args.chain || "sol").toLowerCase(),
      paper_trade: process.env.DRY_RUN === 'true' || process.env.PAPER_TRADING === 'true',
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
  const partialFill = !succeeded && filledLegs.length > 0;
  await finalizeIntent(id, "executed", {
    result: result?.hash || result?.signature || "ok",
    ...(partialFill ? { partial_fill: true, error: result?.error || "partial split fill" } : {}),
  });

  return sendHTML(
    `${partialFill ? "⚠️" : "✅"} <b>Intent #${id}${partialFill ? " (partial fill)" : ""}</b>\n` +
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

  // 1. Capital guard — 4-layer timed hard stops (daily PnL %, peak drawdown).
  //    Only checked for entry-generating cycles; management exits are always allowed
  //    so open risk can still be reduced when the guard is active.
  if (["screening", "geyser", "pending-intent", "fast-track", "hunters"].includes(source)) {
    if (config.capitalGuard?.enabled) {
      const cgState = checkCapitalGuard();
      if (cgState.blocked) {
        log("capital_guard", `Gate [${source}]: L${cgState.level} blocked — ${cgState.reason}`);
        return { blocked: true, reason: `CAPITAL_GUARD_L${cgState.level}: ${cgState.reason}` };
      }
    }
  }

  // 2. Rug wave circuit breaker
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
    log("plan_warn", `refreshSessionPnl skipped: invalid totalUsd=${totalUsd} (${executionMode.mode})`);
    return;
  }
  // Prevent date rollover race: skip P&L updates in the first 2 minutes of the UTC day
  // to let the midnight advance cron run first and record the day's P&L.
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 2) {
    log("plan", `refreshSessionPnl skipped during midnight rollover window to prevent race condition`);
    return;
  }
  // Kill-switch drawdown check: anchored to the first valid balance the bot
  // observed this session. setSessionBaseline is idempotent, so re-calling is
  // cheap. reportBalance returns true if it just tripped the switch.
  setSessionBaseline(totalUsd);
  setGauge("wallet_total_usd", totalUsd);
  reportBalance(totalUsd);

  // Capital guard — 4-layer timed hard stops. Runs after kill-switch so the
  // kill-switch flag is already set if layer 4 fires; no double-notification.
  if (config.capitalGuard?.enabled) {
    initCapitalGuard(totalUsd);
    const cgTrip = reportCapital(totalUsd, config.capitalGuard);
    if (cgTrip.tripped) {
      const emoji = ["", "🟡", "🔴", "⛔", "🛑"][cgTrip.level] || "⚠️";
      const cgStatus = getCapitalGuardStatus(totalUsd);
      if (telegramEnabled()) {
        sendHTML(
          `${emoji} <b>Capital Guard L${cgTrip.level} tripped</b>\n` +
          `${cgTrip.reason}\n` +
          (cgStatus.resume_at
            ? `Resume: <code>${new Date(cgStatus.resume_at).toUTCString()}</code>`
            : "Permanent halt — reset kill switch to resume")
        );
      }
    }
  }

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

async function checkDeterministicExits(tokens, { solPriceUsd = 0 } = {}) {
  const exits = [];
  const market = getMarketIntelligence();
  const condition = market.condition || "NORMAL";

  // G3: per-position strategy. Each tracked position records the strategy
  // its entry was opened under (strategy_used). Use that for exit policy
  // (stoploss/ROI ladder/trailing) so positions opened under day_phase
  // don't suddenly inherit scalping exits if the operator rotated the
  // active strategy mid-flight. Fall back to the global active strategy
  // when a position predates this feature.
  const activeStrategyDefault = getStrategy(null, { regime: condition });

  for (const token of tokens) {
    const tracked = getTrackedPosition(token.position_key || token.mint, token.wallet_address || null);
    if (!tracked) continue;
    const positionStrategy = tracked.strategy_used
      ? getStrategy(tracked.strategy_used, { regime: condition })
      : activeStrategyDefault;
    const riskPolicy = buildRiskPolicy({
      marketCondition: condition,
      token,
      config,
      strategyParams: positionStrategy,
    });

    const ageMinutes = (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000;

    // Exp #7: unquotable stale paper position. No live quote → token.usd never
    // moves off cost basis → no PnL gate can ever close it → it wedges the book
    // at the position limit. After the grace window treat the token as dead.
    if (shouldForceExitStalePaper({
      tracked,
      token,
      ageMinutes,
      staleExitMinutes: config.risk?.paperStaleExitMinutes ?? 360,
    })) {
      log("exit_signal", `Stale unquotable paper position ${token?.mint?.slice(0, 8)} (age ${Math.round(ageMinutes)}m) — force exit`);
      exits.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: "paper_stale_unquotable",
        pnl_pct: -100,
        is_loss: true,
        wallet_address: token.wallet_address || null,
        position_key: token.position_key || token.mint,
        chain: token.chain || tracked.chain || "sol",
      });
      continue;
    }

    // C1: pnl_unknown positions have initial_value_usd=0 because solPriceUsd was 0
    // at entry time. Attempt a one-time backfill using the current cycle's SOL price
    // so PnL gates can start firing. Without this, a pnl_unknown position reports
    // permanent 0% PnL and all deterministic exits are silently disabled.
    if (tracked.pnl_unknown === true && tracked.amount_sol > 0 && solPriceUsd > 0) {
      const backfill = tracked.amount_sol * solPriceUsd;
      tracked.initial_value_usd = backfill;
      tracked.pnl_unknown = false;
      // Persist so subsequent cycles don't need to re-backfill.
      flushState && flushState().catch(() => {});
      log("exit", `Backfilled initial_value_usd=${backfill.toFixed(2)} for ${token?.mint?.slice(0, 8)} (was pnl_unknown)`);
    }

    const pnlKnown = tracked.pnl_unknown !== true && tracked.initial_value_usd > 0;
    const currentPnlPct = pnlKnown
      ? ((token.usd - tracked.initial_value_usd) / tracked.initial_value_usd) * 100
      : 0;
    if (!pnlKnown) {
      log("exit", `${token?.mint?.slice(0, 8)} pnl_unknown — PnL gates skipped; price-drop exit still active`);
    }
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
      let dropReason = null;
      const dropped = checkPriceDrop(
        { ...tracked, mint: token.mint, entry_price: entryPrice },
        currentPrice,
        (mint, reason, detail) => {
          dropReason = `${reason}: ${detail}`;
          log("exit_signal", `Price drop signal: ${mint.slice(0, 8)} — ${reason}: ${detail}`);
          if (telegramEnabled()) {
            sendHTML(`⚠️ <b>Price Drop Alert</b>\nMint: <code>${mint.slice(0, 8)}</code>\n${detail}`).catch(() => {});
          }
        }
      );
      if (dropped) {
        log("exit_signal", `Emergency price drop detected for ${token?.mint?.slice(0, 8)}`);
        exits.push({
          mint: token.mint,
          symbol: token.symbol,
          reason: dropReason || "price_drop_emergency",
          pnl_pct: currentPnlPct,
          is_loss: true,
          wallet_address: token.wallet_address || null,
          position_key: token.position_key || token.mint,
          chain: token.chain || tracked.chain || "sol",
        });
        continue;
      }

    // Persist the new peak — mutating `tracked` in memory isn't enough because
    // a restart wipes the cache and resets the trailing-stop reference to 0.
    // C1: only update peak when PnL is real; phantom 0 must not overwrite a true peak.
    if (pnlKnown && currentPnlPct > (tracked.peak_pnl_pct || 0)) {
      tracked.peak_pnl_pct = currentPnlPct;
      updatePeakPnl(token.position_key || token.mint, currentPnlPct, token.wallet_address || null);
    }

    // ── Intel layer (S2+S3+S5): per-held-position sampling + alerts ─────
    // Record liquidity / price+volume / dev-wallet snapshots so detectors
    // have rolling history. Then evaluate slow-rug, dev-sell, volume-divergence.
    try {
      const liqUsd = Number(token?.liquidity_usd ?? token?.liquidity ?? 0);
      if (liqUsd > 0) {
        await recordLiquiditySample({
          mint: token.mint,
          liquidity_usd: liqUsd,
          price_usd: currentPrice,
        });
      }
      if (currentPrice > 0) {
        await recordPriceVolumeSample({
          mint: token.mint,
          price_usd: currentPrice,
          volume_recent_usd: Number(token?.volume_5m_usd ?? token?.volume_5m ?? token?.volume_recent_usd ?? 0),
        });
      }
      const devWallet = extractDevWallet(token) || tracked?.signal_snapshot?.creator_wallet;
      const devBalance = Number(token?.dev_balance ?? token?.creator_balance ?? 0);
      const totalSupply = Number(token?.total_supply ?? token?.supply ?? 0);
      if (devWallet && totalSupply > 0) {
        await recordDevSnapshot({ mint: token.mint, devWallet, devBalance, totalSupply });
      }
    } catch (e) {
      log("intel_sample_err", `${token?.mint?.slice(0,8)}: ${e.message || e}`);
    }

    // ─── Holder Analysis (ABC) ─────────────────────────────────────
    // Check for real-time dump detection, underwater holders, and rug patterns
    // if feature flags are enabled.
    try {
      const hcfg = config.holderAnalysis || {};
      // Live ABC data is fetched here (Helius holders/sells + free price history)
      // through a throttled, cohort-gated, TTL-cached enricher. The enricher
      // returns empty arrays when the feature is off / the mint is out of the
      // beta cohort, so this stays cheap for the vast majority of positions.
      // Pre-supplied fields on the token (e.g. from tests) take precedence.
      const enriched = await enrichHolderData({
        mint: token.mint,
        currentPrice,
        featureFlags: hcfg,
      });
      const topHolders = token?.topHolders || token?.top_holders || enriched.topHolders;
      const recentSells = token?.recentSells || token?.recent_sells || enriched.recentSells;
      const holderTxHistory = token?.holderTransactions || token?.holder_transactions || enriched.holderTransactions;
      const priceHistory = token?.priceHistory || token?.price_history || enriched.priceHistory;

      const holderSignal = await checkHolderExitSignals({
        position: tracked,
        mint: token.mint,
        currentPrice,
        topHolders,
        recentSells,
        holderTransactions: holderTxHistory,
        priceHistory,
        featureFlags: hcfg,
      });

      if (holderSignal && holderSignal.risk_level === "CRITICAL") {
        const topSig = holderSignal.signals?.[0];
        const reasonDetail = topSig?.reason || topSig?.details?.top_dumper || "large dump";
        exits.push({
          mint: token.mint,
          symbol: token.symbol,
          reason: `holder_analysis: ${topSig?.tool || "critical"} — ${reasonDetail} (${holderSignal.confidence}% confidence)`,
          pnl_pct: currentPnlPct,
          is_loss: currentPnlPct < 0,
          wallet_address: token.wallet_address || null,
          position_key: token.position_key || token.mint,
          cast_net_group_id: tracked.cast_net_group_id || null,
          strategy_used: tracked.strategy_used || null,
          chain: token.chain || tracked.chain || "sol",
        });
        log(
          "holder_exit",
          `🚨 CRITICAL holder risk on ${token.symbol}: ${reasonDetail} — EXITING`
        );
        if (telegramEnabled()) {
          sendHTML(
            `🚨 <b>HOLDER ALERT</b> — ${htmlEscape(token.symbol || "")}\n<code>${htmlEscape(topSig?.tool || "Risk")}</code>\n${htmlEscape(reasonDetail)}`
          ).catch(() => {});
        }
        continue;
      } else if (holderSignal && holderSignal.risk_level === "HIGH" && holderSignal.confidence >= 80) {
        // HIGH risk with strong confidence — also exit but log for review
        const topSig = holderSignal.signals?.[0];
        const reasonDetail = topSig?.reason || "high dump risk";
        exits.push({
          mint: token.mint,
          symbol: token.symbol,
          reason: `holder_analysis_high: ${topSig?.tool || "high risk"} (${holderSignal.confidence}%)`,
          pnl_pct: currentPnlPct,
          is_loss: currentPnlPct < 0,
          wallet_address: token.wallet_address || null,
          position_key: token.position_key || token.mint,
          cast_net_group_id: tracked.cast_net_group_id || null,
          strategy_used: tracked.strategy_used || null,
          chain: token.chain || tracked.chain || "sol",
        });
        log(
          "holder_exit",
          `⚠️ HIGH holder risk on ${token.symbol}: ${reasonDetail} — EXITING`
        );
        if (telegramEnabled()) {
          sendHTML(
            `⚠️ <b>HOLDER RISK</b> — ${htmlEscape(token.symbol || "")}\n${htmlEscape(topSig?.tool || "Risk detected")}`
          ).catch(() => {});
        }
        continue;
      } else if (holderSignal && holderSignal.risk_level === "MEDIUM" && holderSignal.signals.length >= 2) {
        // MEDIUM risk only if multiple signals agree
        log(
          "holder_watch",
          `👁️ MEDIUM holder risk on ${token.symbol}: ${holderSignal.signals.map(s => s.tool).join(" + ")}`
        );
      }
    } catch (e) {
      recordError("holder_analysis_error");
      log("holder_exit_error", `${token?.mint?.slice(0, 8)}: ${e.message || e}`);
    }

    // Slow-rug force exit
    const slowRug = evaluateSlowRug(token.mint);
    if (slowRug.triggered && slowRug.severity === "high") {
      exits.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: `slow_rug_force_exit: ${slowRug.pattern}`,
        pnl_pct: currentPnlPct,
        is_loss: currentPnlPct < 0,
        wallet_address: token.wallet_address || null,
        position_key: token.position_key || token.mint,
        cast_net_group_id: tracked.cast_net_group_id || null,
        strategy_used: tracked.strategy_used || null,
        chain: token.chain || tracked.chain || "sol",
      });
      continue;
    }

    // Dev wallet sell — high or critical severity = exit
    const devAct = evaluateDevActivity(token.mint);
    if (devAct.severity === "critical" || devAct.severity === "high") {
      exits.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: `dev_sell: ${devAct.alert}`,
        pnl_pct: currentPnlPct,
        is_loss: currentPnlPct < 0,
        wallet_address: token.wallet_address || null,
        position_key: token.position_key || token.mint,
        cast_net_group_id: tracked.cast_net_group_id || null,
        strategy_used: tracked.strategy_used || null,
        chain: token.chain || tracked.chain || "sol",
      });
      continue;
    }

    // Volume divergence — high severity → exit. Watch → log only.
    const volDiv = evaluateVolumeDivergence(token.mint);
    if (volDiv.detected && volDiv.severity === "high") {
      exits.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: `volume_divergence: ${volDiv.pattern}`,
        pnl_pct: currentPnlPct,
        is_loss: currentPnlPct < 0,
        wallet_address: token.wallet_address || null,
        position_key: token.position_key || token.mint,
        cast_net_group_id: tracked.cast_net_group_id || null,
        strategy_used: tracked.strategy_used || null,
        chain: token.chain || tracked.chain || "sol",
      });
      continue;
    } else if (volDiv.detected && volDiv.severity === "watch") {
      log("intel_watch", `${token.symbol}: volume divergence — ${volDiv.recommendation}`);
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
        cast_net_group_id: tracked.cast_net_group_id || null,
        strategy_used: tracked.strategy_used || null,
        chain: token.chain || tracked.chain || "sol",
      });
      continue;
    }

    // ─── Pro Orchestrator SELL / CUTLOSS Gate ──────────────────
    if (isProModeActive()) {
      const currentConviction = getCoinConviction(token.mint, token);
      const crossBatchVel = getCrossBatchVelocity();

      const entryNarrative = tracked.signal_snapshot?.conviction?.narrative ?? null;
      let posNarrativeVelocityScore = 0;
      if (entryNarrative && crossBatchVel?.active?.length) {
        const found = crossBatchVel.active.find(a => a.narrative === entryNarrative);
        if (found) posNarrativeVelocityScore = found.cross_batch_score ?? 0;
      }
      const narrativeVelForPro = {
        velocity_score: posNarrativeVelocityScore,
        trendingNarratives: crossBatchVel?.sustained ?? [],
      };

      // Pro Sell — multi-signal exit evaluation
      const proSell = proSellDecision({
        position: {
          conviction_entry: tracked.signal_snapshot?.conviction?.conviction_score ?? 0,
          narrative_entry: entryNarrative,
          narrative_entry_velocity: 0,
          pnl_pct: currentPnlPct,
          peak_pnl_pct: tracked.peak_pnl_pct ?? 0,
        },
        conviction: currentConviction,
        marketCondition: condition,
        narrativeVelocity: narrativeVelForPro,
        regimeHistory: null,
      });

      if (proSell.action === "SELL") {
        exits.push({
          mint: token.mint,
          symbol: token.symbol,
          reason: `pro_sell: ${proSell.reasons.join("; ")}`,
          pnl_pct: currentPnlPct,
          is_loss: currentPnlPct < 0,
          wallet_address: token.wallet_address ?? null,
          position_key: token.position_key ?? token.mint,
          chain: token.chain || tracked.chain || "sol",
        });
        log("pro_orchestrator",
          `SELL ${token.symbol}: ${proSell.exitSignals} signals, urgency=${proSell.urgency} — ${proSell.reasons.join("; ")}`
        );
        continue;
      }

      // Pro Cutloss — regime-adaptive stop check
      const proCut = proCutlossDecision({
        pnlPct: currentPnlPct,
        holdMinutes: ageMinutes,
        marketCondition: condition,
        conviction: currentConviction,
        entryConviction: tracked.signal_snapshot?.conviction?.conviction_score ?? 0,
      });

      if (proCut.action === "CUTLOSS") {
        exits.push({
          mint: token.mint,
          symbol: token.symbol,
          reason: `pro_cutloss: ${proCut.reason}`,
          pnl_pct: currentPnlPct,
          is_loss: true,
          wallet_address: token.wallet_address ?? null,
          position_key: token.position_key ?? token.mint,
          chain: token.chain || tracked.chain || "sol",
        });
        log("pro_orchestrator",
          `CUTLOSS ${token.symbol}: ${proCut.type} — ${proCut.reason}`
        );
        continue;
      }
    }

    // C1: skip all PnL-based gates when PnL is unknown — passing phantom 0 lets
    // positions rug silently because hardStopLoss/trailingStop never see a loss.
    const exitPolicy = pnlKnown
      ? evaluateExitPolicy({ pnlPct: currentPnlPct, peakPnlPct: tracked.peak_pnl_pct || 0, policy: riskPolicy })
      : { hardCutLoss: false, hardStopLoss: false, takeProfit: false, trailingStop: false, profitSweepEligible: false };

    if (exitPolicy.hardCutLoss) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.hardCutLossReason, pnl_pct: currentPnlPct, is_loss: true, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint, chain: token.chain || tracked.chain || "sol" });
      continue;
    }
    if (exitPolicy.hardStopLoss) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.hardStopLossReason, pnl_pct: currentPnlPct, is_loss: true, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint, chain: token.chain || tracked.chain || "sol" });
      continue;
    }
    // Immediate take-profit override (hybrid mode): policy takeProfitPct triggers any time
    if (exitPolicy.takeProfit) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.takeProfitReason, pnl_pct: currentPnlPct, is_loss: false, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint, chain: token.chain || tracked.chain || "sol" });
      continue;
    }

    // Partial TP: sell a fraction once when PnL crosses threshold, keep the rest running.
    const partial = pnlKnown
      ? checkPartialTP(currentPnlPct, tracked.partial_tp_done === true)
      : { trigger: false };
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
        (slippage) => sellByChain({
          token_in: token.mint, token_out: "SOL",
          amount: sellAmount, slippage,
          chain: token.chain || "sol",
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
      if (partialRes.success || partialRes.dry_run || partialRes.indeterminate) {
        await markPartialTPLanded(posKey);
        // H3: await durability + set in-memory flag so the same cycle does not
        // re-trigger. Without await, a restart between the two guards leaves
        // partial_tp_done unset on disk while isPartialTPLanded sees a stale file.
        await markPartialTPDone(token.position_key || token.mint, token.wallet_address || null);
        tracked.partial_tp_done = true;
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

    const roiCheck = pnlKnown ? checkROI(ageMinutes, currentPnlPct, condition) : { exit: false };
    if (roiCheck.exit) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: roiCheck.reason, pnl_pct: currentPnlPct, is_loss: currentPnlPct < 0, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint, chain: token.chain || tracked.chain || "sol" });
      continue;
    }

    // Chart-based exit: SuperTrend trend flip on in-profit positions.
    // Gated behind config.indicators.enabled AND config.indicators.exitOnTrendBreak
    // (defaults to false — opt-in to avoid API cost on every held position).
    // Only fires when position is in profit (currentPnlPct >= trailingTrigger)
    // to protect gains on trend reversal rather than accelerating losses.
    if (
      pnlKnown &&
      config.indicators?.enabled &&
      config.indicators?.exitOnTrendBreak &&
      currentPnlPct >= (riskPolicy.exit?.trailingTriggerPct ?? 8)
    ) {
      try {
        const klineResolution = config.indicators.intervals?.[0] === "5_MINUTE" ? "5m" : "1m";
        const klineLimit = config.indicators.candles || 100;
        const klineData = await getTokenKlines({
          mint: token.mint,
          resolution: klineResolution,
          limit: klineLimit,
          chain: token.chain || tracked.chain || "sol",
        });
        if (klineData?.candles?.length >= 30) {
          const momentum = analyzeMomentum(klineData.candles);
          if (momentum.valid) {
            const trendExit = checkTrendBreakExit(momentum.currentPrice, momentum.supertrend, {
              macd: momentum.macd,
              supportResistance: momentum.supportResistance,
            });
            if (trendExit.shouldExit) {
              exits.push({
                mint: token.mint,
                symbol: token.symbol,
                reason: `Trend break: ${trendExit.reason}`,
                pnl_pct: currentPnlPct,
                is_loss: currentPnlPct < 0,
                wallet_address: token.wallet_address || null,
                position_key: token.position_key || token.mint,
                chain: token.chain || tracked.chain || "sol",
              });
              continue;
            }
          }
        }
      } catch (_) { /* chart fetch failure must never block other exits */ }
    }

    if (exitPolicy.trailingStop) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: exitPolicy.trailingStopReason, pnl_pct: currentPnlPct, is_loss: false, wallet_address: token.wallet_address || null, position_key: token.position_key || token.mint, chain: token.chain || tracked.chain || "sol" });
    }
  }

  // G2/G3: annotate every exit with the cast-net group id, strategy, and chain
  // from the tracked position. Done in one pass post-loop so we don't have to
  // plumb these fields through all exits.push() sites above (most already set
  // chain directly, but this acts as a safety-net for any missed or future paths).
  for (const exit of exits) {
    if (exit.cast_net_group_id != null && exit.strategy_used != null && exit.chain != null) continue;
    const t = getTrackedPosition(exit.position_key || exit.mint, exit.wallet_address || null);
    if (t) {
      if (exit.cast_net_group_id == null) exit.cast_net_group_id = t.cast_net_group_id || null;
      if (exit.strategy_used == null) exit.strategy_used = t.strategy_used || null;
      if (exit.chain == null) exit.chain = t.chain || "sol";
    }
    if (exit.chain == null) exit.chain = "sol";
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
        chain: tracked.chain || "sol",
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
        (slippage) => sellByChain({
          token_in: "SOL",
          token_out: buy.mint,
          amount: buy.amount_sol,
          slippage,
          chain: buy.chain || "sol",
          wallet: buy.wallet_address ? getWalletByAddress(buy.wallet_address)?.keypair || null : null,
        })
      );

      if (res?.success || res?.dry_run) {
        // Update staged entry tracking
        const updated = advanceStagedEntry(buy.staged, buy.currentPrice);
        buy.tracked.signal_snapshot.staged_entry = updated;

        // Accumulate this stage's entry fees into entry_fee_breakdown so
        // calcTruePnl sees total fees, not just stage-1 fees.
        const stageFees = computeTradeFeeBreakdown({
          amountSol: buy.amount_sol,
          dexId: buy.tracked.signal_snapshot?.entry_dex || "unknown",
          isEntry: true,
          expectedPrice: buy.currentPrice || 0,
          actualPrice: buy.currentPrice || 0,
          liquidity: buy.tracked.signal_snapshot?.liquidity || 0,
          volume: 0,
        });
        const existingFees = buy.tracked.signal_snapshot?.entry_fee_breakdown;
        if (existingFees && stageFees) {
          existingFees.total_fee_sol  = (existingFees.total_fee_sol  || 0) + (stageFees.total_fee_sol  || 0);
          existingFees.dex_fee_sol    = (existingFees.dex_fee_sol    || 0) + (stageFees.dex_fee_sol    || 0);
          existingFees.platform_fee_sol = (existingFees.platform_fee_sol || 0) + (stageFees.platform_fee_sol || 0);
        }

        // Update position: add SOL amount, recompute avg entry value
        const oldAmount = buy.tracked.amount_sol || 0;
        const oldValue = buy.tracked.initial_value_usd || 0;
        const newAmount = oldAmount + buy.amount_sol;
        const newValue = oldValue + (buy.amount_sol * solPrice);
        buy.tracked.amount_sol = newAmount;
        buy.tracked.initial_value_usd = newValue;

        // Persist updated position — preserve strategy/cast-net fields so exit policy,
        // strategy-outcome learning, and cast-net coordination keep working.
        await trackPosition({
          position: buy.mint,
          pool: buy.tracked.pool || "jupiter",
          pool_name: buy.symbol,
          amount_sol: newAmount,
          initial_value_usd: newValue,
          signal_snapshot: buy.tracked.signal_snapshot,
          wallet_address: buy.wallet_address,
          chain: buy.chain || buy.tracked?.chain || "sol",
          strategy_used:     buy.tracked.strategy_used || null,
          cast_net_group_id: buy.tracked.cast_net_group_id || null,
          cast_net_slot:     buy.tracked.cast_net_slot ?? null,
          paper_trade: process.env.DRY_RUN === 'true' || process.env.PAPER_TRADING === 'true',
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

  // GUARD: checkAllGates runs BEFORE the main try/finally below. If it throws,
  // the finally never runs and _managementBusy stays true forever — the cron
  // cycle wedges permanently until process restart. Reset on throw here.
  let gate;
  try {
    gate = await checkAllGates("management");
  } catch (e) {
    _managementBusy = false;
    log("cron_error", `management gate check failed: ${e.message}`);
    recordError("management_cycle");
    return null;
  }
  if (gate.blocked) {
    _managementBusy = false;
    agentBus.emit("management:gate_blocked", { reason: gate.reason, timestamp: Date.now() });
    return gate.reason;
  }

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

    // Publish balance gauges for sidecar processes (dashboard /api/status):
    // state.json never carries balance_sol/sol_price, so without these the
    // web monitor renders zeros even while the bot trades.
    setGauge("balance_sol", balance.sol || 0);
    if (Number(balance.sol_price) > 0) setGauge("sol_price_usd", Number(balance.sol_price));

    await syncOpenPositions(tokens.map(t => t.position_key || t.mint));

    // Save live wallet topology state for dashboard monitoring (deduped helper)
    await flushWalletTopology().catch(e => log("wallet_topology", e.message));

    if (tokens.length === 0) {
      mgmtReport = "No open token positions.";
      return mgmtReport;
    }

    // ─── Step 1: Staged entries (DCA buys) ───────
    // Check BEFORE exits — don't exit a position that's about to get a staged buy
    const stagedBuys = await checkStagedEntries(tokens, balance);

    // ─── Step 2: Deterministic exits ─────────────
    const deterministicExits = await checkDeterministicExits(tokens, { solPriceUsd: balance.sol_price || 0 });

    // G2: cast-net staggered exit ordering. If multiple positions from the
    // same cast-net group hit exit simultaneously, dumping them in the same
    // block is the same fingerprint that the multi-wallet entry was meant
    // to avoid. We interleave group members with non-group exits (so we
    // don't pause if there's other work to do) and inject jittered delays
    // between consecutive same-group exits below.
    deterministicExits.sort((a, b) => {
      // Non-cast-net exits first (they have no anti-detection cost).
      const aGroup = a.cast_net_group_id || "";
      const bGroup = b.cast_net_group_id || "";
      if (!aGroup && bGroup) return -1;
      if (aGroup && !bGroup) return 1;
      // Within cast-net groups: randomize order so the slot index doesn't
      // leak the original entry timing.
      if (aGroup === bGroup) return Math.random() - 0.5;
      return aGroup.localeCompare(bGroup);
    });
    let _lastCastNetGroupExitTs = 0;
    let _lastCastNetGroupId = null;

    for (const exit of deterministicExits) {
      try {
      // G2: stagger consecutive cast-net group exits (30s-5min jitter).
      // Only delay when the previous exit was from the SAME group — we
      // don't want to slow down unrelated exits.
      if (exit.cast_net_group_id && exit.cast_net_group_id === _lastCastNetGroupId) {
        const minMs = 30_000;
        const maxMs = 300_000;
        const delayMs = Math.floor(minMs + Math.random() * (maxMs - minMs));
        const elapsedSinceLast = Date.now() - _lastCastNetGroupExitTs;
        const sleepMs = Math.max(0, delayMs - elapsedSinceLast);
        if (sleepMs > 0) {
          log("cast_net", `🎣 stagger ${Math.round(sleepMs/1000)}s before next exit in group ${exit.cast_net_group_id.slice(-6)}`);
          await new Promise((r) => setTimeout(r, sleepMs));
        }
      }
      log("strategy", `EXIT: ${exit.symbol} — ${exit.reason}`);
      const tokenData = tokens.find(t => (t.position_key || t.mint) === (exit.position_key || exit.mint));

      // ── Exit Timing Plan ────────────────────────────────────────────
      // Consult the exit-timing optimizer before executing. For profit-taking
      // exits: may delay briefly if price is actively dumping (better fill).
      // For all exits: sets minimum slippage so urgent exits don't waste the
      // first attempt at 1% when 5%+ is needed.
      const _exitPlan = planExit({
        mint: exit.mint,
        exitReason: exit.reason,
        positionValueUsd: Number(tokenData?.usd || 0),
        liquidityUsd: Number(tokenData?.liquidity_usd ?? tokenData?.liquidity ?? 0),
        price1mPct: Number(tokenData?.price_change_1m ?? 0),
        lastCandleGreen: tokenData?.last_candle_green ?? null,
      });
      if (_exitPlan.reasons.length > 0) {
        log("exit_timing", `${exit.symbol}: ${_exitPlan.reasons.join("; ")}`);
      }
      if (_exitPlan.delayBeforeFirstMs > 0) {
        await new Promise((r) => setTimeout(r, _exitPlan.delayBeforeFirstMs));
      }
      const _minSlippage = _exitPlan.slippagePct / 100;
      const _balance = tokenData?.balance;

      // ── Split vs Single Exit ─────────────────────────────────────────
      // When planExit says split (position > 5% of liquidity), sell in
      // splitCount equal chunks with splitDelayMs jitter between them.
      // We stop on the first fully-stuck chunk — no point selling air.
      const exitStartAt = Date.now();
      let res, exitAttempt, exitStuck;
      if (_exitPlan.split && _exitPlan.splitCount > 1 && Number(_balance) > 0) {
        const chunkAmt = _balance / _exitPlan.splitCount;
        let _lastRes = null, _lastAttempt = 1, _allFailed = true;
        // Accumulate proceeds across all chunks so PnL isn't understated from only the last chunk.
        let _proceedsRaw = 0;
        for (let _c = 0; _c < _exitPlan.splitCount; _c++) {
          if (_c > 0) {
            const jitter = Math.floor(Math.random() * (_exitPlan.splitDelayMs * 0.5));
            await new Promise((r) => setTimeout(r, _exitPlan.splitDelayMs + jitter));
          }
          const { result: cR, attempt: cA, stuck: cS } = await withProgressiveSlippage(
            (slippage) => sellByChain({
              token_in: exit.mint, token_out: "SOL",
              amount: chunkAmt,
              slippage: Math.max(slippage, _minSlippage),
              chain: exit.chain || "sol",
              wallet: exit.wallet_address ? getWalletByAddress(exit.wallet_address)?.keypair || null : null,
            })
          );
          if ((cR?.success || cR?.dry_run) && cR?.amount_out != null) _proceedsRaw += Number(cR.amount_out);
          _lastRes = cR; _lastAttempt = cA;
          log("exit_timing", `${exit.symbol} split ${_c + 1}/${_exitPlan.splitCount}: ${cR?.success || cR?.dry_run ? "OK" : "FAIL"}`);
          if (!cS) _allFailed = false;
          if (cS) break; // pool depth gone — abort remaining chunks
        }
        // Merge aggregated proceeds into the final result object for PnL calculation
        res = { ..._lastRes, amount_out: _proceedsRaw || _lastRes?.amount_out || null };
        exitAttempt = _lastAttempt; exitStuck = _allFailed;
      } else {
        const _r = await withProgressiveSlippage(
          (slippage) => sellByChain({
            token_in: exit.mint, token_out: "SOL",
            amount: _balance,
            slippage: Math.max(slippage, _minSlippage),
            chain: exit.chain || "sol",
            wallet: exit.wallet_address ? getWalletByAddress(exit.wallet_address)?.keypair || null : null,
          })
        );
        res = _r.result; exitAttempt = _r.attempt; exitStuck = _r.stuck;
      }

      recordSwapOutcome({ success: !!(res.success || res.dry_run) });
      await recordExecutionQuality({
        walletAddress: exit.wallet_address || null,
        provider: res?.execution_provider || "auto",
        mode: "sell",
        split: _exitPlan.split,
        split_count: _exitPlan.split ? _exitPlan.splitCount : 1,
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
      if (res.success || res.dry_run || res.indeterminate) {
        // Await close-flush: a crash before this lands on disk means the next
        // management cycle would re-attempt the exit on a position already
        // sold, hitting Jupiter with zero balance. Cheap insurance.
        const reason = res.indeterminate ? `${exit.reason} (INDETERMINATE_SWAP)` : exit.reason;
        await recordClose(exit.position_key || exit.mint, reason, exit.wallet_address || null);
        _rugMonitor?.detachPosition(exit.position_key || exit.mint);
        await clearPartialTPGuard(exit.position_key || exit.mint);
        recordRuggedNarrativesForExit({ reason, token: tokenData || {} });
        // G2: track for the next iteration's stagger check.
        // C1: propagate this position's PnL back to its cast-net group so
        // the gate's consecutive-loss check has fresh outcomes.
        if (exit.cast_net_group_id) {
          _lastCastNetGroupId = exit.cast_net_group_id;
          _lastCastNetGroupExitTs = Date.now();
          try {
            const { recordCastNetOutcome } = await import("./tools/cast-net-gate.js");
            await recordCastNetOutcome({
              groupId: exit.cast_net_group_id,
              pnlPct: exit.pnl_pct || 0,
            });
          } catch (e) {
            log("cast_net_err", `recordCastNetOutcome ${exit.cast_net_group_id}: ${e.message || e}`);
          }
        }
        const tradePnl = exit.pnl_pct || 0;
        // recordTrade and handleDailyTradeGuardOutcome are called AFTER truePnl
        // is computed below so we use net-after-fee PnL for accurate win/loss labelling.
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
        // Use chain-native decimals: SOL = 9, EVM (ETH/BNB/Base) = 18.
        const _exitDecimals = (exit.chain && exit.chain !== "sol") ? 1e18 : 1e9;
        const exitSolReceived = res?.amount_out != null ? Number(res.amount_out) / _exitDecimals : null;
        const entrySolSpent = tracked?.amount_sol ?? null;
        const swapFeeSol = res?.tx_fee_lamports != null ? Number(res.tx_fee_lamports) / 1e9 : null;
        const realizedPnlPct = entrySolSpent > 0 && exitSolReceived != null
          ? ((exitSolReceived - entrySolSpent) / entrySolSpent) * 100
          : null;

        // ─── Fee Tracking: Exit + True PnL ──────────────
        const entryFees = tracked?.signal_snapshot?.entry_fee_breakdown;
        const exitSlippage = extractSlippageFromSwapResult(res, exitSolReceived || 0, { isExit: true });
        const exitFeeBreakdown = computeTradeFeeBreakdown({
          amountSol: exitSolReceived || 0,
          dexId: tracked?.signal_snapshot?.entry_dex || tokenData?.dex || "unknown",
          isEntry: false,
          expectedPrice: tokenData?.price || 0,
          actualPrice: tokenData?.price ? tokenData.price * (1 + exitSlippage.price_impact_pct / 100) : 0,
          liquidity: tokenData?.liquidity || 0,
          priorityFeeSol: (Number(res?.priority_fee_lamports || 0) / 1e9) || 0,
          jitoTipSol: (Number(res?.total_tip_lamports || res?.tip_lamports || 0) / 1e9) || 0,
          txFeeLamports: res?.tx_fee_lamports || null,
          entryFeeBreakdown: entryFees || null,
        });
        recordSimCall();

        // True PnL after ALL fees
        const truePnl = calcTruePnl({
          entrySol: entrySolSpent || 0,
          exitSol: exitSolReceived || 0,
          entryFeeBreakdown: entryFees,
          exitFeeBreakdown,
        });

        // Use net-after-fee PnL for win/loss label — more accurate than gross currentPnlPct
        const netIsLoss = truePnl.net_pnl_pct != null ? truePnl.net_pnl_pct < 0 : exit.is_loss;
        recordTrade(!netIsLoss);
        await handleDailyTradeGuardOutcome(!netIsLoss, {
          symbol: exit.symbol,
          mint: exit.mint,
          pnl_pct: truePnl.net_pnl_pct ?? tradePnl,
          exit_reason: exit.reason,
        });
        if (config.streakSizer?.enabled) recordStreakOutcome(!netIsLoss, config.streakSizer);

        recordTradeOutcome({
          mint: exit.mint,
          symbol: exit.symbol,
          entry_usd: tracked?.initial_value_usd,
          exit_usd: tokenData?.usd,
          pnl_pct: truePnl.net_pnl_pct || tradePnl,
          hold_minutes: holdMinutes,
          exit_reason: exit.reason,
          rug_detected: /rug/i.test(exit.reason),
          attribution,
          entry_sol: entrySolSpent,
          exit_sol: exitSolReceived,
          swap_fee_sol: swapFeeSol,
          actual_realized_pct: realizedPnlPct,
          fee_breakdown: {
            entry: entryFees || null,
            exit: exitFeeBreakdown,
            true_pnl: truePnl,
            slippage: exitSlippage,
          },
        });
        setImmediate(() => logTradeOutcome({
          symbol: exit.symbol,
          mint: exit.mint,
          pnl_pct: truePnl.net_pnl_pct || tradePnl,
          hold_minutes: holdMinutes,
          exit_reason: exit.reason,
          is_win: !netIsLoss,
        }).catch(() => {}));
        await recordTradeAttribution({
          mint: exit.mint,
          symbol: exit.symbol,
          pnl_pct: tradePnl,
          hold_minutes: holdMinutes,
          exit_reason: exit.reason,
          ...attribution,
        });
        recordTradeConvictionOutcome({
          mint:         exit.mint,
          symbol:       exit.symbol,
          name:         tokenData?.name || exit.name || null,
          pnl_pct:      tradePnl,
          hold_minutes: holdMinutes,
          exit_reason:  exit.reason,
          token:        tokenData || {},          // profil lengkap untuk profit fingerprint
          strategy:     tokenData?.strategy_id || null,
        });
        // Per-skill P&L attribution (Phase 2/3): credit/blame the strategy-skills
        // that actionably voted for this entry. No-op when the book wasn't active
        // (empty votes). Feeds the codifier loop + book rebalancing.
        const skillVotes = tracked?.signal_snapshot?.portfolio_skill_votes;
        if (Array.isArray(skillVotes) && skillVotes.length > 0) {
          await recordSkillAttribution({ skillIds: skillVotes, pnlPct: tradePnl, mint: exit.mint, symbol: exit.symbol });
        }
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

        // ── Super Brain: episodic memory + prompt evolution ─────────────
        // Record trade outcome for pattern retrieval and learned rules.
        // Fire-and-forget — never block the exit loop.
        setImmediate(async () => {
          const tokenCtx = { ...tokenData, rug_score: exit.rug_score ?? tokenData?.rug_score };
          if (config.episodicMemory?.enabled) {
            await recordEpisode({
              mint: exit.mint, symbol: exit.symbol, token: tokenCtx,
              pnl_pct: tradePnl, hold_minutes: holdMinutes,
              exit_reason: exit.reason, is_rug: /rug/i.test(exit.reason || ""),
            }).catch(() => {});
          }
          if (config.promptEvolution?.enabled) {
            attributeOutcome({
              token: tokenCtx, pnl_pct: tradePnl,
              exit_reason: exit.reason, is_rug: /rug/i.test(exit.reason || ""),
              verdict: tracked?.signal_snapshot?.workflow?.verdict || null,
            });
          }
        });

        // ── Strategy performance feedback loop ──────────────────────────
        // Feed strategy outcome back to learning-agent so it can track
        // per-strategy win/loss and surface degrading presets.
        if (exit.strategy_used) {
          agentBus.emit("management:strategy_outcome", {
            strategy_id:  exit.strategy_used,
            mint:         exit.mint,
            symbol:       exit.symbol,
            pnl_pct:      tradePnl,
            exit_reason:  exit.reason,
            hold_minutes: holdMinutes,
            is_rug:       /rug/i.test(exit.reason || ""),
            is_win:       tradePnl > 0,
            market_condition: tokenData?.market_condition || getMarketIntelligence().condition,
          });
        }

        // Emit to learning-agent so hunt-source attribution, rug name-pattern learning,
        // and per-source win/loss stats are updated on deterministic exits (not just
        // LLM-tool-driven sells, which previously were the only emit site).
        agentBus.emit("management:llm_exit_executed", {
          mint:          exit.mint,
          reason:        exit.reason,
          walletAddress: exit.wallet_address || null,
          pnl_pct:       tradePnl,
          is_win:        tradePnl > 0,
          rug_detected:  /rug/i.test(exit.reason || ""),
          timestamp:     Date.now(),
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
          if (vaultCheck.due || vaultCheck.first_vault) {
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
      } catch (perExitErr) {
        // Per-exit safety: a bookkeeping failure on one exit must not abort
        // the whole batch. The on-chain swap may have already succeeded, so
        // the next cycle's exit attempt on the same mint would hit a
        // zero-balance position and fail. Log loudly and move on.
        log("management_error",
          `Exit bookkeeping failed for ${exit.symbol || exit.mint?.slice(0, 8)}: ${perExitErr.message}`,
        );
        recordError("exit_per_iter");
        if (telegramEnabled()) {
          sendHTML(
            `⚠️ <b>Exit bookkeeping error</b> · ${htmlEscape(exit.symbol || "?")}\n` +
            `<code>${htmlEscape(perExitErr.message)}</code>\n` +
            fmt.it("On-chain may have succeeded — check state."),
          ).catch(() => {});
        }
      }
    }

    // ─── Step 2: LLM Management (via Agent Bus → General Agent) ──
    const remainingBalance = await getPortfolioSnapshot();
    const remainingTokens = (remainingBalance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    // Per-position LLM gate: only include positions whose matched strategy uses LLM
    // AND are not in a managed window (age <5min or active partial-TP).
    // This is a HARD guard — managed positions are simply not shown to the LLM,
    // so it cannot exit them regardless of what it decides.
    const llmReviewTokens = remainingTokens.filter(t => {
      const stratId = t.signal_snapshot?.strategy_used || t.strategy_used || null;
      const usesLlm = getStrategy(stratId)?.use_llm !== false;
      const ageMinutes = Number(t.age_minutes || 0);
      const isManaged = ageMinutes < 5 || !!t.partial_tp_active;
      return usesLlm && !isManaged;
    });
    const _allActiveUseLlm = getActiveStrategyIds().every(id => getStrategy(id)?.use_llm !== false);
    if (llmReviewTokens.length > 0 && isLLMReviewEnabled()) {
      let planSummary;
      try {
        planSummary = getPlanSummary();
      } catch (e) {
        log("plan", `WARN: getPlanSummary failed: ${e.message}`);
        planSummary = null;
      }
      const marketIntel = getMarketIntelligence();
      // managedMints is informational only — hard guard is the llmReviewTokens filter above
      const managedMints = remainingTokens
        .filter(t => Number(t.age_minutes || 0) < 5 || t.partial_tp_active)
        .map(t => t.mint)
        .filter(Boolean);

      // Emit to bus — General Agent picks up and runs LLM
      agentBus.emit("management:llm_review_started", {
        tokenCount: remainingTokens.length,
        symbols: remainingTokens.map(t => t.symbol),
        timestamp: Date.now(),
      });

      // MGMT-6: inner timeout around the LLM call so a stuck stream
      // doesn't sit on the whole management cycle. Falls through to the
      // outer try/catch as a normal exception.
      const LLM_TIMEOUT_MS = Number(config.llm?.managementTimeoutMs) || 90_000;
      const MAX_LLM_TOKENS = 2048;
      const { content } = await withTimeout(agentLoop(`
MANAGEMENT CYCLE — LLM Portfolio Review
Market: ${marketIntel.condition} — ${marketIntel.description || ""}
${planSummary ? `Plan: Day ${planSummary.day}/${planSummary.days_total} | P&L: ${planSummary.today_pnl_pct}% | Target: +${planSummary.daily_target_pct}%${planSummary.profit_mode ? " | PROFIT MODE" : ""}` : ""}

POSITIONS HELD (LLM-managed, eligible for review):
${JSON.stringify(llmReviewTokens.map(t => ({
  symbol: t.symbol,
  mint: t.mint?.slice(0, 8),
  usd_value: t.usd?.toFixed(2),
  pnl_pct: t.pnl_pct?.toFixed(1),
  age_min: t.age_minutes?.toFixed(0),
  conviction: t.conviction?.conviction_score,
  narrative: t.narrative_tags?.[0],
  market_entry: t.market_condition,
})))}
${managedMints.length > 0 ? `\nNOTE: ${managedMints.length} position(s) excluded from review (too young or active partial-TP).` : ""}

TUGAS:
1. Review setiap posisi — qualitative risk: narrative shifts, conviction decay, market deterioration
2. EXIT jika: naratif mati, conviction turun >20 poin, atau market jadi DEAD
3. HOLD jika: posisi sehat, naratif masih kuat, conviction building
4. BOLEH ENTRY BARU jika: ada peluang jelas dari screening, market kondusif (NORMAL/HOT)
5. Jangan override SL/TP — itu ditangani otomatis oleh sistem
6. Fokus: protect capital, cut losers early, let winners run
      `, config.llm.managerMaxSteps, [], "MANAGER", config.llm.managementModel, MAX_LLM_TOKENS, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result }) => {
          await liveMessage?.toolFinish(name, result, !result?.error);
          if (name === "swap_token") {
            recordSwapOutcome({ success: !!(result?.success || result?.dry_run) });
            const isBuy = (result.token_in || result.would_swap?.token_in) === "SOL";
            // BUY events are emitted by trackPosition (single source of truth
            // for all entry paths) — emitting here too double-counted LLM buys.
            if (!isBuy) {
              agentBus.emit("management:llm_sell", {
                token: result.token_out || result.would_swap?.token_out,
                symbol: result.symbol,
                amount: result.amount,
                dry_run: result.dry_run,
                success: !!(result?.success || result?.dry_run),
                timestamp: Date.now(),
                _hunt_source: "management-llm",
                _social_source: null,
              });
            }
          }
          if (name === "swap_token" && (result.success || result.dry_run)) {
            const tokenOut = result.token_out || result.would_swap?.token_out;
            const tokenIn = result.token_in || result.would_swap?.token_in;
            const walletAddress = result.wallet_address || result.would_swap?.wallet_address || null;
            // Check if this is a SELL (token_out is SOL/wSOL)
            if (tokenOut === "SOL" || tokenOut === "So11111111111111111111111111111111111111112") {
              const llmPosKey = walletAddress ? `${tokenIn}::${walletAddress}` : tokenIn;

              // ── Compute real PnL for win/loss telemetry ──────────────
              // Previously this branch hardcoded recordTrade(true) which
              // counted every LLM-driven exit as a win, even -50% dumps.
              // Now we derive win/loss from the actual swap output vs the
              // tracked entry value. If we can't derive (missing tracked
              // position, missing sol price, dry-run), skip the win/loss
              // accounting entirely instead of guessing.
              const trackedPos = getTrackedPosition(tokenIn, walletAddress);
              const solPriceUsd = Number(remainingBalance?.sol_price) || 0;
              // result.amount_out is the raw output (lamports for SOL → / 1e9).
              // Demo returns it raw too (JUP-DRY-1), so the simulated exit PnL is
              // accurate — the bot LEARNS from paper trades as well as live. We
              // only require valid entry/exit USD; mode no longer gates learning.
              // T3-13: amount_out is in lamports (SOL = 9 decimals). Safe here
              // because this branch is inside tokenOut === "SOL" check above.
              const exitSolAmount = Number(result.amount_out || 0) / 1e9;
              const exitUsd = exitSolAmount * solPriceUsd;
              const entryUsd = Number(trackedPos?.initial_value_usd) || 0;
              const canComputePnl = entryUsd > 0 && exitUsd > 0;
              const pnlPct = canComputePnl ? ((exitUsd - entryUsd) / entryUsd) * 100 : null;
              const isWin = pnlPct != null ? pnlPct > 0 : null;

              await recordClose(tokenIn, "LLM Manager Decision", walletAddress);
              _rugMonitor?.detachPosition(llmPosKey);
              await clearPartialTPGuard(llmPosKey);
              recordRuggedNarrativesForExit({ reason: "LLM Manager Decision", token: {} });

              if (isWin != null) {
                recordTrade(isWin);
                await handleDailyTradeGuardOutcome(isWin, {
                  mint: tokenIn,
                  symbol: tokenIn?.slice(0, 8),
                  pnl_pct: pnlPct,
                  exit_reason: "LLM Manager Decision",
                });
                if (config.streakSizer?.enabled) recordStreakOutcome(isWin, config.streakSizer);
              } else {
                log("management_warn",
                  `LLM exit ${tokenIn?.slice(0, 8)}: PnL unavailable (entry=$${entryUsd.toFixed(2)}, exit=$${exitUsd.toFixed(2)}) — missing entry/exit value, skipping win/loss telemetry`,
                );
              }

              agentBus.emit("management:llm_exit_executed", {
                mint: tokenIn,
                reason: "LLM Manager Decision",
                walletAddress,
                pnl_pct: pnlPct,
                is_win: isWin,
                timestamp: Date.now(),
              });
            }
            // Check if this is a BUY (token_in is SOL/wSOL)
            if (tokenIn === "SOL" || tokenIn === "So11111111111111111111111111111111111111112") {
              // T1-1: management-LLM entries were emitted but never trackPosition'd,
              // so SL/TP/trailing/rug-exit never applied to these positions.
              // Track now using the same data available in this closure.
              const mgmtSolPrice = Number(remainingBalance?.sol_price) || 0;
              // C2: best-effort price fetch so checkPriceDrop can protect this position.
              let mgmtEntryPrice = 0;
              try {
                const tInfo = await getTokenInfo({ query: tokenOut });
                mgmtEntryPrice = Number(tInfo?.results?.[0]?.price || 0);
              } catch { /* non-critical */ }
              await trackPosition({
                position: tokenOut,
                pool: "management-llm",
                pool_name: result.symbol || tokenOut?.slice(0, 8),
                amount_sol: result.amount,
                initial_value_usd: (result.amount || 0) * mgmtSolPrice,
                wallet_address: walletAddress,
                signal_snapshot: {
                  mint: tokenOut,
                  symbol: result.symbol,
                  entry_price: mgmtEntryPrice,
                  entry_reason: "management_llm_decision",
                  market_condition: getMarketIntelligence()?.condition || "UNKNOWN",
                  _hunt_source: "management-llm",
                },
              }).catch(e => log("management_warn", `trackPosition failed for LLM buy ${tokenOut?.slice(0, 8)}: ${e.message}`));

              // MGMT-4: include dry_run flag in entry events too, so downstream
              // listeners can distinguish demo paper-fills from real entries.
              agentBus.emit("management:llm_entry_executed", {
                mint: tokenOut,
                amount_sol: result.amount,
                walletAddress,
                dry_run: !!result.dry_run,
                timestamp: Date.now(),
              });
            }
          }
        },
      }), LLM_TIMEOUT_MS, "llm_manager");
      mgmtReport = content;

      // MGMT-5: warn if the LLM response hugs the token cap — likely
      // truncated and missing tail actions/justifications.
      // Approximation: chars/4 ~ tokens. Warn at 90% of MAX_LLM_TOKENS.
      const approxTokens = (content?.length || 0) / 4;
      if (approxTokens > MAX_LLM_TOKENS * 0.9) {
        log("management_warn",
          `LLM response approx ${approxTokens.toFixed(0)} tokens (cap=${MAX_LLM_TOKENS}) — may be truncated; consider raising max_tokens or trimming prompt`,
        );
      }

      // Emit LLM review complete to bus
      agentBus.emit("management:llm_review_complete", {
        tokenCount: remainingTokens.length,
        reportLength: content?.length || 0,
        timestamp: Date.now(),
      });
    } else if (remainingTokens.length > 0 && (!isLLMReviewEnabled() || !_allActiveUseLlm)) {
      // MA-2: LLM review toggle gate. When disabled (global or use_llm:false in active set),
      // run deterministic exits only — SL/trail/ROI handle everything.
      const ruleIds = getActiveStrategyIds().filter(id => getStrategy(id)?.use_llm === false);
      const stratLabel = ruleIds.length > 0 ? ` (rule-based: ${ruleIds.join(", ")})` : "";
      mgmtReport = `Rule-based${stratLabel}: ${deterministicExits.length} deterministic exit(s) + ${remainingTokens.length} position(s) managed by SL/trail/ROI.`;
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
      // Cycle reports are LLM text — convert markdown to HTML or the chat
      // shows literal **/###/- characters.
      const body = llmToTelegramHtml(mgmtReport);
      if (liveMessage) await liveMessage.finalize(body);
      else sendHTML(`🔄 <b>Mgmt</b>\n${body}`);
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

  // Vault operator override: pause_trading
  const _vaultPause = getVaultOverrides();
  if (_vaultPause.pause_trading) {
    _screeningBusy = false;
    log("vault_override", "pause_trading=true in operator-notes — screening paused");
    return "Operator pause active (vault: operator-notes.md)";
  }

  // GUARD: checkAllGates runs BEFORE the main try/finally below. If it throws,
  // the finally never runs and _screeningBusy stays true forever — the cron
  // cycle wedges permanently until process restart. Reset on throw here.
  let gate;
  try {
    gate = await checkAllGates("screening");
  } catch (e) {
    _screeningBusy = false;
    log("cron_error", `screening gate check failed: ${e.message}`);
    recordError("screening_cycle");
    return null;
  }
  if (gate.blocked) {
    _screeningBusy = false;
    agentBus.emit("screening:gate_blocked", { reason: gate.reason, timestamp: Date.now() });
    return gate.reason;
  }

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

    // ─── Per-Strategy Position Limit ──────────────
    // Uses manual config or Kelly formula from position-limits module.
    // Falls back to strategy protections → config.risk.maxPositions → 3.
    const strategyPositionLimit = getStrategyPositionLimit(strategy?.id);
    const baseMaxPositions = strategyPositionLimit > 0
      ? strategyPositionLimit
      : (strategy?.protections?.max_open_trades ?? config.risk?.maxPositions ?? 3);
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

    // ─── Wallet SOL (resolve early — used by activation gate AND deploy calc) ───
    const recentTrades = getPerformanceHistory({ limit: 30 });
    const activeWallet = getActiveWallet();
    const walletSol = isMultiWalletEnabled() && activeWallet
      ? getWalletCapitalSol(activeWallet.address, balance.sol)
      : balance.sol;

    // ─── Min SOL Activation Gate ────────────────────
    const activeStrategyId = strategy?.id || "scalp";
    const solActivation = canActivateStrategy(walletSol, activeStrategyId);
    if (!solActivation.canOpen) {
      const minSol = getStrategyMinSolToActivate(activeStrategyId);
      log("position_limits", `Min SOL gate: ${solActivation.reason} (strategy=${activeStrategyId})`);
      _screeningBusy = false;
      return `Min SOL not met for ${activeStrategyId}: need ${minSol} SOL, have ${walletSol.toFixed(3)} SOL`;
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

    // TDZ FIX: planSummary is first used here (adaptive-risk sizing, line ~3451)
    // but was previously only declared ~1100 lines later in the LLM block,
    // throwing "Cannot access 'planSummary' before initialization" on every
    // screening cycle with adaptiveRisk enabled. Declare + fetch once, early.
    let planSummary;
    try {
      planSummary = getPlanSummary();
    } catch (e) {
      log("plan", `WARN: getPlanSummary failed in screening: ${e.message}`);
      planSummary = null;
    }

    // TDZ FIX: marketIntel is first used in the adaptive-risk block below but
    // was only declared ~90 lines later (after recordMarketSnapshot), throwing
    // "Cannot access 'marketIntel' before initialization". Fetch the last
    // recorded snapshot early (fine for risk sizing — regime doesn't flip
    // mid-cycle); it's refreshed after recordMarketSnapshot for the main flow.
    let marketIntel = getMarketIntelligence();

    let deployAmount = computeDeployAmount(walletSol, { solPriceUsd: balance.sol_price });
    // ── Adaptive Risk: clamp deployAmount based on intra-session state ──────
    if (config.adaptiveRisk?.enabled) {
      const recentTradesForRug = (getPerformanceHistory?.({ limit: 10 }) || []);
      const rugRateRecent = recentTradesForRug.length > 0
        ? recentTradesForRug.filter(t => t.rug_detected).length / recentTradesForRug.length
        : 0;
      const adj = adaptDeployAmount(deployAmount, {
        consecutiveLosses: getConsecutiveLosses?.() ?? 0,
        sessionPnlPct:    planSummary?.today_pnl_pct ?? 0,
        circuitLocked:    _rugCircuitBreaker?.getStatus?.()?.locked ?? false,
        rugRateRecent,
        marketCondition:  marketIntel?.condition ?? "NORMAL",
        openRatio:        openTokens.length / Math.max(1, positionLimit),
      }, { minSol: config.adaptiveRisk.minSol, maxMultiplier: config.adaptiveRisk.maxMultiplier });
      if (adj.multiplier === 0) {
        log("adaptive_risk", `CIRCUIT_LOCKED: ${adj.reason} — skipping screening cycle`);
        return `[ADAPTIVE RISK] ${adj.reason} — cycle skipped`;
      }
      if (adj.multiplier !== 1.0) {
        log("adaptive_risk", `${adj.level}: deployAmount ${deployAmount}→${adj.amount_sol} SOL (${adj.reason})`);
        deployAmount = adj.amount_sol;
      }
    }
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
    let cappedCandidates = candidates.slice(0, MAX_CANDIDATES_PER_CYCLE);
    if (candidates.length > MAX_CANDIDATES_PER_CYCLE) {
      log("screening", `Capping candidates ${candidates.length} -> ${MAX_CANDIDATES_PER_CYCLE} to avoid API burst`);
    }

    // ─── Inject Hunter Prey ────────────────────────
    // Merge hunter agent finds with DexScreener discovery.
    // Hunter prey are pre-scored and get priority in the pipeline.
    const cachedPrey = getCachedPrey();
    if (cachedPrey.length > 0) {
      const before = cappedCandidates.length;
      cappedCandidates = injectHunterPrey(cappedCandidates, cachedPrey, config.hunter?.preyCap ?? 10);
      const hunterPrio = cachedPrey.filter(t => t._hunter_score >= 50).length;
      log("screening", `Hunter injected ${cappedCandidates.length - before} prey (${hunterPrio} priority) → ${cappedCandidates.length} total candidates`);
    }

    // ─── Inject Wallet Ping Candidates ───────────────
    // Smart money wallet activity → inject tokens into screening with elevated priority.
    const walletPingCandidates = getSmartMoneyCandidates({ minWinRate: 0.60 });
    if (walletPingCandidates.length > 0) {
      const before = cappedCandidates.length;
      cappedCandidates = injectWalletPingCandidates(cappedCandidates, walletPingCandidates, 10);
      const smCount = walletPingCandidates.filter(t => t._hunter_tier === "PRIORITY").length;
      log("screening", `Wallet ping injected ${cappedCandidates.length - before} candidates (${smCount} priority smart money) → ${cappedCandidates.length} total`);
    }

    // ─── Fresh On-Chain Candidates ──────────────────
    // Inject pools discovered via WebSocket programSubscribe.
    // These are tokens created on-chain that DexScreener hasn't indexed yet.
    const freshOnChain = getFreshOnChainCandidates({ maxAgeMs: 120_000, limit: 10 });
    if (freshOnChain.length > 0) {
      for (const oc of freshOnChain) {
        if (!cappedCandidates.find(c => c.mint === oc.mint)) {
          if (!oc._hunt_source) oc._hunt_source = oc.source || "onchain-listener";
          cappedCandidates.push(oc);
        }
      }
      log("screening", `On-chain listener injected ${freshOnChain.length} fresh candidates → ${cappedCandidates.length} total`);
    }

    // ─── Buy Attribution Backfill ───────────────────
    // Hunter prey arrive pre-tagged; every other channel must carry its origin
    // too, or exits get attributed to source="unknown" and the per-source
    // learning loop (hunter weights, darwin) trains on a hole.
    for (const t of cappedCandidates) {
      if (!t._hunt_source) t._hunt_source = t._source || "dexscreener-discovery";
    }

    // ─── Rug Dev Auto-Block ─────────────────────────
    // Check each candidate's creator against the dev blocklist.
    // Tokens from known rug devs get auto-blacklisted before screening.
    let rugBlockedCount = 0;
    for (const token of cappedCandidates) {
      if (token.creator && token.mint) {
        const rugAlert = checkRugDevDeployer({
          creatorWallet: token.creator,
          tokenMint: token.mint,
          tokenSymbol: token.symbol,
        });
        if (rugAlert) {
          await autoBlockRugDevToken({
            creatorWallet: token.creator,
            tokenMint: token.mint,
            tokenSymbol: token.symbol,
          });
          rugBlockedCount++;
        }
      }
    }
    if (rugBlockedCount > 0) {
      log("wallet_signal", `Rug dev auto-block: ${rugBlockedCount} tokens blocked before screening`);
    }

    // ─── Market intelligence ─────────────────────
    const marketSnap = await recordMarketSnapshot(cappedCandidates);
    marketIntel = getMarketIntelligence(); // refresh after snapshot (declared early for adaptive-risk TDZ fix)
    const heatmap = computeMarketRegime();
    log("market", `Market: ${marketIntel.condition} (confidence: ${marketSnap.confidence}) → heatmap ${heatmap.regime} maxPos=${heatmap.max_positions}`);

    // ─── Multi-chain market intelligence (additive — guides hunter allocation,
    // recorded by the hunter after GMGN fetches; does not gate screening) ───
    const chainRanking = rankChainsByActivity();
    const hottestChain = getHottestChain("sol");
    if (chainRanking.length > 1) {
      log("market", `Chain ranking: ${chainRanking.map(c => `${c.chain}(${c.score})`).join(" > ")}`);
      log("market", `Hottest chain: ${hottestChain}`);
    }

    enrichMarketResearchWithAgentRouter({ marketIntel, candidates: cappedCandidates })
      .catch(e => log("market_research_error", e.message));

    if (marketIntel.condition === "DEAD") {
      if (!config.pipelineTestMode) {
        _screeningBusy = false;
        return "Market DEAD — skip entries";
      }
      log("screening", `Pipeline test mode — skipping DEAD market gate (market: ${marketIntel.condition})`);
    }

    // Auto market adaptation now only informs ranking/notes; it must not
    // mutate live screening config in-place.
    const marketAdjustments = config.pilot.autoAdaptToMarket
      ? getRecommendedAdjustments(marketIntel.condition)
      : null;
    if (marketAdjustments?.skip_entry && !config.pipelineTestMode) {
      _screeningBusy = false;
      return `Market adaptation recommends skip_entry for ${marketIntel.condition}`;
    }

    // ─── Filter + Rug Memory ─────────────────────
    const narrativeFiltered = filterNarrativeContagion(cappedCandidates);
    if (narrativeFiltered.length < cappedCandidates.length) {
      log("screening", `Narrative contagion: removed ${cappedCandidates.length - narrativeFiltered.length}/${cappedCandidates.length} candidates`);
    }

    // ─── Vault operator overrides (operator-notes.md) ────────────────────────
    const vaultOpts = getVaultOverrides();
    const afterVault = vaultOpts.blacklist_tokens.length > 0 || vaultOpts.blacklist_narratives.length > 0 || vaultOpts.skip_mcap_above != null
      ? narrativeFiltered.filter(token => {
          const sym = (token.symbol || "").toUpperCase();
          const narr = (token.narrative || token._narrative || "").toLowerCase();
          const mcap = token.mcap || 0;

          if (vaultOpts.blacklist_tokens.includes(sym)) {
            log("vault_override", `${sym}: operator blacklist (token)`);
            return false;
          }
          if (vaultOpts.blacklist_narratives.some(n => narr.includes(n))) {
            log("vault_override", `${sym}: operator blacklist (narrative: ${narr})`);
            return false;
          }
          if (vaultOpts.skip_mcap_above != null && mcap > vaultOpts.skip_mcap_above) {
            log("vault_override", `${sym}: operator mcap cap ${(mcap/1000).toFixed(0)}k > ${(vaultOpts.skip_mcap_above/1000).toFixed(0)}k`);
            return false;
          }
          return true;
        })
      : narrativeFiltered;

    // ─── Layer 0: Trash Gate — Pintu Utama Sebelum Screening ─────
    // outerShieldScreen: RugCheck.xyz (L0) → Token-2022 extension check
    // → 7-dimension scoring. Semua kandidat diblokir di sini sebelum
    // Helius API dipanggil — hemat credit, jaga pipeline bersih.
    const rugMemory = getRugMemory();
    const recentRugs = getPerformanceHistory({ limit: 20 }).filter(t => t.rug_detected);
    let trashGateResult;
    if (config.pipelineTestMode) {
      afterVault.forEach(t => { t._trash_test_mode = true; });
      trashGateResult = {
        passed: afterVault, flagged: [], warned: [], blocked: [],
        stats: { total: afterVault.length, passed: afterVault.length, blocked: 0, rugBlocked: 0 },
      };
      log("screening", "Pipeline test mode — trash gate bypassed, semua kandidat lolos");
    } else {
      trashGateResult = await outerShieldScreen(afterVault, {
        marketCondition: marketIntel.condition,
        rugMemory,
        recentRugs,
      });
    }
    // ALLOW + FLAG + WARN lanjut; hanya BLOCK yang ditolak.
    // Token WARN sudah membawa _trash_score/_trash_flags untuk penalti downstream.
    const preScreened = [
      ...trashGateResult.passed,
      ...trashGateResult.flagged,
      ...trashGateResult.warned,
    ];
    if (trashGateResult.stats.blocked > 0) {
      const rugInfo = trashGateResult.stats.rugBlocked > 0
        ? ` (${trashGateResult.stats.rugBlocked} via RugCheck)`
        : "";
      log("screening", `Trash gate: ${trashGateResult.stats.blocked}/${afterVault.length} BLOCKED${rugInfo} — ${preScreened.length} lanjut ke screening`);
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
    for (const token of selectDeepScreenBatch(preScreened, 8)) {
      if (isTokenBlacklisted(token.mint)) continue;
      if (await isTokenOnCooldown(token.mint)) continue;
      if (token.creator && isDevBlocked(token.creator)) continue;
      batchTokens.push(token);
    }

    // ─── Parallel API fetch phase ──────────────────
    const apiResults = await Promise.all(
      batchTokens.map(async (token) => {
        const tokenChain = token.chain || "sol";
        const [security, tokenInfo, rugCheck] = await Promise.allSettled([
          getTokenSecurityDetails({ mint: token.mint, chain: tokenChain }),
          getTokenInfo({ query: token.mint }).catch(e => ({ error: e.message })),
          // RugCheck.xyz is Solana-only — skip for EVM chains.
          tokenChain === "sol" ? getRugCheckReport(token.mint) : Promise.resolve(null),
        ]);
        return {
          token,
          security: security.status === "fulfilled" ? security.value : { error: security.reason?.message },
          tokenInfo: tokenInfo.status === "fulfilled" ? tokenInfo.value : { error: tokenInfo.reason?.message },
          rugCheck: rugCheck.status === "fulfilled" ? rugCheck.value : { error: rugCheck.reason?.message },
        };
      })
    );

    // ─── Pre-fetch klines in parallel (before sequential analysis) ─────────
    // Klines are fired concurrently; GeckoTerminal's internal _gtQueue serializes
    // them with a 3.1s gap so the 30/min rate-limit is respected. Parallelizing
    // here saves ~(N-1)×3s per cycle vs sequential awaits and prevents the 90s
    // cron timeout from killing mid-analysis. Results are cached in a Map and
    // consumed in the per-token loop below without re-awaiting.
    const klineCache = new Map();
    if (config.indicators?.enabled) {
      const klineResolution = config.indicators.intervals?.[0] === "5_MINUTE" ? "5m" : "1m";
      const klineLimit = config.indicators.candles || 100;
      await Promise.all(
        apiResults.map(async ({ token }) => {
          try {
            const klineData = await getTokenKlines({
              mint: token.mint,
              pair_address: token.pair_address,
              resolution: klineResolution,
              limit: klineLimit,
              chain: token.chain || "sol",
            });
            klineCache.set(token.mint, klineData);
          } catch (_) {
            klineCache.set(token.mint, { candles: [] });
          }
        })
      );
    }

    for (const { token, security, tokenInfo, rugCheck } of apiResults) {
      if (security?.error) {
        log("filter", `${token.symbol}: SKIP — security fetch failed: ${security.error}`);
        continue;
      }
      // ── RugCheck integration: convert RugCheck report → Ponyou signals
      const rugCheckSignals = rugCheck?.indexed ? rugCheckToSignals(rugCheck) : {};

      // ── Dev blacklist check (market-cap-aware) + vault overrides
      const creatorAddr = token.creator || security?.security?.creator || null;
      const _devOv = getDevOverrides();
      // Vault distrust_devs = manual permanent block (operator's explicit call)
      if (creatorAddr && _devOv.distrusted.has(creatorAddr)) {
        log("vault_override", `${token.symbol}: BLOCKED — dev ${creatorAddr.slice(0, 10)} in vault distrust_devs`);
        continue;
      }
      // Vault trusted_devs = skip auto-blacklist
      const devBl = creatorAddr && _devOv.trusted.has(creatorAddr)
        ? { blocked: false, flagged: false, tier: null, entry: null }
        : checkDevBlacklist(creatorAddr);
      if (devBl.blocked) {
        log("dev_blacklist", `${token.symbol}: BLOCKED — dev ${creatorAddr?.slice(0, 10)} is ${devBl.tier} blacklisted (${devBl.entry?.reason})`);
        continue;
      }
      // Flagged devs add to rug score; trusted devs get a conviction bonus (handled below)
      let devBlBonus = 0;
      if (devBl.flagged) {
        devBlBonus = devBl.tier === "MEDIUM" ? 12 : 6;
      }
      const devTrusted = creatorAddr ? _devOv.trusted.has(creatorAddr) : false;

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
          gmgn_row_risk: token._gmgn_risk || null,          // pre-fetched rank/trenches risk fields
        },
      });

      // Add dev blacklist penalty AFTER scoreRugRisk (separate concern)
      if (devBlBonus > 0) {
        rugRisk.score = Math.min(100, rugRisk.score + devBlBonus);
        rugRisk.reasons.push(`Dev ${devBl.tier} blacklisted (${devBl.entry?.rug_count || 1} rugs, +${devBlBonus})`);
      }
      // Vault trusted dev → small rug score reduction (operator explicitly endorses this dev)
      if (devTrusted) {
        rugRisk.score = Math.max(0, rugRisk.score - 8);
        rugRisk.reasons.push("Dev vault-trusted (-8)");
      }

      // ─── Experiment #1 telemetry: GMGN row-risk (Layer 2d) ────────────────
      // Observability for the candidate variant. Only fires for GMGN-discovered
      // tokens (token._gmgn_risk present). Records whether Layer 2d contributed
      // to the score and whether it pushed the token into the >=60 block band,
      // so the operator can aggregate candidate samples for experiment #1 without
      // re-deriving from logs. Pure measurement — no effect on the trade decision.
      if (token._gmgn_risk) {
        const layer2dFired = rugRisk.reasons.some(r => r.startsWith("GMGN row:"));
        recordCounter("gmgn_row_risk_evaluated");
        if (layer2dFired) {
          recordCounter("gmgn_row_risk_contributed");
          if (rugRisk.score >= 60) recordCounter("gmgn_row_risk_blocked");
          log("experiment_gmgn_row",
            `exp#1 ${token.symbol || token.mint.slice(0, 8)} score=${rugRisk.score} blocked=${rugRisk.score >= 60} ` +
            `rug_ratio=${token._gmgn_risk.rug_ratio ?? "?"} honeypot=${token._gmgn_risk.is_honeypot ?? "?"} ` +
            `reasons="${rugRisk.reasons.filter(r => r.startsWith("GMGN row:")).join(" | ")}"`);
        }
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

      // ─── Dex Visibility Risk Analysis ────────────
      // Catches distribution traps: old/pumped tokens with late dex-boost ads.
      // Uses the same data already in scope — no extra network calls.
      if (rugRisk.score < 60) {
        const dexViz = analyzeDexVisibilityRisk({
          tokenAgeMinutes: token.age_minutes ?? 0,
          pricePumpPercent: token.change1h ?? 0,
          volumeUsd: token.volume ?? token.volume24h ?? 0,
          uniqueWallets: token.holder_count ?? 0,
          top10HolderConcentration: security?.holders?.top10_holders_pct ?? security?.rug_signals?.top10_concentration_pct ?? 0,
          devWalletNotHolding: (security?.rug_signals?.creator_pct ?? 100) < 0.5,
          organicCommunityScore: 50,
          narrativeScore: 50,
          hasDexPaid: false,
          hasAds: false,
          hasBoost: false,
          marketCondition: config.marketCondition ?? "NORMAL",
        });
        if (dexViz.riskStatus === DexRiskStatus.HIGH_RISK) {
          rugRisk.score = Math.min(100, rugRisk.score + 15);
          rugRisk.reasons.push(`DexViz: HIGH_RISK score=${dexViz.visibilityRiskScore} (+15)`);
        } else if (dexViz.riskStatus === DexRiskStatus.DANGER) {
          rugRisk.score = Math.min(100, rugRisk.score + 8);
          rugRisk.reasons.push(`DexViz: DANGER score=${dexViz.visibilityRiskScore} (+8)`);
        } else if (dexViz.riskStatus === DexRiskStatus.POSITIVE) {
          rugRisk.score = Math.max(0, rugRisk.score - 3);
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

      // Entry hard-block threshold — configurable (exp #10: paper book runs at
      // 35; default 60 = legacy). Auto-blacklist below still requires >= 100.
      const maxEntryRug = config.screening?.maxEntryRugScore ?? 60;
      if (rugRisk.score >= maxEntryRug) {
        log("filter", `${token.symbol}: SKIP rug score ${rugRisk.score} >= ${maxEntryRug}`);
        // Auto-blacklist confirmed honeypots so they never waste another cycle
        if (rugRisk.score >= 100 && !rugRisk.no_autoblacklist) {
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

      // ─── Wallet Tier Check ──────────────────────
      // Check if any wallet involved in this token is flagged by tier system
      const involvedWallets = [
        ...(security?.smart_money?.buys || []).map(w => w.wallet || w.address).filter(Boolean),
        ...(security?.smart_money?.sells || []).map(w => w.wallet || w.address).filter(Boolean),
        creatorAddr,
      ].filter(Boolean);

      if (involvedWallets.length > 0) {
        const walletCheck = checkWalletSignals(involvedWallets, "buy");

        // BLOCK: rug wallet involved
        if (walletCheck.block) {
          log("wallet_tiers", `${token.symbol}: BLOCKED — ${walletCheck.warnings[0]}`);
          continue;
        }

        // WARNING: insider wallet
        if (walletCheck.warnings.length > 0) {
          token._trash_flags = token._trash_flags || [];
          token._trash_flags.push(...walletCheck.warnings.map(w => `wallet_tier_warn:${w}`));
          log("wallet_tiers", `${token.symbol}: WARNING — ${walletCheck.warnings.join(", ")}`);
        }

        // STRONG BUY: elite/smart money buying
        if (walletCheck.buySignals.length > 0) {
          token._wallet_buy_signals = walletCheck.buySignals;
          log("wallet_tiers", `${token.symbol}: BUY SIGNAL — ${walletCheck.buySignals.join(", ")}`);
        }
      }

      if (tokenInfo?.error) {
        log("filter", `${token.symbol}: SKIP — getTokenInfo failed: ${tokenInfo.error}`);
        continue;
      }

      // Active strategy for tier execution + downstream context
      const activeStrategy = getStrategy(null, { regime: marketIntel.condition });
      // Keep null when Jupiter has no fee data — coercing null→0 would always fire
      // the min_token_fees_sol gate, consuming the entire flag budget for scalping.
      const globalFees = tokenInfo.results?.[0]?.global_fees_sol ?? null;
      const tierInfo = getMcapTier(token.mcap);
      const tierExec = getTierExecutionProfile(token.mcap, activeStrategy?.id || null);
      if (tierExec.sell_only) {
        log("filter", `${token.symbol}: SKIP sell-only tier ${tierExec.tier}`);
        continue;
      }
      // holder_count from Jupiter DataAPI (tokenInfo); used by min_holders gate in
      // run4FilterProtocol for smart_money/day_phase_trading. Falls back to any count
      // already on the token (some GMGN/smart-money paths set it); null = gate skips.
      const holderCount = tokenInfo.results?.[0]?.holders ?? token.holder_count ?? null;
      const enhancedToken = { ...token, chain: token.chain || "sol", global_fees_sol: globalFees, holder_count: holderCount, tier: tierInfo, _trash_flags: token._trash_flags || [] };

      // ATH-proxy: compute dip_from_ath_pct from kline window-high when CoinGecko
      // data is unavailable (most new memecoins). This makes the dip_buy preset's
      // max_ath_distance_pct gate enforceable instead of silently skipped.
      // Tagged _ath_estimate_source="kline_high" so it's distinguishable from the
      // true-ATH path (CoinGecko overwrites this at line ~4155 if available).
      if (enhancedToken.dip_from_ath_pct == null) {
        const kc = klineCache.get(token.mint);
        const candles = Array.isArray(kc?.candles) ? kc.candles : [];
        const price = Number(enhancedToken.price) || 0;
        if (candles.length > 0 && price > 0) {
          const maxHigh = candles.reduce((m, c) => Math.max(m, Number(c.high) || 0), 0);
          if (maxHigh > 0) {
            enhancedToken.dip_from_ath_pct = Number(((price / maxHigh - 1) * 100).toFixed(1));
            enhancedToken._ath_estimate_source = "kline_high";
          }
        }
      }

      const filterResult = await run4FilterProtocol(enhancedToken, security, gasFee);

      // ─── Technical Indicators & Momentum Analysis ────────
      let technicals = null;
      let momentumValid = false;
      let momentumScore = 0;
      let momentumEntry = { pass: true };
      let volatilityPercentile = 50;
      let volatilityAdjustedSize = deployAmount;

      if (config.indicators.enabled && tierExec.use_technicals) {
        // klines pre-fetched in parallel above — read from cache (avoids sequential await)
        const klineData = klineCache.get(token.mint) || { candles: [] };
        log("screening", klineData.candles?.length
          ? `${token.symbol}: Klines ready (${klineData.candles.length} candles, pre-fetched, min=30)`
          : `${token.symbol}: No klines available — skipping momentum analysis`);

        if (klineData.candles && klineData.candles.length >= 30) {
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
              // UPGRADE indicators — surfaced to the LLM screening prompt for richer reads
              macd: momentum.macd ? { trend: momentum.macd.trend, cross: momentum.macd.cross, histogram: momentum.macd.histogram, rising: momentum.macd.rising } : null,
              ema_cross: momentum.emaCross ? { cross: momentum.emaCross.cross, fast_above: momentum.emaCross.fastAbove } : null,
              support_resistance: momentum.supportResistance ? {
                near_support: momentum.supportResistance.nearSupport,
                near_resistance: momentum.supportResistance.nearResistance,
                dist_support_pct: momentum.supportResistance.distToSupportPct,
                dist_resistance_pct: momentum.supportResistance.distToResistancePct,
              } : null,
              volume: momentum.volume ? { trend: momentum.volume.volumeTrend, spike: momentum.volume.volumeSpike, buy_ratio: momentum.volume.buyVolRatio } : null,
            };

            // Calculate volatility and adjust position size
            volatilityPercentile = calculateVolatilityPercentile(klineData.candles, 14);
            volatilityAdjustedSize = computeVolatilityAdjustedSize(deployAmount, volatilityPercentile);

            log("screening", `${token.symbol}: RSI=${technicals.rsi} ST=${momentum.trend} MOMENTUM=${momentumScore} VOL=${volatilityPercentile.toFixed(0)}% SIZE=${volatilityAdjustedSize} ENTRY=${momentumEntry.pass}`);
          }
        }
      }

      const conviction = getCoinConviction(token.mint, token, { narrativeVelocity, crossBatchVelocity });
      // Conviction-based size multiplier: applied on the Kelly fallback path
      // (when not enough trade history). Creates meaningful per-token differentiation
      // based on signal quality before Kelly's sample gate is reached.
      // When Kelly has real trade data, Kelly's own output is used instead.
      const _convMult = (() => {
        const s = conviction.conviction_score ?? 50;
        if (s >= 75) return 1.30;  // strong conviction → larger entry
        if (s >= 60) return 1.15;
        if (s >= 40) return 1.00;  // neutral / building
        return 0.75;                // unknown / weak → smaller entry
      })();
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
              conviction: conviction.conviction_score / 100,
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
      // Use Kelly output when it has enough trade data; apply conviction multiplier
      // on the fallback path (no trade history yet) for per-token differentiation.
      let sizedAmount = kelly.used_fallback
        ? parseFloat((preKellyAmount * _convMult).toFixed(4))
        : (kelly.deploy_amount_sol || preKellyAmount);
      // Streak sizer: compound win/loss multiplier on top of Kelly sizing.
      if (config.streakSizer?.enabled) {
        const streakMult = getStreakMultiplier(config.streakSizer);
        if (streakMult !== 1.0) {
          const prev = sizedAmount;
          sizedAmount = parseFloat((sizedAmount * streakMult).toFixed(4));
          if (sizedAmount !== prev) {
            log("streak_sizer", `mult=${streakMult.toFixed(3)} ${prev}→${sizedAmount} SOL`);
          }
        }
      }
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
        // social_buzz: gate-filtered Reddit/Discord/Telegram/Twitter score
        socialBuzz: config.useSocialHunter !== false
          ? getSocialScore(token.symbol || enhancedToken?.symbol || "", token.mint || null)
          : 0,
        // Darwin: learned component fitness re-weights the composite. The
        // weights file is tiny and read per candidate — cheap vs the network
        // enrichment that dominates this loop.
        darwinWeights: config.darwin?.enabled !== false ? getDarwinWeights() : null,
      });

      // ─── CoinGecko Enrichment (social + community + CEX data) ──
      let coingeckoData = null;
      let socialVelocityFromCG = null;
      try {
        const symbol = token.symbol || enhancedToken?.symbol || null;
        if (symbol) {
          coingeckoData = await enrichCoin({ symbol });
          if (coingeckoData) {
            socialVelocityFromCG = coinGeckoToSocialVelocity(coingeckoData);
            // Populate ATH distance for dip_buy/day_phase strategy matching and workflow.
            // CoinGecko's ath_change_percentage is already "% below ATH" as a negative
            // number — map it directly. Note: this runs AFTER the filter pass so it
            // doesn't affect the filter gate, but it does reach the strategy-matcher
            // and the workflow evaluator, letting them correctly identify dip candidates.
            // Fresh memecoins (not listed on CoinGecko) will still have null — that's fine;
            // dip_buy is a mid-cap strategy, not a fresh-launch one.
            if (coingeckoData.ath_change_pct != null) {
              enhancedToken.dip_from_ath_pct = coingeckoData.ath_change_pct;
              enhancedToken.ath_distance_pct = coingeckoData.ath_change_pct;
            }
          }
        }
      } catch (e) { /* CoinGecko is supplementary — fail silently */ }

      // ─── Community & Dev Assessment ────────────────────────────
      const communityAssessment = runCommunityAssessment({
        mint: token.mint,
        symbol: token.symbol,
        creator: token.creator || enhancedToken?.creator || null,
        launchpad: token.launchpad || token._dex || null,
        holder_count: token.holders || enhancedToken?.holders || null,
        holder_count_24h: null,
        top_10_concentration: token.top_10_pct || token.top10Concentration || null,
        price_usd: token.price || token.priceUsd || token.price_usd || null,
        price_24h: null,
        volume_24h: token.volume || token.volume24h || null,
        social_velocity: socialVelocityFromCG?.velocity_score || narrativeVelocity?.velocity_score || null,
        dev_balance: null,
        dev_initial_balance: null,
        dev_last_active_hours: coingeckoData?.developer?.commit_count_4w > 0 ? 24 : null,
        dev_engagement_score: coingeckoData ? Math.round(coingeckoData.developer.developer_score * 100) : null,
        bot_holder_estimate: token.bot_holders_pct || null,
        sniper_count: token.sniper_count || null,
        whale_count: token.whale_count || null,
        bonding_curve_progress: token.bonding_curve || null,
        lp_moved_to: null,
        cex_listings: coingeckoData?.cex_listings?.map(l => l.exchange) || [],
        age_hours: token.age_minutes ? token.age_minutes / 60 : null,
      });
      if (communityAssessment.signals.length > 0) {
        log("community", `${token.symbol}: ${communityAssessment.signals.join(", ")} — ${communityAssessment.summary}`);
      }

      // Boost conviction with community quality signal
      const communityBonus = communityAssessment.community_quality?.is_quality_community ? 5 : 0;
      const devBonus = communityAssessment.dev?.credibility === "HIGH" ? 8
        : communityAssessment.dev?.credibility === "MEDIUM" ? 4 : 0;
      const devPenalty = communityAssessment.dev?.tier === "RUGGER" ? -15 : 0;
      const ctoBonus = communityAssessment.community_takeover?.is_cto ? 3 : 0;

      // Bonding curve near-graduation bonus: pump.fun token approaching Raydium
      // graduation is a strong demand signal. Only fires when field is populated.
      const bcProgress = token.bonding_curve ?? null;
      const bcBonus = bcProgress != null && bcProgress >= 80 && bcProgress < 100
        ? Math.round((bcProgress - 80) * 0.4)  // 0 at 80%, +8 at 100%
        : 0;

      // Buy-side pressure bonus: buy vol > 65% of total = bullish momentum.
      // Null-safe — activates only if GMGN sends buy_volume_1h/sell_volume_1h.
      const bsBonus = (token.buy_pressure != null && token.buy_pressure > 0.65)
        ? Math.round((token.buy_pressure - 0.65) * 20)  // max +7
        : 0;

      // Feature aggregate boosts conviction floor for trending/strong signals
      const boostedConviction = {
        ...conviction,
        conviction_score: Math.min(100, Math.max(0,
          conviction.conviction_score
          + Math.max(0, (featureResult.aggregate - 30) * 0.3)
          + communityBonus + devBonus + devPenalty + ctoBonus
          + bcBonus + bsBonus
        )),
        feature_aggregate: featureResult.aggregate,
        community_assessment: communityAssessment,  // attach for downstream
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
              community_assessment: communityAssessment,
            },
            conviction: boostedConviction,
            marketCondition: marketIntel.condition,
            config: config.decisionWorkflow,
            narrativeVelocity,
            portfolioContext: {
              open_positions: openTokens.length,
              max_positions: positionLimit,
              session_pnl_pct: getPlanSummary()?.today_pnl_pct ?? undefined,
              kill_switch_threshold: -15,
              consecutive_losses: config.pilot.enabled ? getConsecutiveLosses() : 0,
              pro_skip_threshold: 3,
              same_narrative_count: openTokens.filter(t => narrativeTags.some(nt => (t.narrative_tags || []).includes(nt))).length,
              daily_guard_blocked: isDailyTradeGuardEntryBlocked?.(config.dailyTradeGuard) ?? false,
              in_profit_mode: config.pilot.enabled ? isInProfitMode() : false,
            },
            timingContext: {
              circuit_breaker_locked: _rugCircuitBreaker?.getStatus?.()?.locked ?? false,
              circuit_breaker_reason: _rugCircuitBreaker?.getStatus?.()?.lockReason ?? null,
              learning_mode_active: getLearningModeStatus?.()?.active ?? false,
              token_cooldown_active: isTokenOnCooldown ? await isTokenOnCooldown(enhancedToken.mint) : false,
              cooldown_remaining_min: 0,
            },
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
      // Multi-strategy: score this token against all active strategies, pick best fit.
      // Falls back to single active strategy in single-strategy mode.
      const activeStratIds = getActiveStrategyIds();
      let matchedStrategyId = getActiveStrategyId();
      if (activeStratIds.length > 1) {
        const { all: allScores } = matchStrategyForCoin({
          token: enhancedToken,
          activeStrategyId: matchedStrategyId,
          marketCondition: marketIntel.condition,
        });
        const bestFromActive = allScores
          .filter(s => activeStratIds.includes(s.id))
          .sort((a, b) => b.score - a.score)[0];
        if (bestFromActive) matchedStrategyId = bestFromActive.id;
      }
      const matchedStrategy = getStrategy(matchedStrategyId);

      // For use_llm:false strategies (e.g. degen): bypass both the LLM workflow gate
      // and the momentum gate — hunter score is the primary momentum signal, and many
      // fresh/micro-cap targets lack enough klines for RSI/ST calculation anyway.
      const stratUsesLlm = matchedStrategy?.use_llm !== false;
      const passed = filterResult.passed && !kelly.should_skip &&
        (stratUsesLlm ? workflow.llm_can_buy : true);
      const flags = [...(filterResult.flags || [])];

      // Diagnostic visibility: log WHY a token fails at strategy/kelly/workflow gate.
      // Previously these failures were silent — only rug and sell-only had explicit logs.
      // Needed for monitoring to understand the 0-deploy problem.
      if (!passed) {
        const topReason = !filterResult.passed
          ? (filterResult.flags?.[0] || "strategy_filter")
          : kelly.should_skip
            ? (kelly.tier === "MICRO" ? "kelly_micro_tier" : "kelly_edge")
            : (workflow.verdict === "shadow" ? "workflow_shadow" : `workflow_${workflow.verdict}`);
        const mcapK = Math.round((enhancedToken.mcap || token.mcap || 0) / 1000);
        log("filter", `${token.symbol}: SKIP ${topReason} [strat=${matchedStrategyId} mcap=${mcapK}k rug=${rugRisk.score}]`);
      }

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

      // ─── Portfolio ensemble shadow-compare (Phase 2) ────────────
      // When config.portfolio.enabled (default OFF), compute how the parallel
      // strategy-skill book WOULD have voted vs the live single-strategy
      // decision. In shadow mode this never acts — it only surfaces the
      // comparison so the operator can validate before flipping to active.
      let portfolioShadow = null;
      if (config.portfolio?.enabled) {
        try {
          portfolioShadow = computePortfolioDecision({
            candidate: {
              mint: enhancedToken.mint,
              symbol: token.symbol,
              mcap_usd: enhancedToken.mcap ?? token.mcap ?? null,
              holders: enhancedToken.holders ?? token.holders ?? null,
              age_minutes: token.age_minutes ?? null,
              flags_count: flags.length,
              narrative_tags: narrativeTags,
              conviction,
            },
            baseSignal: signal.signal_score,
            walletSol,
            openPositions: openTokens.map(t => ({ narrative_tags: t.narrative_tags || [] })),
          });
          if (portfolioShadow?.active) {
            log("portfolio",
              `shadow-compare ${token.symbol}: book=${portfolioShadow.decision} `
              + `(ens=${portfolioShadow.ensemble.ensembleScore} agree=${portfolioShadow.ensemble.agreeCount}/${portfolioShadow.ensemble.activeCount}) `
              + `vs live=${passed ? "BUY" : "SKIP"}`
            );
          }
        } catch (e) { /* shadow-compare is observability-only — never block live */ }
      }

      // ─── Pro Orchestrator BUY Gate ─────────────────────────────
      // Bypassed for use_llm:false strategies — degen/rule-based deploys on
      // hunter score + rug filter alone; pro gate's conviction/kelly/workflow
      // requirements are designed for LLM-conservative mode.
      let proBuySkipped = false;
      if (passed && isProModeActive() && stratUsesLlm) {
        const proBuyResult = proBuyDecision({
          conviction: boostedConviction,
          signal,
          kelly,
          workflow,
          rugScore: rugRisk.score,
          marketCondition: marketIntel.condition,
          narrativeVelocity,
          volatilityPercentile,
          liquidity: enhancedToken?.liquidity ?? 0,
        });
        if (proBuyResult.action === "SKIP") {
          // Validation mode = SHADOW ONLY: log the would-be veto but do NOT block.
          // Only full pro mode (8 requirements + manual approval) actually vetoes.
          if (isProValidationMode()) {
            log("pro_orchestrator",
              `[SHADOW] would-SKIP ${token.symbol}: ${proBuyResult.convergingSignals}/${proBuyResult.requiredSignals} signals (conf=${proBuyResult.confidence}%) — NOT blocking (validation mode)`
            );
          } else {
            proBuySkipped = true;
            flags.push(
              `Pro gate SKIP: ${proBuyResult.convergingSignals}/${proBuyResult.requiredSignals} signals — ${proBuyResult.reasons.join(", ")}`
            );
            log("pro_orchestrator",
              `BUY SKIP ${token.symbol}: ${proBuyResult.convergingSignals}/${proBuyResult.requiredSignals} signals (conf=${proBuyResult.confidence}%)`
            );
          }
        } else {
          log("pro_orchestrator",
            `BUY PASS ${token.symbol}: ${proBuyResult.convergingSignals}/${proBuyResult.requiredSignals} signals (conf=${proBuyResult.confidence}%)`
          );
        }
      }
      // ─── Intel layer (S1+S2+S4): insider / slow-rug / FOMO ──────
      // Three pre-flight signals that run on every candidate and can
      // hard-block entry if severe. They're additive to the existing
      // pro buy gate — not replacements.
      let intel = { insider: null, slow_rug: null, fomo: null, intel_blocked: false, intel_blockers: [] };
      try {
        intel.insider = detectInsiderPatterns(enhancedToken);
        intel.fomo = evaluateFomoSetup(enhancedToken);
        intel.slow_rug = evaluateSlowRug(enhancedToken.mint);
        if (intel.insider.level === "block") {
          intel.intel_blocked = true;
          intel.intel_blockers.push(`insider: ${intel.insider.reasons.join(" | ")}`);
        }
        // Momentum strategies (scalping/degen/sniper) specifically target pumping
        // tokens. Blocking +50%/1h candidates defeats the entire hunter premise.
        const fomoExemptStrategies = new Set(["scalping", "degen", "sniper"]);
        const isFomoExempt = fomoExemptStrategies.has(matchedStrategyId);
        if (intel.fomo.block && !isFomoExempt) {
          intel.intel_blocked = true;
          intel.intel_blockers.push(`fomo: ${intel.fomo.signals.join(" | ")}`);
        }
        if (intel.slow_rug.triggered && intel.slow_rug.severity === "high") {
          intel.intel_blocked = true;
          intel.intel_blockers.push(`slow-rug: ${intel.slow_rug.pattern}`);
        }
        if (intel.intel_blocked) {
          flags.push(...intel.intel_blockers);
          log("intel_block", `${token.symbol}: ${intel.intel_blockers.join(" | ")}`);
        }
      } catch (e) {
        log("intel_err", `${token.symbol}: ${e.message || e}`);
      }
      // Record liquidity + price/volume samples for slow-rug and volume-divergence
      // detectors so they have a baseline before the position is even opened.
      try {
        const _liq = Number(enhancedToken?.liquidity_usd ?? enhancedToken?.liquidity ?? 0);
        const _priceUsd = Number(enhancedToken?.price_usd ?? enhancedToken?.priceUsd ?? 0);
        if (enhancedToken?.mint && _liq > 0) {
          await recordLiquiditySample({ mint: enhancedToken.mint, liquidity_usd: _liq, price_usd: _priceUsd });
        }
        const _vol = Number(
          enhancedToken?.volume_5m_usd ?? enhancedToken?.volume_5m ??
          enhancedToken?.volume_recent_usd ?? enhancedToken?.volume_24h_usd ?? 0
        );
        if (enhancedToken?.mint && _priceUsd > 0) {
          await recordPriceVolumeSample({ mint: enhancedToken.mint, price_usd: _priceUsd, volume_recent_usd: _vol });
        }
      } catch {}

      let finalPassed = passed && !proBuySkipped && !intel.intel_blocked;

      // Portfolio book ACTIVE gate (Phase 2 live cutover). When the book is
      // live (config.portfolio.enabled + mode "active"), the ensemble becomes
      // an ADDITIONAL required endorsement: it can only make entries MORE
      // selective and NEVER bypasses the rug/intel/pro gates above (we already
      // require the legacy `passed`). Candidates the book doesn't actionably
      // endorse are held. In shadow mode this is inert (only the log above).
      if (finalPassed && config.portfolio?.enabled && portfolioShadow?.mode === "active" && !portfolioShadow.actionable) {
        finalPassed = false;
        flags.push(
          `Portfolio book gate: ${portfolioShadow.decision} `
          + `(ens=${portfolioShadow.ensemble?.ensembleScore} agree=${portfolioShadow.ensemble?.agreeCount}/${portfolioShadow.ensemble?.activeCount})`
        );
      }

      // ─── R:R Guard ───────────────────────────────────────────────
      if (finalPassed && config.rrGuard?.enabled) {
        // Prefer strategy-specific SL/trailing over global config — strategies
        // have very different SL widths (scalping -15%, degen -30%, swing -25%).
        // stoploss in strategy-presets is a decimal (e.g. -0.30 = -30%).
        const stratSlDecimal = matchedStrategy?.stoploss;
        const stratTrailingDecimal = matchedStrategy?.trailing_stop?.positive_offset;
        const slPct = Number.isFinite(stratSlDecimal) && stratSlDecimal < 0
          ? stratSlDecimal * 100
          : (config.management?.stopLossPct ?? -20);
        const tpPct = config.management?.takeProfitPct ?? null;
        const trailing = Number.isFinite(stratTrailingDecimal) && stratTrailingDecimal > 0
          ? stratTrailingDecimal * 100
          : (config.management?.trailingTriggerPct ?? null);
        const rrResult = checkRiskReward(slPct, tpPct, {
          minRatio: config.rrGuard.minRatio ?? 1.5,
          trailingTriggerPct: trailing,
        });
        if (!rrResult.passes) {
          finalPassed = false;
          flags.push(`R:R guard: ${rrResult.reason}`);
          log("rr_guard", `${token.symbol}: SKIP ${rrResult.reason} [strat=${matchedStrategyId}]`);
        }
      }

      // ─── G3: Per-coin strategy match ─────────────────────────────
      // Score this candidate against every preset and pick the best fit.
      // Pro-orch-only feature — without pro-orch, we keep using the global
      // active strategy (legacy behavior). Annotated as `selected_strategy`
      // so the deployment path can dispatch under the chosen preset's params.
      let strategyMatch = null;
      try {
        if (isProModeActive()) {
          strategyMatch = matchStrategyForCoin({
            token: enhancedToken,
            activeStrategyId: getActiveStrategyId(),
            marketCondition: marketIntel.condition,
          });
          if (strategyMatch.suggest_override) {
            log("strategy_match",
              `${token.symbol} → ${strategyMatch.best.id} (score=${strategyMatch.best.score.toFixed(2)} vs active=${strategyMatch.active.score.toFixed(2)}): ${strategyMatch.best.reasons.join(", ")}`
            );
          }
        }
      } catch (e) {
        log("strategy_match_err", `${token.symbol}: ${e.message || e}`);
        strategyMatch = null;
      }

      // ─── Cast-Net (Tebar Jala) gate ──────────────────────────────
      // Only evaluated when the buy already passed pro-orch — cast-net is
      // an ADDITIVE high-conviction multi-wallet option, never a relaxation
      // of the normal gate. If gate-allowed, the candidate is annotated so
      // the executor can split the entry across up to 10 wallets with
      // timing+amount jitter. If blocked, the buy proceeds normally as
      // single-wallet.
      let castNetEval = null;
      if (finalPassed && isProModeActive()) {
        try {
          // total_experience is populated by getExperienceScore — represents
          // the size of the profit-patterns memory used to derive the score.
          const totalMem = Number(boostedConviction?.experience_score?.total_experience ?? 0);
          castNetEval = await proCastNetDecision({
            token: enhancedToken,
            conviction: boostedConviction,
            totalMemorySamples: totalMem,
            smartMoneyMinHolders: 2,
          });
          if (castNetEval.allowed) {
            log("cast_net",
              `🎣 GATE PASS ${token.symbol}: ${castNetEval.plan.wallets} wallets / ${castNetEval.plan.bankrollPct}% bankroll`
            );
          } else if (castNetEval.blockers.length > 0) {
            // Only log when the operator actually has cast-net enabled —
            // otherwise the disabled-by-default state would spam logs.
            if (config.castNet?.enabled) {
              log("cast_net",
                `gate block ${token.symbol}: ${castNetEval.blockers.slice(0, 3).join(" | ")}`
              );
            }
          }
        } catch (e) {
          log("cast_net", `gate error ${token.symbol}: ${e.message || e}`);
          castNetEval = null;
        }
      }

      let recommendedAmount = preRegimeAmount;
      if (config.regimeMemory?.enabled) {
        const cap = config.regimeMemory?.tailwindMultiplierCap ?? 1.15;
        const floor = config.regimeMemory?.headwindMultiplierFloor ?? 0.4;
        const sizeMultiplier = Math.max(floor, Math.min(cap, regime.size_multiplier || 1));
        recommendedAmount = Number((preRegimeAmount * sizeMultiplier).toFixed(4));
      }
      // Portfolio active sizing: when the book is live + actionable, the
      // ensemble's per-skill capital allocation (already bounded by deploy
      // floor/ceil in the allocator) drives the position size.
      if (config.portfolio?.enabled && portfolioShadow?.mode === "active" && portfolioShadow.actionable
          && portfolioShadow.allocation?.totalSizeSol > 0) {
        recommendedAmount = Number(portfolioShadow.allocation.totalSizeSol.toFixed(4));
      }
      // Hard cap: stacked multipliers (regime × Kelly × portfolio) can exceed maxDeployAmount.
      // Clamp here as a final safety net regardless of which path set the size.
      recommendedAmount = Number(Math.min(recommendedAmount, config.risk?.maxDeployAmount ?? 35).toFixed(4));
      // Skills (active + shadow) whose filters this entry cleared — persisted so
      // the exit can attribute the trade's P&L back to them. Active skills get
      // live credit; shadow skills accrue the PAPER sample that earns promotion
      // (Phase 3 loop input). Empty unless the book is enabled.
      const portfolioSkillVotes = (portfolioShadow?.ensemble?.perSkill || [])
        .filter(v => v.passed)
        .map(v => v.skillId);

      scoredCandidates.push({
        ...enhancedToken, ...filterResult,
        passed: finalPassed,
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
        // Darwinian genome: components that voted for this candidate. Flows to
        // trackPosition (own-trade feedback on close) and shadowWatch (market
        // feedback on rug/moon without buying).
        active_signals: triggeredSignals(signal),
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
        community_assessment: communityAssessment,
        dev_reputation: communityAssessment.dev,
        conviction_summary: getConvictionPromptLine(token.mint, token),
        cast_net: castNetEval,
        strategy_match: strategyMatch,
        selected_strategy: matchedStrategyId || strategyMatch?.selected_strategy || getActiveStrategyId(),
        intel,
        portfolio_skill_votes: portfolioSkillVotes,
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

      // Shadow watchlist — monitor tokens NOT bought for free rug learning
      try {
        for (const candidate of scoredCandidates) {
          if (!candidate.passed && (candidate.signal?.signal_score ?? 0) >= 15) {
            shadowWatch(candidate);
          }
        }
      } catch (e) { log("shadow_error", e.message); }

      // Log rule-based rejections to vault — operator sees what rug defense caught
      try {
        const skipped = scoredCandidates.filter(c => !c.passed && (c.rug_score ?? 0) >= 50);
        if (skipped.length > 0) {
          setImmediate(() => logSkippedTokens(skipped, marketIntel?.condition || "UNKNOWN").catch(() => {}));
        }
      } catch { /* best-effort */ }

      // Feed fundamental signals to the strategy producer. Internal throttle
      // (maxPerHour) prevents spam — tick is safe to call every screening cycle.
      if (_fundamentalProducer) {
        try {
          const sampleTokens = scoredCandidates.slice(0, 8);
          const sampleWallets = listSmartWallets({ minDecayMultiplier: 0.5 })
            .slice(0, 12)
            .map(w => w.address);
          // Pro-orchestrator gate: block strategy creation if data evidence is insufficient
          const proCtx = isProModeActive() ? runProAnalysis() : null;
          const readiness = isProModeActive() ? validateStrategyReadiness() : null;
          if (readiness && !readiness.ready) {
            log("pro_orchestrator",
              `Producer tick SKIPPED — strategy creation blocked: ${readiness.summary}`
            );
          } else {
            await _fundamentalProducer.tick({
              sampleTokens,
              sampleWallets,
              regime: computeMarketRegime?.()?.regime || null,
              proIntel: proCtx,
            });
          }
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
    // planSummary already fetched early in this cycle (TDZ fix) — reuse it.

    if (entryBlockedByFee) {
      passingCandidates = applyFeeEntryGuard(passingCandidates, gasFee);
    } else if (passingCandidates.length > 0) {
      const guardedCandidates = [];
      for (const candidate of passingCandidates) {
        // ─── Per-Coin Position Limit ─────────────────
        const perCoinCheck = canEnterToken(candidate.mint, activeStrategyId);
        if (!perCoinCheck.allowed) {
          log("position_limits", `${candidate.symbol || candidate.mint}: ${perCoinCheck.reason}`);
          continue;
        }

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
          totalBankrollSol: Number(balance?.balance_sol ?? walletSol ?? 0),
        });
        if (batch.deployed.length > 0) {
          log("fast_track", `Deployed ${batch.deployed.length} via fast-track: ${batch.deployed.map(t => t.symbol).join(", ")}`);
        }
        const deployedMints = new Set(batch.deployed.map(t => t.mint));
        passingCandidates = passingCandidates.filter(c => !deployedMints.has(c.mint));
      }
    }

    // Rule-based path triggers when ANY active strategy has use_llm:false.
    let anyRuleBased = getActiveStrategyIds().some(id => getStrategy(id)?.use_llm === false);
    if (passingCandidates.length > 0 && anyRuleBased) {
      // Pick best from rule-based eligible candidates first (use_llm:false matched strategy).
      // Fall through to LLM for candidates whose matched strategy uses LLM.
      const rbCandidates = passingCandidates.filter(c => getStrategy(c.selected_strategy)?.use_llm === false);
      const llmCandidates = passingCandidates.filter(c => getStrategy(c.selected_strategy)?.use_llm !== false);
      if (rbCandidates.length > 0) {
      const rbReports = [];
      // Deploy multiple rule-based candidates up to available slot limit
      for (const best of rbCandidates) {
        const slotsUsed = openTokens.length + rbReports.length;
        if (slotsUsed >= positionLimit) break;
      const bestStratLabel = best.selected_strategy !== getActiveStrategyId()
        ? ` [${best.selected_strategy}]` : "";
      log("cron", `[RULE-BASED${bestStratLabel}] ${best.symbol}: feature=${best.feature_aggregate} rug=${best.rug_score} hunter=${best._hunter_score ?? "?"} → direct deploy`);
      const swapAmount = best.recommended_deploy_amount_sol || deployAmount;
      try {
        const result = await executeTool("swap_token", {
          token_in: "SOL",
          token_out: best.mint,
          amount: swapAmount,
          slippage: 0.1,
          chain: best.chain || "sol",   // executor routes non-sol via GMGN swap
        });
        recordSwapOutcome({ success: !!(result?.success || result?.dry_run) });
        const executions = selectFilledExecutions(result, {
          wallet_address: result?.wallet_address || getActiveWallet()?.address || null,
          amount: swapAmount,
        });
        if (executions.length > 0) {
          const activeStrat = getStrategy(best.selected_strategy) || getStrategy(null, { regime: marketIntel.condition });
          const stagedCfg = activeStrat?.staged_entry;
          for (const exec of executions) {
            const stage1Amount = getStage1Amount(stagedCfg, exec.amount || swapAmount);
            const entryUsd = (stage1Amount * (balance.sol_price || 0)) || 0;
            let stagedTracking = null;
            if (stagedCfg?.enabled && stagedCfg.stages > 1) {
              stagedTracking = initStagedEntry(null, activeStrat, stage1Amount, balance.sol_price || 0);
            }
            await trackPosition({
              position: best.mint,
              pool: "jupiter",
              pool_name: best.symbol,
              amount_sol: stage1Amount,
              initial_value_usd: entryUsd,
              chain: best.chain || "sol",
              strategy_used: best.selected_strategy || getActiveStrategyId(),
              // Darwin: the components that voted for this entry — fed back
              // into signal weights when the trade closes (updateDarwinWeights).
              active_signals: best.active_signals || triggeredSignals(best.signal),
              signal_snapshot: {
                mint: best.mint,
                symbol: best.symbol,
                entry_price: best.price || 0,
                token_amount: best.price > 0 ? entryUsd / best.price : 0,
                market_condition: best.market_condition || marketIntel.condition,
                rug_score: best.rug_score || 0,
                conviction: best.conviction || null,
                regime: best.regime || null,
                workflow: best.workflow || null,
                kelly: best.kelly || null,
                staged_entry: stagedTracking,
                portfolio_skill_votes: best.portfolio_skill_votes || [],
                _hunt_source: best._hunt_source || null,
                _social_source: best._social_source || null,
                execution_context: {
                  wallet_address: exec.wallet_address || null,
                  provider: result?.execution_provider || "auto",
                  slippage: Number(result?.slippage || 0),
                },
              },
              wallet_address: exec.wallet_address || null,
              paper_trade: process.env.DRY_RUN === 'true' || process.env.PAPER_TRADING === 'true',
            });
          }
          recordTrade(null);
        }
        rbReports.push(result?.success || result?.dry_run
          ? `[RULE-BASED] ${best.symbol}${bestStratLabel} feature=${best.feature_aggregate} size=${swapAmount}SOL`
          : `[RULE-BASED] FAIL ${best.symbol}: ${result?.error || "unknown"}`);
      } catch (e) {
        rbReports.push(`[RULE-BASED] ERR ${best.symbol}: ${e.message}`);
        log("cron_error", `rule-based deploy: ${e.message}`);
      }
      } // end for loop
      if (rbReports.length > 0) screenReport = rbReports.join(" | ");
      } else if (llmCandidates.length > 0) {
        // rbCandidates empty but llmCandidates exist → fall through to LLM
        passingCandidates = llmCandidates;
        anyRuleBased = false; // allow LLM branch below
      }
    }
    if (!screenReport && passingCandidates.length > 0 && !anyRuleBased) {
      log("cron", `${passingCandidates.length} passed — invoking LLM`);
      // Vault context: intelligence mode (rich) or basic mode
      const _vaultBlock = config.vault?.intelligenceEnabled
        ? getVaultIntelligenceContext()
        : (() => {
            const _chainOv = getChainOverrides();
            const _chainStratParts = Object.entries(_chainOv.preferred_strategy).map(([c, s]) => `${c}=${s}`);
            const _vaultCtx = getVaultContext();
            const _smCtx = getSmartMoneyContext();
            const _chainStratCtx = _chainStratParts.length > 0
              ? `[CHAIN STRATEGY] ${_chainStratParts.join(" ")}`
              : null;
            return [_vaultCtx, _smCtx, _chainStratCtx].filter(Boolean).join("\n") || null;
          })();
      // Super Brain: adaptive risk status, episodic recall, learned rules
      const _adaptiveRiskLine = config.adaptiveRisk?.enabled
        ? getAdaptiveRiskPromptLine({
            consecutiveLosses: getConsecutiveLosses?.() ?? 0,
            sessionPnlPct:     planSummary?.today_pnl_pct ?? 0,
            circuitLocked:     _rugCircuitBreaker?.getStatus?.()?.locked ?? false,
            marketCondition:   marketIntel?.condition ?? "NORMAL",
          })
        : null;
      const _episodicBlock = config.episodicMemory?.enabled
        ? await getEpisodicBlock(passingCandidates, { minSamples: config.episodicMemory.minSamples })
        : null;
      const _learnedRules = config.promptEvolution?.enabled
        ? getLearnedRulesBlock()
        : null;

      // Track how many positions this LLM cycle opens — hard-enforced in onToolFinish.
      let deployedThisCycle = 0;

      const { content } = await agentLoop(`
SCREENING CYCLE
Amount: ${deployAmount} SOL
Gas: ${gasFee.level}
Market: ${marketIntel.condition} — ${marketIntel.description}
${planSummary ? `Plan: Day ${planSummary.day} | P&L: ${planSummary.today_pnl_pct}% | Target: +${planSummary.daily_target_pct}%${planSummary.profit_mode ? " | 🔥 PROFIT MODE — no trade limit" : ""}` : ""}
Posisi aktif: ${openTokens.length}/${positionLimit}
${_vaultBlock ? _vaultBlock + '\n' : ''}${_adaptiveRiskLine ? _adaptiveRiskLine + '\n' : ''}${_episodicBlock ? _episodicBlock + '\n' : ''}${_learnedRules ? _learnedRules + '\n' : ''}
CANDIDATES (lolos 4-filter + rug check):
${JSON.stringify(passingCandidates.map(c => ({
  symbol: c.symbol,
  mint: c.mint?.slice(0, 8),
  feature_aggregate: c.feature_aggregate,
  feature_scores: c.feature_scores,
  rug_score: c.rug_score,
  conviction: c.conviction?.conviction_score,
  trending_boost: c.conviction?.trending_boost,
  verdict: c.workflow?.verdict,
  kelly_skip: c.kelly?.should_skip,
  narrative: c.narrative_tags?.[0],
  mcap: c.mcap,
  liq: c.liquidity,
  deploy_sol: c.recommended_deploy_amount_sol,
  selected_strategy: c.selected_strategy,
  age_min: c.age_minutes,
})))}

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
          if (name === "swap_token") {
            // Track every leg that actually filled — including partial-fill
            // splits where the overall result.success is false but earlier
            // legs already bought. Without this, those live positions are
            // orphaned (bought but never tracked/managed/sold).
            const executions = selectFilledExecutions(result, {
              wallet_address: result.wallet_address || result.would_swap?.wallet_address || getActiveWallet()?.address || null,
              amount: deployAmount,
            });
            const token = executions.length > 0
              ? passingCandidates.find(c =>
                  c.mint === result.token_out || c.mint === result.would_swap?.token_out
                )
              : null;
            if (token) {
              // Hard position-limit guard: LLM is told the limit in the prompt
              // but is not structurally prevented from calling swap_token N times.
              // Enforce here so the system never opens more slots than allowed.
              if (openTokens.length + deployedThisCycle >= positionLimit) {
                log("protection", `Screener limit guard: ${openTokens.length}+${deployedThisCycle}/${positionLimit} — LLM over-entry blocked`);
              } else {
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

                // ─── Fee Tracking: Entry ──────────────────
                const entrySlippage = extractSlippageFromSwapResult(result, stage1Amount);
                const entryFeeBreakdown = computeTradeFeeBreakdown({
                  amountSol: stage1Amount,
                  dexId: token.dex || token.launchpad || "unknown",
                  isEntry: true,
                  expectedPrice: token.price || 0,
                  actualPrice: token.price ? token.price * (1 + entrySlippage.price_impact_pct / 100) : 0,
                  liquidity: token.liquidity || 0,
                  volume: token.volume || 0,
                  priorityFeeSol: (Number(result?.priority_fee_lamports || 0) / 1e9) || 0,
                  jitoTipSol: (Number(result?.total_tip_lamports || result?.tip_lamports || 0) / 1e9) || 0,
                  txFeeLamports: result?.tx_fee_lamports || null,
                  tokenAccountsCreated: 1,
                });
                recordTokenAccountCreated();
                recordSimCall();

                await trackPosition({
                  position: token.mint,
                  pool: "jupiter",
                  pool_name: token.symbol,
                  amount_sol: stage1Amount,
                  initial_value_usd: entryUsd,
                  chain: token.chain || "sol",
                  signal_snapshot: {
                    mint: token.mint,
                    symbol: token.symbol,
                    // Entry price + token qty: used by paper-wallet for accurate
                    // virtual holdings, and by live exits (which already look for
                    // signal_snapshot.entry_price) instead of re-deriving it.
                    entry_price: token.price || 0,
                    token_amount: token.price > 0 ? entryUsd / token.price : 0,
                    market_condition: token.market_condition || marketIntel.condition,
                    rug_score: token.rug_score || 0,
                    conviction: token.conviction || null,
                    regime: token.regime || null,
                    workflow: token.workflow || null,
                    kelly: token.kelly || null,
                    staged_entry: stagedTracking,
                    entry_fee_breakdown: entryFeeBreakdown,
                    entry_dex: token.dex || token.launchpad || "unknown",
                    portfolio_skill_votes: token.portfolio_skill_votes || [],
                    _hunt_source: token._hunt_source || null,
                    _social_source: token._social_source || null,
                    execution_context: {
                      wallet_address: exec.wallet_address || null,
                      provider: result?.execution_provider || "auto",
                      slippage: Number(result?.slippage || entrySlippage.slippage_bps / 100 || 0),
                    },
                  },
                  strategy_used: token.selected_strategy || getActiveStrategyId(),
                  active_signals: token.active_signals || triggeredSignals(token.signal),
                  wallet_address: exec.wallet_address || null,
                  paper_trade: process.env.DRY_RUN === 'true' || process.env.PAPER_TRADING === 'true',
                });
                deployedThisCycle++;
              }
              recordTrade(null); // outcome unknown yet
              } // end else (position limit guard)
            }
          }
        },
      });
      screenReport = content;
      setImmediate(() => {
        logScreeningDecision({
          candidates: passingCandidates,
          decision: content,
          marketCondition: marketIntel?.condition || "UNKNOWN",
          deployAmount,
        }).catch(() => {});
      });
    }
    if (!screenReport) {
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
      const body = llmToTelegramHtml(screenReport);
      if (liveMessage) await liveMessage.finalize(body);
      else sendHTML(`🔍 <b>Screen</b>\n${body}`);
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
  persistPath: path.join(__dirname, "rug-circuit-breaker-state.json"),
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

    // B4: tag the token with the active strategy so fast-track trackPosition
    // records strategy_used correctly (analytics: geyser entries were always null).
    if (!token.selected_strategy) token.selected_strategy = getActiveStrategyId();

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

    // T2-2: geyser path previously skipped canEnterToken, preSwapGuard, and
    // simulateSell — the three safety gates the screening path runs before
    // runFastTrackBatch. Add them here so geyser entries get the same protection.
    const geyserStratId = getActiveStrategyId();
    const posCheck = canEnterToken(token.mint, geyserStratId);
    if (!posCheck.allowed) {
      log("geyser_smart_buy", `position limit: ${posCheck.reason}`);
      return;
    }
    const geyserGuard = await preSwapGuard({ mint: token.mint, amountSol: deployAmountSol });
    if (!geyserGuard.allowed) {
      log("geyser_smart_buy", `pre-swap guard: ${geyserGuard.reason}`);
      return;
    }
    const geyserSellSim = await simulateSell(token.mint, { timeoutMs: 5000 });
    if (geyserSellSim.can_sell === false) {
      log("geyser_smart_buy", `sell-sim blocked: ${geyserSellSim.reason}`);
      return;
    }

    const batch = await runFastTrackBatch({
      candidates: [token],
      fastTrackConfig: config.fastTrack,
      deployAmountSol,
      solPriceUsd: 0,
      maxNew: 1,
      totalBankrollSol: Number(walletSol || 0),
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
    const { readFile } = await import("fs/promises");
    const discovered = JSON.parse(await readFile("discovered-wallets.json", "utf8"));
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

  // Path 2: live discovery. Needs a PnL-scoring provider — Helius (tx scoring)
  // OR GMGN (curated wallet stats + smart-money/KOL sync).
  const _gmgnOn = !!(process.env.GMGN_API_KEY && process.env.GMGN_API_KEY !== "dummy-gmgn-key");
  const _heliusOn = !!(process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY !== "dummy-helius-key");
  if (process.env.SCREENING_MODE === "dexscreener" && !_gmgnOn) {
    log("smart_wallets", "DexScreener-only mode, no GMGN — skip live discovery.");
    return;
  }
  if (!_heliusOn && !_gmgnOn) {
    log("smart_wallets", "No Helius or GMGN — skip live discovery. Set GMGN_API_KEY or HELIUS_API_KEY.");
    return;
  }

  // GMGN seed: sync GMGN's curated smart-money/KOL list (no-op without a key).
  if (_gmgnOn) {
    try {
      const { syncGmgnWallets } = await import("./tools/wallet-discovery.js");
      const sync = await syncGmgnWallets();
      if (sync?.added > 0) log("smart_wallets", `GMGN sync: +${sync.added} wallets (${sync.total} candidates)`);
    } catch (e) {
      log("smart_wallets", `GMGN sync failed: ${e.message}`);
    }
  }

  log("smart_wallets", _heliusOn ? "Running live Helius discovery…" : "Running GMGN-backed discovery…");
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
    // ─── On-Chain Pool Listener ─────────────────────────────
    // Real-time DEX pool discovery via WebSocket programSubscribe.
    // Catches new tokens at slot 0 — no DexScreener delay.
    const rpcUrl = process.env.RPC_URL || config.rpcUrl || "https://api.mainnet-beta.solana.com";
    const wssUrl = process.env.WSS_URL || process.env.HELIUS_ATLAS_WS_URL || "";
    startOnChainListener({
      rpcUrl,
      wssUrl: wssUrl || rpcUrl.replace("https://", "wss://"),
      enabled: true,
      onNewPool: (pool) => {
        // Pool is auto-added to listener cache; screening cron picks it up
        // via getFreshOnChainCandidates() on the next cycle. This callback
        // is just for visibility.
        const addr = pool.mint || pool.poolAddress;
        if (addr) {
          log("onchain", `${pool.programName}: new ${pool.mint ? "mint" : "pool"} ${addr.slice(0, 12)}... (slot ${pool.slot})`);
        }
      },
    });

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
            const activePositions = Object.values(getState()?.positions || {}).filter(p => p.mint === mint && !p.closed);
            for (const pos of activePositions) {
              log("geyser_exit_emergency", `Executing immediate emergency exit for ${pos.symbol} (${mint})`);
              const { result: res } = await withProgressiveSlippage(
                (slippage) => sellByChain({
                  token_in: mint, token_out: "SOL",
                  amount: pos.balance,
                  slippage: Math.max(slippage, 0.05),
                  chain: pos.chain || "sol",
                  wallet: pos.wallet_address ? getWalletByAddress(pos.wallet_address)?.keypair || null : null,
                })
              );
              if (res?.success || res?.dry_run || res?.indeterminate) {
                const closeReason = res?.indeterminate ? `emergency_exit: ${reason} (INDETERMINATE_SWAP)` : `emergency_exit: ${reason}`;
                log("geyser_exit_emergency", `Emergency exit marked closed for ${pos.symbol}: PnL ${res?.pnl_pct || 0}% (success=${!!res?.success}, indeterminate=${!!res?.indeterminate})`);
                await recordClose(pos.position_key || mint, closeReason, pos.wallet_address || null);
                _rugMonitor?.detachPosition(pos.position_key || mint);
                await clearPartialTPGuard(pos.position_key || mint);
                recordRuggedNarrativesForExit({ reason: closeReason, token: pos });
              } else {
                log("geyser_exit_emergency", `Emergency exit failed for ${pos.symbol}: ${res?.error || "unknown error"}`);
              }
            }
          },
          onSuspiciousActivity: (mint, reason, detail) => {
            log("geyser_exit_warn", `Suspicious: ${mint.slice(0, 8)} — ${reason}: ${detail}`);
          },
        }
      );
      log("turbo", "Exit monitor attached to Geyser stream");
    }
    if (config.rugMonitor?.enabled) {
      try {
        // RT1: wrap rug-monitor callbacks with the real-time intel bridge.
        // Every rug-monitor event (LOW/MEDIUM/HIGH) flows through here so
        // slow-rug and dev-wallet pattern detectors can build samples in
        // real time instead of only at management-cycle resolution.
        const bridgedCallbacks = wrapRugMonitorCallbacks({
          baseCallbacks: rugMonitorCallbacks,
          markForceExit: (positionKey, reason) => {
            const pos = getState()?.positions?.[positionKey];
            if (pos) {
              pos.rug_force_exit = true;
              pos.rug_force_exit_reason = reason;
              pos.rug_force_exit_ts = Date.now();
            }
          },
        });
        _rugMonitor = createRugMonitor({
          geyserStream: _geyserStream,
          config: config.rugMonitor,
          callbacks: bridgedCallbacks,
          fetchers: rugMonitorFetchers,
          log,
        });
        log("rug_monitor", `enabled (polling=${config.rugMonitor.pollingIntervalSec}s) + intel-bridge ON`);
      } catch (e) {
        log("rug_monitor_error", `init failed: ${e.message}`);
      }
    }
    if (config.executionEdge?.enabled) {
      try {
        const conns = config.executionEdge.rpcEndpoints.map(e => {
          const isHelius = e.url.includes("helius");
          return {
            url: e.url,
            label: e.label,
            primary: e.primary || false,
            call: async (method, ...args) => {
              // Gate Helius calls through circuit breaker to avoid 429 storms
              if (isHelius && heliusCircuitOpen()) {
                throw new Error("Helius circuit open");
              }
              const id = Math.random().toString(36).slice(2, 10);
              const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: args });
              const res = await fetch(e.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
                signal: AbortSignal.timeout(15_000),
              });
              if (res.status === 429) {
                if (isHelius) helius429Hit();
                throw new Error(`RPC 429 rate-limited (${e.label})`);
              }
              if (!res.ok) throw new Error(`RPC ${res.status}: ${e.label}`);
              const data = await res.json();
              if (data.error) throw new Error(data.error.message || `RPC error (${e.label})`);
              // Map common return shapes to match solana/web3.js return values
              if (method === "getRecentPrioritizationFees") return data.result;
              if (method === "getLatestBlockhash") return { blockhash: data.result.value.blockhash, lastValidBlockHeight: data.result.value.lastValidBlockHeight };
              if (method === "getAccountInfo") return data.result?.value ?? null;
              if (method === "getBalance") return data.result?.value ?? 0;
              return data.result;
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

  // Helper: wrap async work with a hard timeout so no single cycle can block the scheduler
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
  }

  // Management — Full cycle (N menit): deterministic exits + LLM review
  tasks.push(cron.schedule(`*/${config.schedule.managementIntervalMin} * * * *`, async () => {
    try {
      await withTimeout(runManagementCycle(), CYCLE_RPC_TIMEOUT_MS, "mgmt");
      agentBus.emit("management:full_cycle_complete", { timestamp: Date.now() });
    } catch (e) { log("mgmt_cron_error", e.message); }
  }));

  // Management Heartbeat — every 30s: ultra-fast position monitoring
  // Only checks rug monitor flags + emergency price drops. No LLM, no API calls.
  // Keeps Management Agent always watching positions between full cycles.
  tasks.push(cron.schedule("*/30 * * * * *", async () => {
    try {
      const balance = await getPortfolioSnapshot();
      const tokens = (balance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");
      if (tokens.length === 0) return;

      let heartbeatActions = 0;
      for (const token of tokens) {
        const tracked = getTrackedPosition(token.position_key || token.mint, token.wallet_address || null);
        if (!tracked) continue;

        // Check rug monitor force-exit flag (HIGH severity signal)
        if (tracked.rug_force_exit) {
          agentBus.emit("management:emergency_exit", {
            mint: token.mint,
            symbol: token.symbol,
            reason: tracked.rug_force_exit_reason || "rug_force_exit",
            type: "rug_emergency",
            timestamp: Date.now(),
          });
          heartbeatActions++;
        }

        // Check emergency price drop (>30% from entry in <10 min)
        const ageMin = (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000;
        if (ageMin < 10 && tracked.initial_value_usd > 0) {
          const pnlPct = ((token.usd - tracked.initial_value_usd) / tracked.initial_value_usd) * 100;
          if (pnlPct <= -30) {
            agentBus.emit("management:emergency_exit", {
              mint: token.mint,
              symbol: token.symbol,
              pnl_pct: pnlPct,
              reason: `emergency_price_crash: ${pnlPct.toFixed(1)}% in ${ageMin.toFixed(0)}min`,
              type: "price_crash",
              timestamp: Date.now(),
            });
            heartbeatActions++;
          }
        }
      }

      if (heartbeatActions > 0) {
        log("mgmt_heartbeat", `${heartbeatActions} emergency signals detected — triggering out-of-band management cycle`);
        // Fire an out-of-band management cycle immediately instead of waiting
        // for the next scheduled cron tick (which could be minutes away).
        // _managementBusy guard prevents double-execution with a running cycle.
        runManagementCycle({ silent: true }).catch(() => {});
      }
      agentBus.emit("management:heartbeat", {
        positions: tokens.length,
        emergencySignals: heartbeatActions,
        timestamp: Date.now(),
      });
    } catch (e) { /* silent — heartbeat must never crash */ }
  }));

  // Screening (offset +1 menit dari management agar tidak tabrakan — :01,:31 bukan :00,:30)
  tasks.push(cron.schedule(screeningCronPattern(config.schedule.screeningIntervalMin), async () => {
    try {
      await withTimeout(runScreeningCycle(), SCREENING_CYCLE_TIMEOUT_MS, "screening");
    } catch (e) { log("screening_cron_error", e.message); }
  }));

  // Orchestrator — Full automation cycle (every 2 min, offset +1 from mgmt)
  // Coordinates: market check → strategy selection → pipeline adaptation
  tasks.push(cron.schedule("1,16,31,46 * * * *", async () => {
    try {
      // Pro analysis — inject regime/narrative/strategy intelligence when pro mode is active
      if (isProModeActive()) {
        const proIntel = runProAnalysis();
        if (proIntel && proIntel.recommendations.length > 0) {
          log("pro_orchestrator",
            `Intelligence: ${proIntel.recommendations.map(r => r.detail).join(" | ")}`
          );
          agentBus.emit("pro:intelligence_ready", proIntel);
        }

        // Strategy creation readiness — fundamental analyst gate
        // Blocks strategy creation if agent lacks sufficient data/evidence
        const readiness = validateStrategyReadiness();
        if (!readiness.ready) {
          log("pro_orchestrator", `Strategy creation BLOCKED: ${readiness.summary}`);
          for (const c of readiness.components) {
            if (!c.passed) log("pro_orchestrator", `  ✗ ${c.name}: ${c.detail}`);
          }
        } else {
          log("pro_orchestrator", "Strategy creation READY — all 3 components passed.");
        }
        agentBus.emit("pro:strategy_readiness", readiness);
      }
      await runOrchestratorCycle({
        getStrategyFn: (id, opts) => getStrategy(id, opts),
        getMarketIntelFn: () => getMarketIntelligence(),
      });

      // Portfolio book rebalancing (Phase 2) — opt-in (config.portfolio.enabled,
      // default OFF). Reweights active strategy-skills by their live/paper
      // expectancy. Adjusts only registry weights the PortfolioManager reads;
      // never opens a trade and is inert while the book is in shadow mode.
      if (config.portfolio?.enabled) {
        const rb = rebalancePortfolioBook();
        if (rb.applied) log("portfolio", `book rebalanced: ${rb.count} skill(s) reweighted`);
      }
    } catch (e) { log("orchestrator_cron_error", e.message); }
  }));

  // Automation Qualification Check — every 30 min
  // Checks if bot has enough experience to enable full automation.
  // When qualified: sends proposal to Telegram for user approval.
  tasks.push(cron.schedule("7,37 * * * *", async () => {
    try {
      const result = runAutomationQualification({
        telegramSendFn: telegramEnabled() ? sendHTML : null,
      });
      if (result.qualified) {
        log("automation", `QUALIFIED (${result.progressPct}%) — proposal sent to Telegram`);
      }
    } catch (e) { log("automation_cron_error", e.message); }
  }));

  // Hunters Agent — runs every 4 min.
  // Gate-LAYER: check kill-switch + rug-breaker BEFORE hunting.
  // Market DEAD/EXTREME is handled inside the Hunters agent (HUNTER_SCHEDULE).
  tasks.push(cron.schedule("3,7,11,15,19,23,27,31,35,39,43,47,51,55,59 * * * *", async () => {
    try {
      const gate = await checkAllGates("hunters");
      if (gate.blocked) {
        agentBus.emit("hunters:gate_blocked", { reason: gate.reason, timestamp: Date.now() });
        return;
      }
      // HA-2: gate is open — release any schedule still frozen by a past
      // block (gate_blocked had no counterpart, so a temporary pause used to
      // kill hunting permanently until restart).
      agentBus.emit("hunters:gate_cleared", { timestamp: Date.now() });
      const strategy = getStrategy(null, { regime: getMarketIntelligence().condition });
      await runHuntersExpedition({ strategy });
    } catch (e) { log("hunters_cron_error", e.message); }
  }));

  // Skill-Codifier Loop (Phase 3) — opt-in (config.skillLoop.enabled, default
  // OFF). Mines winning patterns → authors a loop strategy-skill → backtests it
  // on REAL OHLCV of recently-profitable tokens → registers SHADOW (paper) if
  // the scorecard clears the gate. HARD GATE: it NEVER promotes to live capital
  // — promotion stays a manual, approved-only step.
  tasks.push(cron.schedule("13,43 * * * *", async () => {
    if (!config.skillLoop?.enabled || _codifierBusy) return;
    _codifierBusy = true;
    try {
      const report = await runCodifierCycle({
        loadTradesFn: async () => {
          const mints = getRecentProfitMints({ limit: 60 });
          return mints.length ? await loadTrades(mints, { resolution: "5m" }) : [];
        },
      });
      if (report.authored) {
        log("skill_codifier", `Authored SHADOW skill ${report.skillId} — awaiting paper sample + manual approval`);
      } else if (report.ran) {
        log("skill_codifier", `cycle: ${report.reason}`);
      }
    } catch (e) { log("skill_codifier_cron_error", e.message); }
    finally { _codifierBusy = false; }
  }));

  // Continuous Learning (setiap 30 menit, offset +2 agar tidak tabrakan)
  tasks.push(cron.schedule("2,32 * * * *", runContinuousLearningCycle));

  // Vault Proposal Engine — bot analyze data, generate proposals ke operator via Telegram
  // Setiap 6 jam (offset 15 agar tidak bertabrakan dengan cron lain)
  tasks.push(cron.schedule("15 */6 * * *", async () => {
    if (!_vaultProposal) return;
    try {
      const count = await _vaultProposal.analyze();
      if (count > 0) log("vault_proposal", `Cron: submitted ${count} proposal(s) to operator`);
    } catch (e) { log("vault_proposal_error", `Cron analyze failed: ${e.message}`); }
  }));

  // NotebookLM Export + Query cycle (setiap 6 jam, offset 30)
  // 1. Generate export markdown
  // 2. Upload ke NotebookLM notebook "Ponyou Brain" (jika auth tersedia)
  // 3. Query NotebookLM → generate vault proposals dari analisis AI
  tasks.push(cron.schedule("30 */6 * * *", async () => {
    try {
      // Step 1: generate export file
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("node", ["scripts/export-notebooklm.js"], {
        cwd: process.cwd(), timeout: 30_000,
      });
      log("notebooklm", "Export updated: ponyou-brain/notebooklm-export.md");

      // Step 2+3: upload + query NotebookLM if configured
      const { isNlmConfigured, nlmFindOrCreate, nlmUploadText, nlmAsk } = await import("./tools/notebooklm.js");
      if (!isNlmConfigured()) {
        log("notebooklm", "Not authenticated — skipping NotebookLM upload/query");
        return;
      }

      const fsPromises = await import("fs/promises");
      const exportPath = "/home/ubuntu/ponyou-brain/notebooklm-export.md";
      const exportContent = await fsPromises.readFile(exportPath, "utf8");

      // Find or create the Ponyou notebook
      const nb = await nlmFindOrCreate("Ponyou Brain");
      if (!nb?.notebook_id) { log("notebooklm_error", "Could not find/create notebook"); return; }

      // Upload latest export (replace if exists)
      const uploaded = await nlmUploadText(nb.notebook_id, `Ponyou Export ${new Date().toISOString().slice(0, 10)}`, exportContent);
      if (uploaded) {
        log("notebooklm", `Uploaded export to notebook ${nb.notebook_id.slice(0, 8)}`);
        // Step 3: query and generate proposals
        if (_vaultProposal) {
          await _vaultProposal.analyzeWithNotebookLM(nb.notebook_id);
        }
      }
    } catch (e) { log("notebooklm_error", `Cycle failed: ${e.message}`); }
  }));

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
      const { readFile } = await import("fs/promises");
      const wallets = JSON.parse(await readFile("discovered-wallets.json", "utf8"));
      const result = pruneDiscoveredWallets(wallets, { maxAgeDays: 30, maxWallets: 200 });
      if (result.removed > 0) {
        // atomic write — every other discovered-wallets writer uses it; a raw
        // writeFileSync here could leave a half-written/corrupt file if the
        // process crashes or another instance reads mid-write.
        atomicWriteJson("discovered-wallets.json", result.pruned);
        log("cron", `Wallet prune: removed ${result.removed} stale wallets, kept ${result.kept}`);
      }
    } catch (e) { /* file may not exist, OK */ }
    // Holder snapshot pruning — prevent holder-snapshots.json bloat
    try {
      await pruneOldSnapshots(24);
      log("cron", "Holder snapshot prune: removed snapshots older than 24h");
    } catch (e) { /* snapshot store may not exist, OK */ }
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

  // Vault snapshots (second brain — refresh every 5 min, fire-and-forget)
  tasks.push(cron.schedule("*/5 * * * *", () => refreshVaultSnapshots().catch(e => log("vault_snapshot_error", e.message))));

  // Health watchdog — liveness assertions every 15 min, Telegram alert on
  // alive→dead transitions (alert-only; never restarts anything)
  tasks.push(cron.schedule("*/15 * * * *", () =>
    runWatchdogCycle({ send: (msg) => sendMessage(msg) }).catch(e => log("watchdog_error", e.message))));

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
  // Vault intelligence: create template files on first activation
  if (config.vault?.intelligenceEnabled) {
    ensureIntelligenceTemplates().catch(() => {});
    log("vault", "Second brain intelligence ENABLED — templates created if missing");
  }
  // Dashboard IPC — check for commands from dashboard process every 3s
  _dashboardIpcTimer = setInterval(() => checkDashboardCommands().catch(e => log("dashboard_ipc", e.message)), 3000);
  log("cron", `Jobs started: mgmt=${config.schedule.managementIntervalMin}m screen=${config.schedule.screeningIntervalMin}m vault=6h report=${reportH}:${String(reportM).padStart(2,"0")}UTC`);
}

// ─── Dashboard IPC ────────────────────────────────────────────────
// Snapshot wallet topology into state.json for the dashboard. Called from the
// 3-second IPC poll AND the management cycle, so it dedupes: state.json is only
// rewritten when the topology actually changed since the last flush.
let _lastTopologySnapshot = null;
async function flushWalletTopology() {
  const { updateWalletTopology } = await import("./state.js");
  const { getAllWallets, isMultiWalletEnabled, getActiveWallet } = await import("./tools/wallet-manager.js");
  const activeW = getActiveWallet();
  const topology = {
    multi_wallet_enabled: isMultiWalletEnabled(),
    wallets: getAllWallets().map(w => ({
      address: w.address,
      label: w.label,
      status: w.status,
      capital_pct: w.capital_pct,
      error_count: w.error_count,
      cold_until: w.cold_until,
      is_active: activeW && activeW.address === w.address
    }))
  };
  const snapshot = JSON.stringify(topology);
  if (snapshot === _lastTopologySnapshot) return;
  _lastTopologySnapshot = snapshot;
  await updateWalletTopology(topology);
}

export async function checkDashboardCommands() {
  await flushWalletTopology().catch(e => log("dashboard_ipc", "Topology flush failed: " + e.message));

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
  // Watchdog: guarantee the process exits even if a cleanup step hangs
  // (e.g. flushState awaiting slow disk/IO). Without this, SIGTERM/SIGINT
  // and the "/off" command can wedge the process so only SIGKILL stops it.
  const _killTimer = setTimeout(() => {
    log("shutdown", `${signal} cleanup exceeded 5s — forcing exit`);
    process.exit(0);
  }, 5000);
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
  clearTimeout(_killTimer);
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

/**
 * Handler untuk pesan dari channel/grup sinyal — via user client MTProto.
 * Hanya parsing signal call, tidak ada command handling.
 */
export async function handleSignalChannelMessage(msg) {
  if (!msg?.text) return;
  if (config.useTelegramCalls) {
    await handleCallMessage(msg);
  }
}

export async function handleIncomingTelegramMessage(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  // ── Social call parsing — hanya jika dari bot polling (fallback jika user client off) ──
  // Jika user client aktif, signal channel sudah ditangani via handleSignalChannelMessage
  if (config.useTelegramCalls && !isUserClientEnabled()) {
    await handleCallMessage(msg);
  }

  if (text === "/pnl") {
    const history = getPerformanceHistory({ limit: 10 });
    const table = formatPnLTable(history);
    await sendHTML(table);
    return;
  }

  if (text === "/status") {
    const plan = getPlanSummary();
    const market = getMarketIntelligence();
    const ucStatus = getUserClientStatus();
    const planLine = plan
      ? `Day ${plan.day}/${plan.days_total} · ${fmt.pct(plan.today_pnl_pct ?? 0)}`
      : "belum diinisialisasi";
    const tgSignalLine = ucStatus.connected
      ? `user client (${ucStatus.monitor_mode})`
      : ucStatus.enabled ? "user client (connecting…)" : "bot polling";
    const message = [
      fmt.title("Status"),
      fmt.monoBlock([
        ["plan",   planLine],
        ["market", market.condition],
        ["auto",   cronStarted ? "ON" : "OFF"],
        ["guard",  formatDailyTradeGuardLine()],
        ["signal", tgSignalLine],
      ]),
    ].join("\n");
    await sendHTML(message);
    return;
  }

  // ── /setup_brain — Obsidian GitHub sync setup ────────────────────────────
  // Two-step to avoid token exposure in chat history:
  //   Step 1: /setup_brain              → tampilkan panduan
  //   Step 2: /setup_brain USERNAME/REPO → simpan repo, minta token via DM terpisah
  //   Step 3: brain token: ghp_xxx       → jalankan setup dengan token tersimpan
  if (text.startsWith("/setup_brain")) {
    const arg = text.replace(/^\/setup_brain\s*/, "").trim();
    if (!arg) {
      await sendHTML([
        "🧠 <b>Setup Obsidian Second Brain</b>",
        "",
        "<b>Step 1</b> — Buat repo di GitHub:",
        "github.com → New repository → <code>ponyou-brain</code> → Private",
        "",
        "<b>Step 2</b> — Kirim repo kamu:",
        "<code>/setup_brain USERNAME/ponyou-brain</code>",
        "",
        "<b>Step 3</b> — Kirim token (segera hapus pesannya):",
        "<code>brain token: ghp_xxx...</code>",
        "",
        "💡 <i>Token tidak disimpan ke log — hanya dipakai sekali untuk push.</i>",
      ].join("\n"));
      return;
    }
    // If arg looks like USER/REPO (no token), save repo and ask for token
    if (!arg.includes("github.com") && arg.includes("/")) {
      const repoSlug = arg.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
      process.env._BRAIN_PENDING_REPO = repoSlug;
      await sendHTML([
        `✅ <b>Repo disimpan:</b> <code>${htmlEscape(repoSlug)}</code>`,
        "",
        "Sekarang kirim token GitHub kamu (segera hapus pesan setelah terkirim):",
        "<code>brain token: ghp_xxxxxxxxxxxx</code>",
        "",
        "Dapat token di: github.com → Settings → Developer settings → Personal access tokens",
        "Pilih <b>Fine-grained</b> → pilih repo → Contents: <b>Read &amp; Write</b>",
      ].join("\n"));
      return;
    }
    // Legacy: full URL with embedded token (still supported)
    if (arg.includes("github.com")) {
      const response = await handleGeneralMessage(`setup brain: ${arg}`);
      await sendHTML(response);
      return;
    }
    await sendHTML("⚠️ Format tidak dikenal. Ketik <code>/setup_brain</code> untuk panduan.");
    return;
  }

  // ── brain token: ghp_xxx — step 2 of two-step brain setup ────────────────
  if (/^brain\s+token[:\s]+(\S+)/i.test(text)) {
    const token = text.match(/^brain\s+token[:\s]+(\S+)/i)?.[1]?.trim();
    const repo  = process.env._BRAIN_PENDING_REPO;
    if (!token || !repo) {
      await sendHTML("⚠️ Belum ada repo tersimpan. Mulai dari <code>/setup_brain</code> dulu.");
      return;
    }
    delete process.env._BRAIN_PENDING_REPO;
    const remoteUrl = `https://${token}@github.com/${repo}.git`;
    const response = await handleGeneralMessage(`setup brain: ${remoteUrl}`);
    await sendHTML(response);
    return;
  }

  // ── Vault Proposal Approval ──
  // Format: /approve_vault_XXXXXXXX or /reject_vault_XXXXXXXX
  if (text.startsWith("/approve_vault_") || text.startsWith("/reject_vault_")) {
    const approved = text.startsWith("/approve_vault_");
    const id = text.replace(/^\/(approve|reject)_vault_/, "vault_");
    if (_vaultProposal) {
      const handled = await _vaultProposal.handleResponse(id, approved);
      if (!handled) await sendHTML(`⚠️ Vault proposal <code>${id}</code> tidak ditemukan atau sudah resolved.`);
    } else {
      await sendHTML("Vault Proposal Engine tidak aktif.");
    }
    return;
  }

  // ── /vault_proposals — list pending vault proposals ──
  if (text === "/vault_proposals" || text === "/proposals") {
    if (_vaultProposal) {
      const dash = _vaultProposal.getDashboard();
      const lines = [`📚 <b>Vault Proposals</b>`, ``];
      if (dash.pending_count === 0) {
        lines.push(`Tidak ada proposal pending.`);
      } else {
        lines.push(`<b>${dash.pending_count} pending:</b>`);
        for (const p of dash.pending) {
          lines.push(`• [${p.type}] ${p.lesson_preview}…`);
          lines.push(`  <code>/approve_${p.id}</code> | <code>/reject_${p.id}</code>`);
        }
      }
      lines.push(``);
      lines.push(`History: ${dash.approved} approved, ${dash.rejected} rejected`);
      await sendHTML(lines.join("\n"));
    }
    return;
  }

  // ── /strategies — list & switch strategies ──
  if (text === "/strategies" || text.startsWith("/strategies ")) {
    const arg = text.replace(/^\/strategies\s*/, "").trim().toLowerCase();
    const { STRATEGY_IDS, getActiveStrategyId, setActiveStrategy, getStrategy, PRESETS } = await import("./strategies.js");
    if (!arg) {
      const active = getActiveStrategyId();
      const lines = [`⚙️ <b>Strategy Registry</b>`, ``];
      for (const id of STRATEGY_IDS) {
        const mark = id === active ? "🟢" : "⚫";
        const strat = PRESETS[id];
        lines.push(`${mark} <code>/strategies ${id}</code> — ${strat.name}`);
      }
      await sendHTML(lines.join("\n"));
      return;
    }
    if (!STRATEGY_IDS.includes(arg)) {
      await sendHTML(`⚠️ Strategi tidak ditemukan. Gunakan /strategies untuk melihat daftar.`);
      return;
    }
    setActiveStrategy(arg);
    const activeStrat = getStrategy();
    await sendHTML(`✅ <b>Strategi diubah</b>\nSistem sekarang menggunakan: <b>${activeStrat.name}</b>\n<i>${activeStrat.description}</i>`);
    return;
  }

  // /autonomy [manual|supervised|full_auto] — set autonomy level (single control)
  if (text === "/autonomy" || text.startsWith("/autonomy ")) {
    const arg = text.replace(/^\/autonomy\s*/, "").trim().toLowerCase();
    const VALID = { manual: "manual", supervised: "supervised", full_auto: "full_auto", fullauto: "full_auto", auto: "full_auto" };
    const { writeConfig, readConfig: _rc } = await import("./dashboard/config-writer.js");
    if (!arg) {
      const cfg = _rc();
      const mode = cfg.autonomyMode || "supervised";
      await sendHTML([
        `🎚️ <b>Autonomy Mode: ${mode.toUpperCase()}</b>`,
        ``,
        `<b>manual</b> — semua proposal butuh approve via Telegram`,
        `<b>supervised</b> — high-confidence auto-approve, sisanya review (default)`,
        `<b>full_auto</b> — bot apply semua proposal tanpa approval`,
        ``,
        `<i>Catatan: safety gate trading (kill-switch, maxDeployAmount, DRY_RUN, slippage) SELALU aktif apapun mode-nya.</i>`,
        ``,
        `Ganti: /autonomy manual | /autonomy supervised | /autonomy full_auto`,
      ].join("\n"));
      return;
    }
    const mode = VALID[arg];
    if (!mode) {
      await sendHTML(`⚠️ Mode tidak dikenal: "${arg}"\nGunakan: manual | supervised | full_auto`);
      return;
    }
    // full_auto forces both proposal gates off; manual/supervised turn them on
    const gateOn = mode !== "full_auto";
    writeConfig({ autonomyMode: mode, strategyProposalEnabled: gateOn, vaultProposalEnabled: gateOn });
    const desc = {
      manual:     "🔒 MANUAL — semua learning proposal butuh approve kamu dulu.",
      supervised: "🛡️ SUPERVISED — high-confidence auto-apply, low-confidence kirim ke kamu.",
      full_auto:  "⚡ FULL AUTO — bot apply semua learning sendiri tanpa approval.\n<i>Safety trading gate tetap aktif.</i>",
    }[mode];
    await sendHTML(`🎚️ <b>Autonomy → ${mode.toUpperCase()}</b>\n${desc}\n\n<i>Berlaku mulai cycle berikutnya (config hot-reload).</i>`);
    return;
  }

  // ── /multichain [on|off] — toggle EVM (Base/BSC) via GMGN ──
  if (text === "/multichain" || text.startsWith("/multichain ")) {
    const arg = text.replace(/^\/multichain\s*/, "").trim().toLowerCase();
    const { writeConfig, readConfig: _rc } = await import("./dashboard/config-writer.js");
    if (!arg) {
      const cfg = _rc();
      const isOn = cfg.gmgnExecEnabled === true;
      await sendHTML([
        `🌐 <b>Multi-Chain (EVM) Status: ${isOn ? "🟢 ON" : "🔴 OFF"}</b>`,
        ``,
        `Solana selalu aktif (via Jupiter). Multi-Chain menghidupkan eksekusi Base & BSC via GMGN.`,
        `Ketik: <code>/multichain on</code> atau <code>/multichain off</code>`
      ].join("\n"));
      return;
    }
    if (arg !== "on" && arg !== "off") {
      await sendHTML(`⚠️ Perintah tidak dikenal. Gunakan <code>/multichain on</code> atau <code>/multichain off</code>`);
      return;
    }
    const enable = arg === "on";
    writeConfig({ gmgnExecEnabled: enable });
    
    if (typeof config.gmgn === "object") config.gmgn.execEnabled = enable;
    
    await sendHTML(`🌐 <b>Multi-Chain (EVM) ${enable ? "diaktifkan 🟢" : "dimatikan 🔴"}</b>\n<i>Perubahan langsung aktif.</i>`);
    return;
  }

  // /proposals_on / /proposals_off — toggle proposal approval gate (alias)
  if (text === "/proposals_on" || text === "/proposals_off") {
    const enable = text === "/proposals_on";
    const { writeConfig } = await import("./dashboard/config-writer.js");
    writeConfig({ autonomyMode: enable ? "supervised" : "full_auto", strategyProposalEnabled: enable, vaultProposalEnabled: enable });
    await sendHTML(
      enable
        ? `✅ <b>Proposal Gate ON</b> (autonomy=supervised)\nStrategy & vault proposals akan meminta approve sebelum diapply.`
        : `⚡ <b>Proposal Gate OFF</b> (autonomy=full_auto)\nStrategy & vault proposals akan auto-apply tanpa approve.\n<i>Gunakan hati-hati — perubahan langsung aktif.</i>`
    );
    return;
  }

  // /proposals_status — lihat status proposal gate
  if (text === "/proposals_status") {
    const { readConfig: _readCfg } = await import("./dashboard/config-writer.js");
    const cfg = _readCfg();
    const mode = cfg.autonomyMode || "supervised";
    const stratEnabled = mode !== "full_auto" && cfg.strategyProposalEnabled !== false;
    const vaultEnabled = mode !== "full_auto" && cfg.vaultProposalEnabled !== false;
    await sendHTML([
      `📋 <b>Proposal Gate Status</b>`,
      `Autonomy mode: <b>${mode.toUpperCase()}</b>`,
      `Strategy proposals: ${stratEnabled ? "🟢 ON (butuh approve)" : "⚡ OFF (auto-apply)"}`,
      `Vault proposals: ${vaultEnabled ? "🟢 ON (butuh approve)" : "⚡ OFF (auto-apply)"}`,
      ``,
      `Ganti mode: /autonomy manual|supervised|full_auto`,
    ].join("\n"));
    return;
  }

  // ── Evolved Strategy Approval (sent by StrategyProposal) ──
  // Format: /approve_<uuid> or /reject_<uuid>
  if (text.startsWith("/approve_") && text.length > 9 && !text.startsWith("/approve_automation")) {
    const id = text.slice(9);
    const proposal = _strategyProposal; // module-level via initStrategyEvolution
    if (proposal && typeof proposal.handleOperatorResponse === "function") {
      const handled = proposal.handleOperatorResponse(id, true);
      await sendHTML(handled
        ? `✅ Strategy proposal <code>${id.slice(0, 8)}</code> approved.`
        : `⚠️ Proposal <code>${id.slice(0, 8)}</code> not found or already resolved.`);
    } else {
      await sendHTML("Strategy evolution not enabled — cannot approve.");
    }
    return;
  }
  if (text.startsWith("/reject_") && text.length > 8 && !text.startsWith("/reject_automation")) {
    const id = text.slice(8);
    const proposal = _strategyProposal;
    if (proposal && typeof proposal.handleOperatorResponse === "function") {
      const handled = proposal.handleOperatorResponse(id, false);
      await sendHTML(handled
        ? `❌ Strategy proposal <code>${id.slice(0, 8)}</code> rejected.`
        : `⚠️ Proposal <code>${id.slice(0, 8)}</code> not found or already resolved.`);
    } else {
      await sendHTML("Strategy evolution not enabled — cannot reject.");
    }
    return;
  }

  // ── Automation Commands ──────────────────────────
  if (text === "/approve_automation") {
    // approveAutomation re-checks qualification itself and honors the
    // user-config proForceApprove override — no pre-check here, or the
    // override could never be exercised.
    const result = approveAutomation();
    if (result.ok) {
      await sendHTML(
        `<b>AUTOMATION ACTIVATED${result.forced ? " (FORCED)" : ""}</b>\n`
        + (result.forced ? "⚠️ Qualification gate not met — activated via proForceApprove override.\n" : "")
        + "Full auto strategy selection + BUY/SELL now enabled.\nRevoke: /revoke_automation"
      );
    } else {
      const missing = (result.failedChecks || []).map(f => `• ${htmlEscape(f)}`).join("\n");
      await sendHTML(
        `Cannot activate: ${htmlEscape(result.reason || "not qualified")} (${result.progressPct ?? 0}%)\n`
        + (missing ? missing + "\n" : "")
        + "Override: set <code>proForceApprove: true</code> in user-config.json, restart, then /approve_automation again."
      );
    }
    return;
  }

  if (text === "/reject_automation") {
    rejectAutomation("User rejected via Telegram");
    await sendHTML("Automation proposal rejected. Will re-check qualifications later.");
    return;
  }

  if (text === "/revoke_automation") {
    revokeAutomation("User revoked via Telegram");
    await sendHTML("<b>Automation REVOKED</b>\nBack to manual mode — agent follows user rules only.");
    return;
  }

  if (text === "/automation_status") {
    const state = getAutomationState();
    const qual = checkAutomationQualification();
    await sendHTML(
      `<b>Automation Status</b>\n` +
      `Qualified: ${state.qualified ? "YES" : "NO"} (${qual.progressPct}%)\n` +
      `Proposal: ${state.proposalSent ? "Sent" : "Not sent"}\n` +
      `Approved: ${state.proposalApproved ? "YES" : "NO"}\n` +
      `Active: ${state.automationActive ? "🟢 ON" : "🔴 OFF"}\n` +
      `Requirements: ${qual.passed.length}/${qual.passed.length + qual.failed.length} passed\n` +
      (qual.failed.length > 0 ? `\nMissing:\n${qual.failed.map(f => `- ${f}`).join("\n")}` : "")
    );
    return;
  }

  if (text === "/wallets" || text === "/wallet_tiers") {
    const stats = getWalletTierStats();
    const lines = [
      `<b>Wallet Tiers</b> (${stats.totalWallets} tracked)`,
      ...Object.entries(stats.tiers)
        .filter(([, t]) => t.count > 0)
        .map(([tier, t]) =>
          `  ${TIER_CONFIG?.[tier]?.icon || ""} ${t.label}: ${t.count} wallets | signal: ${t.signalOnBuy}`
        ),
    ];
    await sendHTML(lines.join("\n"));
    return;
  }

  if (text === "/qualification") {
    const qual = checkAutomationQualification();
    await sendHTML(
      `<b>Automation Qualification</b> (${qual.progressPct}%)\n\n` +
      `<b>PASSED (${qual.passed.length}):</b>\n${qual.passed.map(p => `  ${p}`).join("\n")}\n\n` +
      `<b>FAILED (${qual.failed.length}):</b>\n${qual.failed.map(f => `  ${f}`).join("\n")}`
    );
    return;
  }

  // ── /castnet (Tebar Jala) commands ──────────────────────────────────
  // /castnet on      → enable cast-net manual toggle (config flag must also be true)
  // /castnet off     → disable cast-net manual toggle (persistent across restarts)
  // /castnet status  → show current state, cooldown, fires today, last fire
  // /castnet history → show last 10 cast-net fires + outcomes
  if (text === "/castnet" || text.startsWith("/castnet ")) {
    const { getCastNetStatus, setCastNetManualEnabled, getCastNetHistory } = await import("./tools/cast-net-gate.js");
    const arg = text === "/castnet" ? "status" : text.slice("/castnet ".length).trim().toLowerCase();

    if (arg === "on" || arg === "enable") {
      const newState = await setCastNetManualEnabled(true);
      const status = getCastNetStatus();
      await sendHTML(
        `<b>🎣 Cast-Net</b>\n` +
        `Manual toggle: <b>${newState ? "ON" : "OFF"}</b>\n` +
        `Config flag: ${status.config_enabled ? "✓ enabled" : "✗ disabled (set <code>castNetEnabled</code> in user-config.json)"}\n` +
        `Effective: <b>${status.enabled ? "ARMED" : "DISARMED"}</b>`
      );
      return;
    }
    if (arg === "off" || arg === "disable") {
      await setCastNetManualEnabled(false);
      await sendHTML(`<b>🎣 Cast-Net</b>\nManual toggle: <b>OFF</b>\nEffective: <b>DISARMED</b>`);
      return;
    }
    if (arg === "status" || arg === "") {
      const status = getCastNetStatus();
      const lines = [
        `<b>🎣 Cast-Net (Tebar Jala) Status</b>`,
        ``,
        `Effective: <b>${status.enabled ? "ARMED" : "DISARMED"}</b>`,
        `  Config flag: ${status.config_enabled ? "✓" : "✗"}`,
        `  Manual toggle: ${status.manual_enabled === null ? "default" : (status.manual_enabled ? "✓ on" : "✗ off")}`,
        `  Auto-disabled: ${status.auto_disabled ? `✗ YES (${status.consecutive_losses} losses)` : "✓ no"}`,
        ``,
        `<b>Cooldown:</b> ${status.cooldown_remaining_min > 0 ? `${status.cooldown_remaining_min} min remaining` : "ready"}`,
        `<b>Fires today:</b> ${status.fires_today}`,
        `<b>Total fires:</b> ${status.total_fires}`,
        `<b>Consecutive losses:</b> ${status.consecutive_losses}`,
        ``,
        `<b>Config:</b>`,
        `  Max wallets: ${status.config.max_wallets}`,
        `  Max bankroll: ${status.config.max_bankroll_pct}%`,
        `  Min conviction: ${status.config.min_conviction}`,
        `  Cooldown: ${status.config.cooldown_min}min`,
        `  Auto-disable after: ${status.config.auto_disable_consecutive_losses} losses`,
        `  Min liquidity: $${(status.config.min_liquidity_usd || 0).toLocaleString()}`,
        `  Mcap window: $${(status.config.mcap_window_usd?.[0] || 0).toLocaleString()}–$${(status.config.mcap_window_usd?.[1] || 0).toLocaleString()}`,
        `  Volume/liq ratio: ${status.config.min_volume_to_liquidity}`,
        `  Max top1: ${status.config.max_top1_holder_pct}%`,
        `  Strategies: ${(status.config.allowed_strategies || []).join(", ")}`,
      ];
      if (status.last_fire) {
        lines.push(``, `<b>Last fire:</b>`, `  ${status.last_fire.symbol || status.last_fire.mint?.slice(0, 8)} @ ${status.last_fire.wallet_count} wallets / ${status.last_fire.bankroll_pct}% bankroll`, `  ${status.last_fire.ts}`);
      }
      await sendHTML(lines.join("\n"));
      return;
    }
    if (arg === "history") {
      const fires = getCastNetHistory(10);
      if (fires.length === 0) {
        await sendHTML(`<b>🎣 Cast-Net History</b>\n\nBelum ada cast-net fire yang tercatat.`);
        return;
      }
      const fmtOutcome = (f) => {
        if (!f.outcome) return "⏳ open";
        if (f.outcome.win === true)  return `✅ WIN avg ${f.outcome.avg_pnl_pct.toFixed(1)}%`;
        if (f.outcome.win === false) return `❌ LOSS avg ${f.outcome.avg_pnl_pct.toFixed(1)}%`;
        return `◽ neutralized`;
      };
      const rows = fires.map((f, i) => {
        const sym = f.symbol || f.mint?.slice(0, 8) || "?";
        const ts = (f.ts || "").slice(0, 16).replace("T", " ");
        const edge = (f.edge_signals?.length || 0) > 0 ? " ⚠️" : "";
        return `${i + 1}. <b>${sym}</b>${edge} · ${f.wallet_count}w/${f.bankroll_pct}% · ${ts}\n   ${fmtOutcome(f)}`;
      });
      await sendHTML(`<b>🎣 Cast-Net History (last ${fires.length})</b>\n\n${rows.join("\n\n")}`);
      return;
    }
    await sendHTML(`Usage: /castnet on | off | status | history`);
    return;
  }

  // ── /intel — per-position intel layer status ──────────────────────────
  // Shows slow-rug / dev-wallet / volume-divergence evaluation for every
  // open position. Useful when the operator wants to know WHY a position
  // was force-exited or is being watched.
  if (text === "/intel") {
    const positions = (listTrackedPositions ? listTrackedPositions(null, { open_only: true }) : [])
      .filter(p => !p.closed);
    if (positions.length === 0) {
      await sendHTML(`<b>🔍 Intel Layer</b>\n\nTidak ada posisi aktif yang dimonitor.`);
      return;
    }
    const lines = [`<b>🔍 Intel Layer — ${positions.length} posisi aktif</b>`, ``];
    for (const pos of positions) {
      const mint = pos.position || pos.position_key?.split(":")?.[0] || "?";
      const sym  = pos.pool_name || mint.slice(0, 8);
      const slowRug = evaluateSlowRug(mint);
      const devAct  = evaluateDevActivity(mint);
      const volDiv  = evaluateVolumeDivergence(mint);
      const flags = [];
      if (slowRug.triggered) flags.push(`💧 slow-rug:${slowRug.pattern}(${slowRug.severity})`);
      if (devAct.alert && devAct.alert !== "none") flags.push(`🔑 dev:${devAct.alert}(${devAct.severity})`);
      if (volDiv.detected) flags.push(`📉 vol-div:${volDiv.pattern}(${volDiv.severity})`);
      lines.push(`<b>${htmlEscape(sym)}</b>: ${flags.length > 0 ? flags.join(", ") : "✅ bersih"}`);
    }
    await sendHTML(lines.join("\n"));
    return;
  }

  // ── /strategy-perf — per-strategy win/loss stats from learning agent ──
  if (text === "/strategy-perf" || text === "/stratperf") {
    const ranking = getStrategyPerformance();
    if (ranking.length === 0) {
      await sendHTML(`<b>📊 Strategy Performance</b>\n\nBelum ada data. Butuh beberapa trade untuk build statistik.`);
      return;
    }
    const lines = [`<b>📊 Strategy Performance</b>`, ``];
    for (const s of ranking) {
      const wr = (s.win_rate * 100).toFixed(0);
      const rr = (s.rug_rate * 100).toFixed(0);
      const avg = s.avg_pnl_pct >= 0 ? `+${s.avg_pnl_pct}%` : `${s.avg_pnl_pct}%`;
      const bar = s.win_rate >= 0.6 ? "🟢" : s.win_rate >= 0.4 ? "🟡" : "🔴";
      lines.push(`${bar} <b>${s.id}</b> ${avg} | WR ${wr}% rug ${rr}% (${s.traded} trades)`);
    }
    await sendHTML(lines.join("\n"));
    return;
  }

  // ── /learn_wallet <address> — import wallet patterns from GMGN ──
  if (text.startsWith("/learn_wallet ")) {
    const addr = text.slice(14).trim();
    if (!addr || addr.length < 32) {
      await sendHTML("Usage: <code>/learn_wallet &lt;solana_address&gt;</code>\nImports trade patterns from GMGN dan menyimpan ke wallet_history.json");
      return;
    }
    await sendHTML(`⏳ Fetching wallet <code>${addr.slice(0, 8)}...</code> dari GMGN...`);
    try {
      const result = await importWalletInsight(addr);
      if (!result.added) {
        await sendHTML(`⚠️ Wallet tidak ditambahkan: ${result.reason}`);
      } else {
        const p = result.patterns;
        await sendHTML(
          `✅ <b>Wallet dipelajari</b>\n` +
          `Address: <code>${result.address.slice(0, 12)}...</code>\n` +
          `Win rate: ${(result.win_rate * 100).toFixed(0)}%\n` +
          `Entry mcap median: $${p.entry_mcap_median?.toFixed(0) ?? "N/A"}\n` +
          `Avg hold: ${p.avg_hold_hours?.toFixed(1) ?? "N/A"} jam\n` +
          `Avg gain: ${p.avg_gain_multiple?.toFixed(1) ?? "N/A"}x\n` +
          `Trades menang: ${p.win_count}`
        );
      }
    } catch (e) {
      await sendHTML(`❌ Error: ${e.message}`);
    }
    return;
  }

  // ── /wallet_patterns — show loaded wallet patterns ──
  if (text === "/wallet_patterns" || text === "/walletpatterns") {
    try {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      const HIST = new URL("./wallet_history.json", import.meta.url).pathname;
      if (!existsSync(HIST)) {
        await sendHTML("Belum ada wallet patterns. Gunakan <code>/learn_wallet &lt;address&gt;</code> untuk mulai.");
        return;
      }
      const db = JSON.parse(await readFile(HIST, "utf8"));
      if (!db.wallets?.length) {
        await sendHTML("wallet_history.json kosong. Gunakan <code>/learn_wallet &lt;address&gt;</code>.");
        return;
      }
      const lines = [`<b>🧠 Wallet Patterns (${db.wallets.length} wallets)</b>`, ``];
      for (const w of db.wallets.slice(0, 10)) {
        const p = w.patterns || {};
        lines.push(
          `<b>${w.address.slice(0, 8)}...</b> [${w.source}]\n` +
          `  WR: ${w.win_rate != null ? (w.win_rate * 100).toFixed(0) + "%" : "?"} | ` +
          `Entry mcap: $${p.entry_mcap_p25?.toFixed(0) ?? "?"}–$${p.entry_mcap_p75?.toFixed(0) ?? "?"} | ` +
          `Hold: ${p.avg_hold_hours?.toFixed(1) ?? "?"}h | ` +
          `Gain: ${p.avg_gain_multiple?.toFixed(1) ?? "?"}x`
        );
      }
      await sendHTML(lines.join("\n"));
    } catch (e) {
      await sendHTML(`❌ Error membaca wallet patterns: ${e.message}`);
    }
    return;
  }

  if (text.startsWith("/")) {
    const handled = await handleStrategyTelegramCommand(text).catch(e => {
      sendHTML(`❌ Command error: ${e.message}`).catch(() => {});
      return true;
    });
    if (handled) return;
  }

  // ── Route free text through General Agent ─────────────────────────────────
  if (busy) return;
  busy = true;
  let liveMsg = null;
  try {
    liveMsg = await createLiveMessage("🤖 Ponyou", "Memproses…");

    const response = await handleGeneralMessage(text);
    const clean = llmToTelegramHtml(response) || "";

    if (liveMsg) await liveMsg.finalize(clean);
    else await sendHTML(clean);
  } catch (e) {
    const errLine = `❌ <b>Error</b>\n<code>${htmlEscape(e.message)}</code>`;
    if (liveMsg) await liveMsg.finalize(errLine);
    else await sendHTML(errLine);
  } finally {
    busy = false;
    refreshPrompt();
  }
}

async function ensureTelegramAutomationSurface() {
  // Bot API — selalu aktif untuk kirim notifikasi & terima perintah dari user owner
  if (telegramEnabled()) {
    startPolling(handleIncomingTelegramMessage);
    registerBotCommands().catch(() => {}); // register slash commands in Telegram UI
  }

  // User Client (MTProto) — untuk monitor channel/grup sinyal tanpa bot di-invite
  if (isUserClientEnabled()) {
    const ok = await startUserClient({ onMessage: handleSignalChannelMessage });
    if (ok) {
      log("startup", "Telegram user client connected — monitoring signal channels via MTProto");
    } else {
      log("startup", "Telegram user client failed to connect — run: npm run telegram:auth");
    }
  }
  // Consolidated optional-features summary
  const optional = {
    geyser:        !!(process.env.HELIUS_ATLAS_WS_URL || process.env.HELIUS_GEYSER_URL),
    discord:       !!process.env.DISCORD_BOT_TOKEN,
    tg_user:       isUserClientEnabled(),
    reddit:        !!process.env.REDDIT_USER_AGENT,
    jupiter_paid:  !!process.env.JUPITER_API_KEY,
  };
  const on  = Object.entries(optional).filter(([, v]) => v).map(([k]) => k).join(", ") || "none";
  const off = Object.entries(optional).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none";
  log("startup", `Optional features — ON: [${on}] | OFF: [${off}]`);
}

syncAutomationBootState();
ensureTelegramAutomationSurface();
_automationCommandTimer = setInterval(processAutomationCommand, 2000);

registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

console.log(`
============================================================
🌐 PONYOU DASHBOARD TUTORIAL
Untuk menyalakan/mengaktifkan fitur Web Monitor (Dashboard):
1. Ketik "/web on" di Telegram Bot Anda
2. Atau jalankan: pm2 start ponyou-dashboard di terminal ini

Untuk mematikannya (menghemat VPS):
1. Ketik "/web off" di Telegram Bot Anda
2. Atau jalankan: pm2 stop ponyou-dashboard
============================================================
`);
