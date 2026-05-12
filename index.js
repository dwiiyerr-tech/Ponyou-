import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getWalletBalances } from "./tools/wallet.js";
import { discoverTokens, getSolanaGasFee, swapToken as gmgnSwap, getTokenSecurityDetails, getTokenKlines } from "./tools/gmgn.js";
import { config, computeDeployAmount } from "./config.js";
import { getPerformanceSummary, recordTradeOutcome, getPerformanceHistory } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled, createLiveMessage, formatPnLTable, sendHTML } from "./telegram.js";
import { strategy, checkROI, checkTrailingStop, run4FilterProtocol, getMcapTier } from "./strategy.js";
import { trackPosition, recordClose, getTrackedPosition, getStateSummary, syncOpenPositions } from "./state.js";
import { calculateRSI, calculateSuperTrend } from "./utils/indicators.js";

import {
  getTradingPlan, initTradingPlan, checkSessionGate,
  updateSessionCapital, getPlanSummary, recordTrade,
  advanceDay, isInProfitMode, getDynamicPositionLimit,
} from "./trading-plan.js";
import {
  recordMarketSnapshot, getMarketIntelligence,
  getRecommendedAdjustments,
} from "./market-intelligence.js";
import {
  scoreRugRisk, isDevBlocked, isTokenBlacklisted, recordRug,
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
  isVaultDue, computeVaultAmount, executeVaultTransfer,
  recordVaultTransfer, getVaultStatus, buildVaultNotification,
} from "./vault.js";
import {
  generateDailyReport, formatReportTelegram, wasTodayReported,
} from "./daily-report.js";
import { getTokenInfo } from "./tools/token.js";

