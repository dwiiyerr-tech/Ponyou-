import { getSolanaGasFee } from "./solana-rpc.js";
import {
  discoverTokens,
  getTokenSecurityDetails,
  getSmartMoneyRank,
  getSmartMoneyInflow,
  getTrendingNarratives,
  getTokenKlines,
} from "./dexscreener.js";
import { swapToken as executeJupiterSwap } from "./jupiter.js";
import { getWalletBalances } from "./wallet.js";
import { scanRefundableTokenAccounts, closeRefundableTokenAccounts } from "../rent-refund.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, recordRug, scoreRugRisk, getRugMemorySummary } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition, flushState } from "../state.js";
import { getPlanSummary, initTradingPlan, pauseSession, advanceDay, checkSessionGate, isInProfitMode, getDynamicPositionLimit } from "../trading-plan.js";
import { getMarketIntelligence, getMarketTrend } from "../market-intelligence.js";
import { getLearningModeStatus, getLearningStatusSummary, getLearningHistory, activateLearningMode } from "../learning-mode.js";
import { getVaultStatus, isVaultDue, computeVaultAmount } from "../vault.js";
import { generateDailyReport, formatReportTelegram, getReportStatus } from "../daily-report.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets } from "../smart-wallets.js";
import { discoverSmartWallets, listDiscoveredWallets } from "./wallet-discovery.js";
import { analyzeDexVisibilityRisk } from "./dex-visibility-risk-analyzer.js";
import { analyzeThreeCandleConfirmation } from "./three-candle-confirmation-strategy.js";
import { analyzeCabalPlay } from "./cabal-play-analyzer.js";
import { processWalletPing } from "./wallet-ping-agent.js";
import { analyzeDayPhase } from "./day-phase-analyzer.js";
import { learnPatterns, listPatterns } from "./rug-patterns.js";
import { clearSignalCache } from "./rug-signals.js";
import { harvestMarketRugs } from "./rug-harvester.js";
import { classifyNarrative, getNarrativeHeat, recordNarrativeOutcome } from "./narratives.js";
import { resolveTicker, listTickers, registerTicker } from "./ticker-registry.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import { rankWalletExecutionCandidates, recordExecutionQuality } from "../execution-quality-memory.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, sendHTML, isEnabled as telegramEnabled } from "../telegram.js";
import { createPendingIntent } from "../intents.js";
import { getStrategy } from "../strategies.js";
import { getActiveWallet, markWalletError, buildAdaptiveTradeWalletPlan, getWalletByAddress, isMultiWalletEnabled } from "./wallet-manager.js";
import { listTrackedPositions } from "../state.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
    "pilotEnabled",
    "autoAdaptToMarket",
    "dailyReportEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

async function adaptiveSwap(args = {}) {
  const tokenIn = args.token_in;
  const tokenOut = args.token_out;
  const amount = Number(args.amount || 0);
  const marketCondition = getMarketIntelligence().condition;
  if (args.wallet_address || !isMultiWalletEnabled() || !(amount > 0)) {
    return executeJupiterSwap(args);
  }

  if (tokenIn === "SOL" && tokenOut && tokenOut !== "SOL") {
    const existing = listTrackedPositions(tokenOut, { open_only: true });
    const mode = existing.length > 0 ? "dca" : "entry";
    const plan = buildAdaptiveTradeWalletPlan(tokenOut, amount, mode);
    if (plan.selected_wallets.length === 0) return { success: false, error: "No eligible wallet found for adaptive swap" };
    const rankedWallets = rankWalletExecutionCandidates(plan.selected_wallets, {
      mode,
      split: plan.split,
      marketCondition,
      provider: "auto",
      slippage: Number(args.slippage || 0),
    });

    if (plan.split && rankedWallets.length > 1) {
      const executions = [];
      for (const slot of rankedWallets) {
        const result = await executeJupiterSwap({
          ...args,
          amount: slot.amount_sol,
          wallet_address: slot.address,
          wallet: getWalletByAddress(slot.address)?.keypair || null,
        });
        executions.push({ wallet_address: slot.address, amount: slot.amount_sol, ...result });
        if (!(result.success || result.dry_run)) {
          return { success: false, error: result.error || "split execution failed", executions, token_in: tokenIn, token_out: tokenOut };
        }
      }
      return {
        success: true,
        split_execution: true,
        token_in: tokenIn,
        token_out: tokenOut,
        amount,
        executions,
        wallet_address: executions[0]?.wallet_address || null,
      };
    }

    const slot = rankedWallets[0];
    return executeJupiterSwap({
      ...args,
      wallet_address: slot.address,
      wallet: getWalletByAddress(slot.address)?.keypair || null,
    });
  }

  if (tokenOut === "SOL" && tokenIn && tokenIn !== "SOL") {
    const plan = buildAdaptiveTradeWalletPlan(tokenIn, amount, "sell");
    const rankedWallets = rankWalletExecutionCandidates(plan.selected_wallets, {
      mode: "sell",
      split: false,
      marketCondition,
      provider: "auto",
      slippage: Number(args.slippage || 0),
    });
    const slot = rankedWallets[0];
    if (!slot) return { success: false, error: `No wallet with open position for ${tokenIn}` };
    return executeJupiterSwap({
      ...args,
      wallet_address: slot.address,
      wallet: getWalletByAddress(slot.address)?.keypair || null,
    });
  }

  return executeJupiterSwap(args);
}

// Map tool names to implementations
const toolMap = {
  get_solana_gas_fee: getSolanaGasFee,
  discover_tokens: discoverTokens,
  get_token_security_details: getTokenSecurityDetails,
  swap_token: adaptiveSwap,
  jupiter_swap: adaptiveSwap,
  get_smart_money_rank: getSmartMoneyRank,
  get_smart_money_inflow: getSmartMoneyInflow,
  get_trending_narratives: getTrendingNarratives,
  get_token_klines: getTokenKlines,
  get_wallet_balance: getWalletBalances,
  scan_rent_refunds: scanRefundableTokenAccounts,
  claim_rent_refunds: closeRefundableTokenAccounts,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  discover_smart_wallets: discoverSmartWallets,
  list_discovered_wallets: listDiscoveredWallets,
  analyze_dex_visibility_risk: analyzeDexVisibilityRisk,
  analyze_three_candle_confirmation: analyzeThreeCandleConfirmation,
  analyze_cabal_play: analyzeCabalPlay,
  process_wallet_ping: processWalletPing,
  analyze_day_phase: analyzeDayPhase,
  learn_rug_patterns: learnPatterns,
  list_rug_patterns: listPatterns,
  clear_rug_signal_cache: () => { clearSignalCache(); return { cleared: true }; },
  harvest_market_rugs: harvestMarketRugs,
  classify_narrative: ({ symbol, name, description } = {}) => ({ tags: classifyNarrative({ symbol, name, description }) }),
  get_narrative_heat: getNarrativeHeat,
  resolve_ticker: resolveTicker,
  list_tickers: listTickers,
  register_ticker: registerTicker,
  // ─── Trading Plan Tools ──────────────────────────────────
  get_plan_summary: () => ({ plan: getPlanSummary(), gate: checkSessionGate() }),
  init_trading_plan: ({ initialCapitalUsd, dailyTargetPct, dailyStopLossPct, sessionPauseDurationMin, days } = {}) => {
    const plan = initTradingPlan({ initialCapitalUsd, dailyTargetPct, dailyStopLossPct, sessionPauseDurationMin, days });
    return { success: true, plan: getPlanSummary() };
  },
  pause_session: ({ reason, durationMin } = {}) => {
    const ok = pauseSession(reason || "MANUAL", durationMin || null);
    return { paused: ok, gate: checkSessionGate() };
  },
  advance_day: ({ actualCapitalUsd } = {}) => {
    const result = advanceDay(actualCapitalUsd || 0);
    return { result, next_plan: getPlanSummary() };
  },
  // ─── Market Intelligence Tools ───────────────────────────
  get_market_intelligence: () => getMarketIntelligence(),
  get_market_trend: () => getMarketTrend(),
  // ─── Learning Mode Tools ─────────────────────────────────
  get_learning_status: () => ({
    status: getLearningModeStatus(),
    summary: getLearningStatusSummary(),
    history: getLearningHistory({ limit: 5 }),
  }),
  // ─── Vault Tools ─────────────────────────────────────────
  get_vault_status: () => ({
    vault: getVaultStatus(),
    due: isVaultDue(),
  }),
  // ─── Daily Report Tools ──────────────────────────────────
  generate_report: () => {
    const { report, text, filePath } = generateDailyReport();
    return { report, text_preview: text.slice(0, 800), saved_to: filePath };
  },
  get_report_status: () => getReportStatus(),
  // ─── Rug Memory Tools ────────────────────────────────────
  report_rug: ({ mint, symbol, creator, launchpad, rug_signals, pattern_notes } = {}) => {
    recordRug({ mint, symbol, creator, launchpad, rug_signals, pattern_notes });
    return { recorded: true, rug_memory: getRugMemorySummary() };
  },
  score_rug_risk: ({ mint, creator, launchpad, rug_signals } = {}) =>
    scoreRugRisk({ mint, creator, launchpad, rug_signals: rug_signals || {} }),
  get_rug_memory_summary: () => getRugMemorySummary(),
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      setTimeout(async () => {
        try { await flushState(); } catch (_) {}
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    const CONFIG_MAP = {
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // Pilot / Trading Plan
      pilotEnabled: ["pilot", "enabled"],
      pilotCapitalUsd: ["pilot", "initialCapitalUsd"],
      dailyTargetPct: ["pilot", "dailyTargetPct"],
      dailyStopLossPct: ["pilot", "dailyStopLossPct"],
      sessionPauseDurationMin: ["pilot", "sessionPauseDurationMin"],
      learningModeDurationMin: ["pilot", "learningModeDurationMin"],
      planDays: ["pilot", "planDays"],
      autoAdaptToMarket: ["pilot", "autoAdaptToMarket"],
      // Vault
      vaultPct: ["vault", "pct"],
      vaultIntervalDays: ["vault", "intervalDays"],
      // Daily Report
      dailyReportEnabled: ["report", "enabled"],
      dailyReportHourUtc: ["report", "hourUtc"],
      dailyReportMinuteUtc: ["report", "minuteUtc"],
      temperature: ["llm", "temperature"],
    };

    const applied = {};
    const unknown = [];
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        applied[match[0]] = normalizeConfigValue(match[0], val);
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) return { success: false, unknown, reason };

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      config[section][field] = val;
    }

    Object.assign(userConfig, applied);
    atomicWriteJson(USER_CONFIG_PATH, userConfig);

    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) _cronRestarter();

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

const SWAP_TOOL_NAMES = new Set(["swap_token", "jupiter_swap"]);
function isSwapTool(name) { return SWAP_TOOL_NAMES.has(name); }

const WRITE_TOOLS = new Set(SWAP_TOOL_NAMES);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const TOOL_TIMEOUT_MS = 90_000; // 90s per tool — longer than LLM timeout to allow swap confirmations

function withToolTimeout(promise, toolName) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
    ),
  ]);
}

export async function executeTool(name, args) {
  const startTime = Date.now();
  name = name.replace(/<.*$/, "").trim();

  const fn = toolMap[name];
  if (!fn) return { error: `Unknown tool: ${name}` };

  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) return { blocked: true, reason: safetyCheck.reason };
  }

  // Confirm-mode intercept: park BUYs as pending intents instead of executing.
  if (isSwapTool(name)) {
    const parked = await maybeParkAsConfirmIntent(args);
    if (parked) {
      logAction({ tool: name, args, result: parked, duration_ms: Date.now() - startTime, success: true });
      return parked;
    }
  }

  // Inject active wallet keypair so Jupiter/Jito use the correct signing key
  let callArgs = args;
  if (isSwapTool(name)) {
    const activeWallet = getActiveWallet();
    if (activeWallet?.keypair) callArgs = { ...args, wallet: activeWallet.keypair };
  }

  try {
    const result = await withToolTimeout(fn(callArgs), name);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (isSwapTool(name) && !success) {
      const activeWallet = getActiveWallet();
      if (activeWallet?.address) markWalletError(activeWallet.address);
    }

    if (isSwapTool(name)) {
      await recordExecutionQuality({
        walletAddress: result?.wallet_address || args.wallet_address || getActiveWallet()?.address || null,
        provider: result?.execution_provider || "auto",
        mode: args.token_in === "SOL" ? "buy" : (args.token_out === "SOL" ? "sell" : "swap"),
        split: !!result?.split_execution,
        marketCondition: getMarketIntelligence().condition,
        slippage: Number(args.slippage || result?.slippage || 0),
        success,
        latencyMs: duration,
      });
    }

    if (success && isSwapTool(name)) {
      notifySwap({
        inputSymbol: args.token_in === "SOL" ? "SOL" : args.token_in?.slice(0, 8),
        outputSymbol: args.token_out === "SOL" ? "SOL" : args.token_out?.slice(0, 8),
        amountIn: args.amount,
        amountOut: result.amount_out,
        tx: result.hash
      }).catch(() => {});
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logAction({ tool: name, args, error: error.message, duration_ms: duration, success: false });
    if (isSwapTool(name)) {
      const activeWallet = getActiveWallet();
      if (activeWallet?.address) markWalletError(activeWallet.address);
      await recordExecutionQuality({
        walletAddress: args.wallet_address || activeWallet?.address || null,
        provider: "auto",
        mode: args.token_in === "SOL" ? "buy" : (args.token_out === "SOL" ? "sell" : "swap"),
        split: false,
        marketCondition: getMarketIntelligence().condition,
        slippage: Number(args.slippage || 0),
        success: false,
        latencyMs: duration,
      });
    }
    return { error: error.message, tool: name };
  }
}

/**
 * If confirm mode is on AND this is a real BUY (SOL → token in non-dry-run),
 * park the swap as a pending intent and notify Telegram. Returns the parked
 * result object (LLM should treat as a non-success terminal state) or null
 * if the swap should proceed normally.
 */
async function maybeParkAsConfirmIntent(args) {
  if (!config.trading?.confirmMode) return null;
  if (process.env.DRY_RUN === "true") return null;
  if (args?.token_in !== "SOL") return null;
  if (!args?.token_out || args.token_out === "SOL") return null;

  const strat = getStrategy();
  const intent = createPendingIntent({
    type: "buy",
    args,
    meta: { strategy_id: strat.id, requested_at: new Date().toISOString() },
    ttl_min: config.trading.confirmTtlMin ?? 5,
  });

  const ttl = config.trading.confirmTtlMin ?? 5;
  const msg = [
    `🟡 <b>Pending BUY</b> · #${intent.id}`,
    `${args.amount} SOL → <code>${String(args.token_out).slice(0, 12)}…</code>`,
    `Strategy: ${strat.id} · expires ${ttl}m`,
    ``,
    `<code>/yes ${intent.id}</code>  ·  <code>/no ${intent.id}</code>`,
  ].join("\n");

  if (telegramEnabled()) sendHTML(msg).catch(() => {});

  return {
    pending: true,
    intent_id: intent.id,
    expires_at: intent.expires_at,
    message: `BUY parked as intent #${intent.id} — awaiting Telegram /yes approval. Do NOT retry.`,
  };
}

async function runSafetyChecks(name, args) {
  switch (name) {
    case "swap_token":
    case "jupiter_swap": {
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const amount = args.amount || 0;
        if (args.token_in === "SOL" && balance.sol < amount + gasReserve) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${amount + gasReserve} SOL.`,
          };
        }
      }
      return { pass: true };
    }
    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") return { pass: false, reason: "self_update is disabled." };
      return { pass: true };
    }
    default:
      return { pass: true };
  }
}

function summarizeResult(result) {
  if (result == null) return result;
  const str = JSON.stringify(result);
  if (str == null) return null;
  return str.length > 1000 ? str.slice(0, 1000) + "..." : result;
}