log("startup", "Ponyou AI Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "minimax/minimax-m2.7"}`);

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

let _cronTasks = [];
let _managementBusy = false;
let _screeningBusy = false;

function stripThink(t) {
  return t ? t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : t;
}

// ─── Gate Checks ──────────────────────────────────────────────

/**
 * Cek semua gate sebelum entry/management.
 * Returns { blocked: boolean, reason: string }
 */
async function checkAllGates(source = "") {
  // 1. Session pause (target hit)
  if (config.pilot.enabled) {
    const gate = checkSessionGate();
    if (gate.just_resumed) {
      log("plan", `Session resumed — ${source}`);
      if (telegramEnabled()) sendMessage(`▶️ Sesi dilanjutkan.\nDay ${getPlanSummary()?.day}/${getPlanSummary()?.days_total}`);
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
    if (telegramEnabled()) sendMessage(`▶️ Learning mode selesai — trading dilanjutkan`);
  }
  if (learn.active) {
    // Jalankan analisis LLM sekali jika belum
    if (shouldRunAnalysis()) {
      runLossAnalysis().catch(e => log("learning_error", e.message));
    }
    return { blocked: true, reason: `LEARNING_MODE: resume in ${learn.resume_in_min}min` };
  }

  return { blocked: false };
}

/**
 * Update session P&L dan handle trigger.
 */
async function refreshSessionPnl(totalUsd) {
  if (!config.pilot.enabled) return;
  const result = updateSessionCapital(totalUsd);

  if (result.action === "pause_target") {
    const plan = getPlanSummary();
    const msg = [
      `🎯 TARGET HARIAN TERCAPAI!`,
      `+${result.pnl_pct.toFixed(2)}% (+$${result.pnl_usd?.toFixed(4)})`,
      `Agent dijeda ${config.pilot.sessionPauseDurationMin}min untuk istirahat.`,
      `Day ${plan?.day}/${plan?.days_total}`,
      `Profit mode: aktif saat resume 🔥`,
    ].join("\n");
    log("plan", msg);
    if (telegramEnabled()) sendMessage(msg);
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
      const msg = [
        `🧠 LEARNING MODE AKTIF`,
        `Daily stop-loss tercapai: ${result.pnl_pct.toFixed(2)}%`,
        `Ponyou akan menganalisis kenapa rugi dan belajar.`,
        `Jeda ${config.pilot.learningModeDurationMin} menit — tidak ada entry baru.`,
      ].join("\n");
      log("plan", msg);
      if (telegramEnabled()) sendMessage(msg);
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

  const recentTrades = getPerformanceSummary ? [] : [];
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

    const msg = [
      `🧠 ANALISIS LOSS SELESAI`,
      `Trigger: ${lossContext.exit_reason || "?"}`,
      `P&L: ${lossContext.pnl_pct?.toFixed(2) || "?"}%`,
      `${result.lessons_added} pelajaran baru ditambahkan`,
      `─────────────────────`,
      stripThink(content)?.slice(0, 500),
    ].join("\n");

    log("learning", `Analisis selesai. ${result.lessons_added} lessons ditambahkan.`);
    if (telegramEnabled()) sendMessage(msg);
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
    const result = recordLossAnalysis({ // Reuse recordLossAnalysis for simplicity
      lossContext: tradeContext,
      analysisText: stripThink(content),
      marketCondition: marketCond,
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

  const prompt = buildObservationAnalysisPrompt(results);
  if (!prompt) return;

  try {
    const { content } = await agentLoop(prompt, 5, [], "GENERAL", config.llm.generalModel, 1024);
    const result = recordLossAnalysis({
      lossContext: { exit_reason: "OBSERVATION" },
      analysisText: stripThink(content),
      marketCondition: getMarketIntelligence().condition,
    });
    
    if (telegramEnabled() && result.lessons_added > 0) {
      sendMessage(`🧠 CONTINUOUS LEARNING\n${result.lessons_added} pelajaran baru dari observasi market.\n\n${stripThink(content).slice(0, 400)}`);
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
      if (!silent && telegramEnabled()) sendMessage(msg);
    } else {
      log("vault_error", `Vault gagal: ${result.error}`);
      if (!silent && telegramEnabled()) sendMessage(`❌ Vault gagal: ${result.error}`);
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
    if (!silent && telegramEnabled()) await sendMessage(text);
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
  // Stop-loss atau loss > 10%
  if (pnl_pct > -10 && exit_reason !== "Stop Loss") return;

  const lossContext = {
    symbol, mint, pnl_pct, entry_usd, exit_usd,
    hold_minutes, exit_reason, rug_signals, launchpad, market_condition,
  };

  const activated = activateLearningMode(lossContext, "STOP_LOSS", config.pilot.learningModeDurationMin);
  if (activated) {
    log("learning", `Learning mode: ${symbol} loss ${pnl_pct?.toFixed(2)}%`);
    const msg = [
      `🧠 LEARNING MODE — TRADE LOSS`,
      `Token: ${symbol} (${mint?.slice(0, 10) || "?"})`,
      `P&L: ${pnl_pct?.toFixed(2)}% | Hold: ${Math.floor(hold_minutes || 0)}min`,
      `Alasan: ${exit_reason}`,
      `Ponyou menganalisis dan belajar selama ${config.pilot.learningModeDurationMin}min...`,
    ].join("\n");
    if (telegramEnabled()) sendMessage(msg).catch(() => {});
  }
}

// ─── Deterministic Exits ──────────────────────────────────────

async function checkDeterministicExits(tokens) {
  const exits = [];
  const market = getMarketIntelligence();
  const condition = market.condition || "NORMAL";

  for (const token of tokens) {
    const tracked = getTrackedPosition(token.mint);
    if (!tracked) continue;

    const ageMinutes = (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000;
    const currentPnlPct = tracked.initial_value_usd > 0
      ? ((token.usd - tracked.initial_value_usd) / tracked.initial_value_usd) * 100
      : 0;

    if (currentPnlPct > (tracked.peak_pnl_pct || 0)) tracked.peak_pnl_pct = currentPnlPct;

    if (currentPnlPct / 100 <= strategy.stoploss) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: `Stop Loss: ${currentPnlPct.toFixed(2)}%`, pnl_pct: currentPnlPct, is_loss: true });
      continue;
    }
    const roiCheck = checkROI(ageMinutes, currentPnlPct, condition);
    if (roiCheck.exit) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: roiCheck.reason, pnl_pct: currentPnlPct, is_loss: currentPnlPct < 0 });
      continue;
    }
    const tsCheck = checkTrailingStop(currentPnlPct, tracked.peak_pnl_pct || 0);
    if (tsCheck.exit) {
      exits.push({ mint: token.mint, symbol: token.symbol, reason: tsCheck.reason, pnl_pct: currentPnlPct, is_loss: false });
    }
  }
  return exits;
}

// ─── Management Cycle ─────────────────────────────────────────

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;

  const gate = await checkAllGates("management");
  if (gate.blocked) return gate.reason;

  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let liveMessage = null;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management", "Evaluating positions...");
    }

    const balance = await getWalletBalances();
    const tokens = (balance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    // Refresh session P&L
    const totalUsd = (balance.sol_usd || 0) + tokens.reduce((s, t) => s + (t.usd || 0), 0);
    await refreshSessionPnl(totalUsd);

    syncOpenPositions(tokens.map(t => t.mint));

    if (tokens.length === 0) {
      mgmtReport = "No open token positions.";
      return mgmtReport;
    }

    // ─── Step 1: Deterministic exits ─────────────
    const deterministicExits = await checkDeterministicExits(tokens);
    for (const exit of deterministicExits) {
      log("strategy", `EXIT: ${exit.symbol} — ${exit.reason}`);
      const tokenData = tokens.find(t => t.mint === exit.mint);
      const res = await gmgnSwap({
        token_in: exit.mint, token_out: "SOL",
        amount: tokenData?.balance, slippage: 1.0,
      });
      if (res.success || res.dry_run) {
        recordClose(exit.mint, exit.reason);
        recordTrade(!exit.is_loss);

        // Record performance
        const tracked = getTrackedPosition(exit.mint);
        recordTradeOutcome({
          mint: exit.mint,
          symbol: exit.symbol,
          entry_usd: tracked?.initial_value_usd,
          exit_usd: tokenData?.usd,
          pnl_pct: exit.pnl_pct,
          hold_minutes: tracked ? (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000 : 0,
          exit_reason: exit.reason,
          rug_detected: exit.reason.includes("Rug"),
        });

        // Trigger learning mode jika loss
        if (config.pilot.enabled && exit.is_loss) {
          handleTradeLoss({
            symbol: exit.symbol, mint: exit.mint,
            pnl_pct: exit.pnl_pct,
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
            pnl_pct: exit.pnl_pct,
            hold_minutes: tracked ? (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000 : 0,
            exit_reason: exit.reason,
          }).catch(e => log("learning_error", e.message));
        }

        if (telegramEnabled()) {
          sendMessage(`${exit.is_loss ? "🛑" : "🎯"} Exit: ${exit.symbol}\n${exit.reason}\nP&L: ${exit.pnl_pct?.toFixed(2)}%`);
        }
      }
    }

    // ─── Step 2: LLM management ──────────────────
    const remainingBalance = await getWalletBalances();
    const remainingTokens = (remainingBalance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    if (remainingTokens.length > 0) {
      const planSummary = getPlanSummary();
      const { content } = await agentLoop(`
MANAGEMENT CYCLE
Tokens held: ${JSON.stringify(remainingTokens)}
${planSummary ? `Plan: Day ${planSummary.day} | P&L: ${planSummary.today_pnl_pct}% | Profit Mode: ${planSummary.profit_mode}` : ""}

Review holdings. Exit jika ada rug signal atau trend reversal berat.
ROI/Trailing/StopLoss ditangani otomatis — fokus ke kualiatif saja.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result }) => {
          await liveMessage?.toolFinish(name, result, !result?.error);
          if (name === "gmgn_swap" && (result.success || result.dry_run)) {
            const tokenOut = result.token_out || result.would_swap?.token_out;
            const tokenIn = result.token_in || result.would_swap?.token_in;
            if (tokenOut === "SOL" || tokenOut === "So11111111111111111111111111111111111111112") {
              recordClose(tokenIn, "LLM Manager Decision");
              recordTrade(true); // assume LLM exits for profit
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
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled() && mgmtReport) {
      if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport));
      else sendMessage(`🔄 Mgmt\n${stripThink(mgmtReport)}`);
    }
  }
  return mgmtReport;
}

// ─── Screening Cycle ──────────────────────────────────────────

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) return null;

  const gate = await checkAllGates("screening");
  if (gate.blocked) return gate.reason;

  _screeningBusy = true;
  timers.screeningLastRun = Date.now();
  log("cron", "Starting screening cycle");
  let screenReport = null;
  let liveMessage = null;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔍 Screening", "Scanning alpha...");
    }

    const balance = await getWalletBalances();
    const openTokens = (balance.tokens || []).filter(t => t.usd >= 0.1 && t.symbol !== "SOL");

    // ─── Profit-aware position limit ──────────────
    const positionLimit = config.pilot.enabled
      ? getDynamicPositionLimit(strategy.protections.max_open_trades)
      : strategy.protections.max_open_trades;

    if (openTokens.length >= positionLimit) {
      const profitMode = isInProfitMode();
      log("protection", `Max positions: ${openTokens.length}/${positionLimit}${profitMode ? " (profit mode)" : ""}`);
      _screeningBusy = false;
      return `Max positions reached (${openTokens.length}/${positionLimit})`;
    }

    const deployAmount = computeDeployAmount(balance.sol);
    const gasFee = await getSolanaGasFee();
    const discovery = await discoverTokens({ timeframe: "1m" });
    const candidates = discovery.tokens || [];

    // ─── Market intelligence ─────────────────────
    const marketSnap = recordMarketSnapshot(candidates);
    const marketIntel = getMarketIntelligence();
    log("market", `Market: ${marketIntel.condition} (confidence: ${marketSnap.confidence})`);

    if (marketIntel.condition === "DEAD") {
      _screeningBusy = false;
      return "Market DEAD — skip entries";
    }

    // Auto market adaptation
    if (config.pilot.autoAdaptToMarket) {
      const adj = getRecommendedAdjustments(marketIntel.condition);
      if (!adj.skip_entry) {
        const safeFields = ["minHolders","minMcap","maxMcap","minVolume","maxBundlePct","maxTop10Pct","minTokenFeesSol","maxBotHoldersPct"];
        for (const f of safeFields) {
          if (adj[f] != null) config.screening[f] = adj[f];
        }
      }
    }

    // ─── Filter + Rug Memory ─────────────────────
    const scoredCandidates = [];
    for (const token of candidates.slice(0, 8)) {
      if (isTokenBlacklisted(token.mint)) continue;
      if (token.creator && isDevBlocked(token.creator)) continue;

      const security = await getTokenSecurityDetails({ mint: token.mint });
      const rugRisk = scoreRugRisk({
        mint: token.mint,
        creator: token.creator || security?.security?.creator,
        launchpad: token.launchpad,
        rug_signals: security?.rug_signals || {},
      });

      if (rugRisk.score >= 60) {
        log("filter", `${token.symbol}: SKIP rug score ${rugRisk.score}`);
        continue;
      }

      // Fetch global fees for wash trading detection
      const tokenInfo = await getTokenInfo({ query: token.mint });
      const globalFees = tokenInfo.results?.[0]?.global_fees_sol || 0;
      const tierInfo = getMcapTier(token.mcap);
      const enhancedToken = { ...token, global_fees_sol: globalFees, tier: tierInfo };

      const filterResult = await run4FilterProtocol(enhancedToken, security, gasFee);
      
      // ─── Technical Indicators (Optional) ────────
      let technicals = null;
      if (config.indicators.enabled) {
        log("screening", `${token.symbol}: Fetching klines for indicators...`);
        const klineData = await getTokenKlines({ 
          mint: token.mint, 
          resolution: config.indicators.intervals[0] === "5_MINUTE" ? "5m" : "1m",
          limit: config.indicators.candles || 100
        });
        
        if (klineData.candles && klineData.candles.length > 5) {
          const closes = klineData.candles.map(c => c.close);
          const highs = klineData.candles.map(c => c.high);
          const lows = klineData.candles.map(c => c.low);
          
          const rsi = calculateRSI(closes, config.indicators.rsiLength || 14);
          const st = calculateSuperTrend(highs, lows, closes);
          
          technicals = {
            rsi: rsi ? parseFloat(rsi.toFixed(2)) : null,
            supertrend: st ? { trend: st.trend, value: st.value } : null,
          };
          log("screening", `${token.symbol}: RSI=${technicals.rsi} ST=${technicals.supertrend?.trend}`);
        }
      }

      scoredCandidates.push({
        ...enhancedToken, ...filterResult,
        rug_score: rugRisk.score,
        rug_reasons: rugRisk.reasons,
        market_condition: marketIntel.condition,
        profit_mode: isInProfitMode(),
        technicals,
      });
    }

    // Catat semua candidates (termasuk yang tidak lolos) untuk belajar nanti
    if (scoredCandidates.length > 0) recordObservations(scoredCandidates);

    const passingCandidates = scoredCandidates.filter(c => c.passed);
    const planSummary = getPlanSummary();

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
${JSON.stringify(passingCandidates, null, 2)}

Pilih yang TERBAIK dan lakukan gmgn_swap.
${planSummary?.profit_mode ? "PROFIT MODE aktif — kamu bisa lebih agresif dalam memilih." : ""}
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result }) => {
          await liveMessage?.toolFinish(name, result, !result?.error);
          if (name === "gmgn_swap" && (result.success || result.dry_run)) {
            const token = passingCandidates.find(c =>
              c.mint === result.token_out || c.mint === result.would_swap?.token_out
            );
            if (token) {
              trackPosition({
                position: token.mint,
                pool: "gmgn",
                pool_name: token.symbol,
                amount_sol: deployAmount,
                initial_value_usd: (deployAmount * (balance.sol_price || 0)) || 0,
              });
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
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled() && screenReport) {
      if (liveMessage) await liveMessage.finalize(stripThink(screenReport));
      else sendMessage(`🔍 Screen\n${stripThink(screenReport)}`);
    }
  }
  return screenReport;
}

// ─── Cron Setup ───────────────────────────────────────────────

export function startCronJobs() {
  _cronTasks.forEach(t => t.stop());
  const tasks = [];

  // Management (setiap N menit)
  tasks.push(cron.schedule(`*/${config.schedule.managementIntervalMin} * * * *`, runManagementCycle));

  // Screening (setiap N menit)
  tasks.push(cron.schedule(`*/${config.schedule.screeningIntervalMin} * * * *`, runScreeningCycle));

  // Continuous Learning (setiap 30 menit)
  tasks.push(cron.schedule("*/30 * * * *", runContinuousLearningCycle));

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
  log("cron", `Jobs started: mgmt=${config.schedule.managementIntervalMin}m screen=${config.schedule.screeningIntervalMin}m vault=6h report=${reportH}:${String(reportM).padStart(2,"0")}UTC`);
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
  _cronTasks.forEach(t => t.stop());
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── TTY / Interactive ────────────────────────────────────────

const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const sessionHistory = [];
const MAX_HISTORY = 20;
let _ttyInterface = null;

if (isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: buildPrompt() });
  _ttyInterface = rl;
  setInterval(() => { if (!busy) { rl.setPrompt(buildPrompt()); rl.prompt(true); } }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      startCronJobs();
    }
  }

  async function runBusy(fn) {
    if (busy) return;
    busy = true; rl.pause();
    try { await fn(); } catch (e) { console.error(e.message); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  const plan = getPlanSummary();
  const market = getMarketIntelligence();
  const vault = getVaultStatus();
  const vaultDue = isVaultDue();

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║           Ponyou AI Agent — Ready (v2.2)                 ║`);
  console.log(`║  Plan: Day ${String(plan?.day||1).padStart(2,"0")}/${plan?.days_total||30} | Target +${plan?.daily_target_pct||25}%/hari           ║`);
  console.log(`║  Modal: $${String((plan?.today_start_usd||config.pilot.initialCapitalUsd).toFixed(2)).padStart(7)} → $${String((plan?.today_target_usd||0).toFixed(2)).padStart(7)} today    ║`);
  console.log(`║  Market: ${market.condition.padEnd(8)} | Stop-Loss: ${config.pilot.dailyStopLossPct}%/hari      ║`);
  console.log(`║  Vault: ${vault.configured ? `${vault.vault_pct}% tiap ${vault.interval_days}hr | ${vaultDue.days_remaining?.toFixed(1)}hr lagi` : "belum dikonfigurasi".padEnd(30)} ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  console.log(`Perintah CLI: /pilot check, /auto on|off, /off (shutdown), /smart (scan smart money)\n`);

  launchCron();

  startPolling(async (msg) => {
    const text = msg?.text?.trim();
    if (!text) return;
    
    // Command handling in Telegram
    if (text === "/pnl") {
      const history = getPerformanceHistory({ limit: 10 });
      const table = formatPnLTable(history);
      await sendHTML(table);
      return;
    }

    if (text === "/status") {
      const plan = getPlanSummary();
      const market = getMarketIntelligence();
      const msg = [
        `📊 <b>Ponyou Status</b>`,
        `Plan: Day ${plan.day}/${plan.days_total}`,
        `PnL Today: ${plan.today_pnl_pct.toFixed(2)}%`,
        `Market: ${market.condition}`,
      ].join("\n");
      await sendHTML(msg);
      return;
    }

    busy = true;
    let liveMsg = null;
    try {
      liveMsg = await createLiveMessage("🤖 Ponyou Thinking", "Analyzing your request...");
      
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, "GENERAL", null, null, {
        onThinkingStart: async () => { /* already started by createLiveMessage */ },
        onToolStart: async ({ name }) => { await liveMsg?.toolStart(name); },
        onToolFinish: async ({ name, result }) => { await liveMsg?.toolFinish(name, result, !result?.error); },
      });
      
      sessionHistory.push({ role: "user", content: text }, { role: "assistant", content });
      if (sessionHistory.length > MAX_HISTORY) sessionHistory.splice(0, 2);
      
      if (liveMsg) await liveMsg.finalize(stripThink(content));
      else await sendMessage(stripThink(content));
    } catch (e) { 
      if (liveMsg) await liveMsg.finalize(`❌ Error: ${e.message}`);
      else await sendMessage(`Error: ${e.message}`); 
    }
    finally { busy = false; refreshPrompt(); }
  });

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
          startCronJobs();
          console.log("Automation ENABLED.");
        } else if (mode === "off") {
          stopCronJobs();
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
          console.log(`Day: ${p.day}/${p.days_total}`);
          console.log(`P&L Today: ${p.today_pnl_pct.toFixed(2)}% ($${p.today_pnl_usd.toFixed(2)})`);
          console.log(`Target: ${p.daily_target_pct}% | StopLoss: ${config.pilot.dailyStopLossPct}%`);
          console.log(`Mode: ${p.profit_mode ? "PROFIT MODE 🔥" : "NORMAL"}`);
          if (g.paused) console.log(`STATUS: PAUSED (${g.reason}) - Resume in ${g.resume_in_min}m`);
          else console.log("STATUS: RUNNING");
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
          const { content } = await agentLoop("Find the most profitable smart money wallets on Solana and check what tokens they are buying right now. Give me a summary of hype and smart money inflow.", config.llm.maxSteps, sessionHistory, "GENERAL");
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
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });
