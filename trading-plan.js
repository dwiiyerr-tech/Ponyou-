/**
 * Compound Trading Plan — 30-day session manager.
 *
 * Logika inti:
 *  - Saat PROFIT    → tidak ada batas jumlah trade, compound terus
 *  - Saat LOSS/FLAT → batas normal berlaku (strategy.protections.max_open_trades)
 *  - Stop-loss      → masuk LEARNING MODE (jeda + analisis), bukan sekadar pause
 *  - Target daily   → pause singkat lalu lanjut (compound)
 *
 * Compound formula: End = Start × (1 + dailyTargetPct/100)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN_FILE = process.env.PONYOU_PLAN_FILE || path.join(__dirname, "trading-plan.json");

// ─── Plan Math ────────────────────────────────────────────────

export function buildCompoundSchedule(initialCapitalUsd, dailyTargetPct, days = 30) {
  const schedule = [];
  let capital = initialCapitalUsd;
  for (let day = 1; day <= days; day++) {
    const target = capital * (1 + dailyTargetPct / 100);
    schedule.push({
      day,
      start_usd: parseFloat(capital.toFixed(4)),
      target_usd: parseFloat(target.toFixed(4)),
      profit_needed_usd: parseFloat((target - capital).toFixed(4)),
      profit_pct: dailyTargetPct,
    });
    capital = target;
  }
  return schedule;
}

// ─── File I/O ─────────────────────────────────────────────────

function loadPlan() {
  if (!fs.existsSync(PLAN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
  } catch (e) {
    // Corrupt JSON: back up the bad file so initTradingPlan doesn't
    // silently wipe multi-day progress. Distinguishes truly-missing
    // (return null → init fresh) from corrupt (back up first).
    try {
      const bak = `${PLAN_FILE}.corrupt-${Date.now()}`;
      fs.copyFileSync(PLAN_FILE, bak);
      log("plan", `WARN: trading-plan.json was corrupt (${e.message}); backed up to ${path.basename(bak)} — re-initializing`);
    } catch (_) { /* best-effort */ }
    return null;
  }
}

function savePlan(plan) {
  plan.lastUpdated = new Date().toISOString();
  atomicWriteJson(PLAN_FILE, plan);
}

// ─── Initialization ───────────────────────────────────────────

export function initTradingPlan({
  initialCapitalUsd = 10,
  dailyTargetPct = 25,
  dailyStopLossPct = -10,
  sessionPauseDurationMin = 60,
  learningModeDurationMin = 60,
  days = 30,
} = {}) {
  const schedule = buildCompoundSchedule(initialCapitalUsd, dailyTargetPct, days);
  const plan = {
    initialCapitalUsd,
    dailyTargetPct,
    dailyStopLossPct,
    sessionPauseDurationMin,
    learningModeDurationMin,
    days,
    startDate: new Date().toISOString().slice(0, 10),
    schedule,
    currentDay: 1,
    dailyResults: [],
    session: {
      date: new Date().toISOString().slice(0, 10),
      dayNumber: 1,
      // startCapitalUsd dikalibrasi pada update pertama dari wallet aktual
      // (lihat updateSessionCapital). Default null = belum dikalibrasi.
      startCapitalUsd: null,
      currentCapitalUsd: null,
      calibrated: false,
      calibratedAt: null,
      pausedUntil: null,
      pauseReason: null,    // "TARGET_HIT" | null (loss sekarang pakai learning-mode)
      profitMode: false,    // true saat session profitable
      tradesCount: 0,
      winCount: 0,
      lossCount: 0,
      consecutiveLosses: 0,
      profitUsd: 0,
      profitPct: 0,
    },
    lastUpdated: new Date().toISOString(),
  };
  savePlan(plan);
  log("plan", `Trading plan initialized: $${initialCapitalUsd} → ${days}d @ ${dailyTargetPct}%/day`);
  return plan;
}

// ─── Session Access ───────────────────────────────────────────

export function getTradingPlan() {
  return loadPlan();
}

/**
 * Cek apakah trading sedang di-pause (target harian hit).
 * Auto-resume jika waktu sudah habis.
 * CATATAN: Loss tidak di-pause di sini — ditangani learning-mode.js
 */
export function checkSessionGate() {
  const plan = loadPlan();
  if (!plan) return { paused: false };

  const session = plan.session;
  if (!session.pausedUntil) return { paused: false };

  const now = Date.now();
  const until = new Date(session.pausedUntil).getTime();

  if (now >= until) {
    session.pausedUntil = null;
    session.pauseReason = null;
    savePlan(plan);
    log("plan", "Session auto-resume setelah pause target");
    return { paused: false, just_resumed: true };
  }

  const remainingMin = Math.ceil((until - now) / 60000);
  return {
    paused: true,
    reason: session.pauseReason,
    resume_in_min: remainingMin,
    resume_at: session.pausedUntil,
  };
}

/**
 * Update P&L sesi dan tentukan mode (profit/loss).
 *
 * Return:
 *  - action: "continue" | "pause_target" | "trigger_learning" | "continue_profit"
 *
 * Logika:
 *  - pnl >= dailyTargetPct  → pause singkat (target harian tercapai)
 *  - pnl <= dailyStopLossPct → trigger learning mode (jangan pause di sini, index.js yang handle)
 *  - pnl > 0                → PROFIT MODE (tidak ada batas trade)
 *  - pnl <= 0               → NORMAL MODE (batas trade normal)
 */
export function updateSessionCapital(currentCapitalUsd) {
  const plan = loadPlan();
  if (!plan) return { action: "continue", pnl_pct: 0, profit_mode: false };

  // Guard: tolak nilai invalid agar tidak corrupt P&L.
  // Wallet API yang gagal sering balikin 0 / NaN — itu bukan "rugi 100%".
  if (!Number.isFinite(currentCapitalUsd) || currentCapitalUsd <= 0) {
    return { action: "skip_invalid", pnl_pct: plan.session.profitPct || 0, reason: "invalid_wallet_value" };
  }

  const session = plan.session;

  // B3: Force recalibration if session date differs from today (crash restart)
  // Tanpa ini, P&L dihitung dari baseline sebelum crash — bisa sangat meleset.
  const today = new Date().toISOString().slice(0, 10);
  if (session.date && session.date !== today && session.calibrated) {
    const now = new Date();
    const isRolloverWindow = now.getUTCHours() === 0 && now.getUTCMinutes() < 2;
    let isYesterday = false;
    try {
      const sessionTime = new Date(session.date).getTime();
      const todayTime = new Date(today).getTime();
      const diffDays = (todayTime - sessionTime) / (1000 * 60 * 60 * 24);
      isYesterday = diffDays >= 0.9 && diffDays <= 1.1;
    } catch (_) {}

    if (plan._lastAdvancedAt === today || (!isRolloverWindow || !isYesterday)) {
      log("plan", `Session date mismatch (${session.date} vs ${today}) — forcing recalibration after restart`);
      session.calibrated = false;
    } else {
      log("plan", `Session date mismatch (${session.date} vs ${today}) — waiting for midnight advance cron`);
    }
  }

  // Kalibrasi pertama: set startCapitalUsd dari nilai wallet aktual.
  // Plan.initialCapitalUsd = target tracker (compound 30d),
  // session.startCapitalUsd = baseline real untuk P&L hari ini.
  if (!session.calibrated || session.startCapitalUsd == null || session.startCapitalUsd <= 0) {
    session.startCapitalUsd = currentCapitalUsd;
    session.currentCapitalUsd = currentCapitalUsd;
    session.calibrated = true;
    session.calibratedAt = new Date().toISOString();
    session.date = today; // prevent infinite date-mismatch loop on next cycle
    session.profitUsd = 0;
    session.profitPct = 0;
    savePlan(plan);
    log("plan", `Session calibrated: startCapitalUsd = $${currentCapitalUsd.toFixed(4)}`);
    return { action: "calibrated", pnl_pct: 0, pnl_usd: 0, profit_mode: false };
  }

  session.currentCapitalUsd = currentCapitalUsd;

  const pnlUsd = currentCapitalUsd - session.startCapitalUsd;
  const pnlPct = session.startCapitalUsd > 0
    ? (pnlUsd / session.startCapitalUsd) * 100
    : 0;

  session.profitUsd = parseFloat(pnlUsd.toFixed(4));
  session.profitPct = parseFloat(pnlPct.toFixed(2));

  // Update profit mode flag
  const wasInProfitMode = session.profitMode;
  session.profitMode = pnlPct > 0;

  if (session.profitMode && !wasInProfitMode) {
    log("plan", `PROFIT MODE AKTIF — P&L: +${pnlPct.toFixed(2)}% | Tidak ada batas trade`);
  } else if (!session.profitMode && wasInProfitMode) {
    log("plan", `Keluar PROFIT MODE — P&L: ${pnlPct.toFixed(2)}% | Batas trade normal`);
  }

  // Target harian tercapai → pause singkat
  if (pnlPct >= plan.dailyTargetPct) {
    const pauseDurationMs = (plan.sessionPauseDurationMin || 60) * 60 * 1000;
    session.pausedUntil = new Date(Date.now() + pauseDurationMs).toISOString();
    session.pauseReason = "TARGET_HIT";
    savePlan(plan);
    log("plan", `Daily target tercapai! +${pnlPct.toFixed(2)}% — pause ${plan.sessionPauseDurationMin}min`);
    return { action: "pause_target", pnl_pct: pnlPct, pnl_usd: pnlUsd, profit_mode: true };
  }

  // Daily stop-loss hit → trigger learning (bukan pause biasa)
  if (pnlPct <= plan.dailyStopLossPct) {
    savePlan(plan);
    log("plan", `Daily stop-loss hit! ${pnlPct.toFixed(2)}% — memicu learning mode`);
    return {
      action: "trigger_learning",
      pnl_pct: pnlPct,
      pnl_usd: pnlUsd,
      profit_mode: false,
      trigger_type: "DAILY_STOPLOSS",
    };
  }

  savePlan(plan);
  return {
    action: session.profitMode ? "continue_profit" : "continue",
    pnl_pct: pnlPct,
    pnl_usd: pnlUsd,
    profit_mode: session.profitMode,
  };
}

/**
 * Apakah sesi sekarang dalam profit mode?
 * Dalam profit mode: tidak ada batas jumlah trade.
 */
export function isInProfitMode() {
  const plan = loadPlan();
  return plan?.session?.profitMode === true;
}

/**
 * Hitung batas posisi dinamis berdasarkan mode.
 * @param {number} baseLimit — batas normal (dari config)
 * @returns {number} batas posisi aktif
 */
export function getDynamicPositionLimit(baseLimit = 3) {
  const plan = loadPlan();
  if (!plan) return baseLimit;

  const pnlPct = plan.session.profitPct || 0;

  if (pnlPct > 0) {
    // Profit mode: batas diperbesar sesuai profit
    if (pnlPct >= 20) return Math.max(baseLimit, 8);   // +20%: hingga 8 posisi
    if (pnlPct >= 10) return Math.max(baseLimit, 6);   // +10%: hingga 6 posisi
    return Math.max(baseLimit, 5);                      // profit apapun: minimal 5
  }

  return baseLimit; // Normal: batas default
}

/**
 * Pause manual (untuk user command).
 */
export function pauseSession(reason = "MANUAL", durationMin = null) {
  const plan = loadPlan();
  if (!plan) return false;
  const dur = (durationMin || plan.sessionPauseDurationMin || 60) * 60 * 1000;
  plan.session.pausedUntil = new Date(Date.now() + dur).toISOString();
  plan.session.pauseReason = reason;
  savePlan(plan);
  log("plan", `Session dijeda manual: ${dur / 60000}min`);
  return true;
}

export function resumeSession() {
  const plan = loadPlan();
  if (!plan) return false;
  plan.session.pausedUntil = null;
  plan.session.pauseReason = null;
  savePlan(plan);
  log("plan", "Session manual resume");
  return true;
}

/**
 * Advance ke hari berikutnya.
 * Idempotent: hanya bisa dijalankan sekali per UTC date.
 * Schedule targets direcompute dari actual balance agar tidak divergen.
 */
export function advanceDay(actualCapitalUsd, activeStrategyId = null) {
  const plan = loadPlan();
  if (!plan) return null;

  if (!Number.isFinite(actualCapitalUsd) || actualCapitalUsd <= 0) {
    log("plan_error", `advanceDay aborted — invalid actualCapitalUsd: ${actualCapitalUsd}`);
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);

  // B2: Idempotent guard — hanya bisa advance sekali per UTC date
  if (plan._lastAdvancedAt === today) {
    log("plan", `advanceDay skipped — already advanced today (${today})`);
    return null;
  }

  const dayIdx = plan.currentDay - 1;
  const daySchedule = plan.schedule[dayIdx] || null;

  const result = {
    day: plan.currentDay,
    date: today,
    start_usd: plan.session.startCapitalUsd,
    target_usd: daySchedule?.target_usd,
    actual_usd: actualCapitalUsd,
    achieved: daySchedule ? actualCapitalUsd >= daySchedule.target_usd : null,
    pnl_usd: parseFloat((actualCapitalUsd - plan.session.startCapitalUsd).toFixed(4)),
    pnl_pct: plan.session.startCapitalUsd > 0
      ? parseFloat(((actualCapitalUsd - plan.session.startCapitalUsd) / plan.session.startCapitalUsd * 100).toFixed(2))
      : 0,
    trades: plan.session.tradesCount,
    wins: plan.session.winCount || 0,
    losses: plan.session.lossCount || 0,
    strategy_id: activeStrategyId || null,
  };

  // B4: Recompute remaining schedule from actual balance
  // Prevent compound schedule from diverging indefinitely from reality
  if (Number.isFinite(actualCapitalUsd) && actualCapitalUsd > 0) {
    let capital = actualCapitalUsd;
    for (let i = plan.currentDay; i < plan.days; i++) {
      const target = capital * (1 + plan.dailyTargetPct / 100);
      plan.schedule[i] = {
        day: i + 1,
        start_usd: parseFloat(capital.toFixed(4)),
        target_usd: parseFloat(target.toFixed(4)),
        profit_needed_usd: parseFloat((target - capital).toFixed(4)),
        profit_pct: plan.dailyTargetPct,
      };
      capital = target;
    }
  }

  plan.dailyResults.push(result);
  // B6: Cap dailyResults at 60 entries
  if (plan.dailyResults.length > 60) {
    plan.dailyResults = plan.dailyResults.slice(-60);
  }

  plan.currentDay = Math.min(plan.currentDay + 1, plan.days);
  plan._lastAdvancedAt = today; // B2: idempotent guard

  plan.session = {
    date: today,
    dayNumber: plan.currentDay,
    startCapitalUsd: Number.isFinite(actualCapitalUsd) && actualCapitalUsd > 0 ? actualCapitalUsd : null,
    currentCapitalUsd: Number.isFinite(actualCapitalUsd) && actualCapitalUsd > 0 ? actualCapitalUsd : null,
    calibrated: Number.isFinite(actualCapitalUsd) && actualCapitalUsd > 0,
    calibratedAt: Number.isFinite(actualCapitalUsd) && actualCapitalUsd > 0 ? new Date().toISOString() : null,
    pausedUntil: null,
    pauseReason: null,
    profitMode: false,
    tradesCount: 0,
    winCount: 0,
    lossCount: 0,
    consecutiveLosses: 0,
    profitUsd: 0,
    profitPct: 0,
  };

  savePlan(plan);
  const nextSchedule = plan.schedule[plan.currentDay - 1];
  log("plan", `Day ${result.day} selesai. P&L: ${result.pnl_pct}%. Day ${plan.currentDay} target: $${nextSchedule?.target_usd?.toFixed(2) || "?"}`);
  return result;
}

/**
 * Catat trade baru ke counter session.
 * @param {boolean} isWin
 */
export function recordTrade(isWin = null) {
  const plan = loadPlan();
  if (!plan) return;
  plan.session.tradesCount = (plan.session.tradesCount || 0) + 1;
  if (isWin === true) {
    plan.session.winCount = (plan.session.winCount || 0) + 1;
    plan.session.consecutiveLosses = 0;
  }
  if (isWin === false) {
    plan.session.lossCount = (plan.session.lossCount || 0) + 1;
    plan.session.consecutiveLosses = (plan.session.consecutiveLosses || 0) + 1;
  }
  savePlan(plan);
}

export function getConsecutiveLosses() {
  const plan = loadPlan();
  return plan?.session?.consecutiveLosses || 0;
}

/**
 * Ringkasan plan untuk prompt sistem.
 */
export function getPlanSummary() {
  const plan = loadPlan();
  if (!plan) return null;

  const session = plan.session;
  const daySchedule = plan.schedule[plan.currentDay - 1];
  const gate = checkSessionGate();
  const total = plan.dailyResults.length;
  const wins = plan.dailyResults.filter(r => r.achieved).length;

  return {
    day: plan.currentDay,
    days_total: plan.days,
    start_capital_usd: plan.initialCapitalUsd,
    today_start_usd: session.startCapitalUsd,
    today_target_usd: daySchedule?.target_usd,
    today_current_usd: session.currentCapitalUsd,
    today_pnl_pct: session.profitPct,
    today_pnl_usd: session.profitUsd,
    daily_target_pct: plan.dailyTargetPct,
    daily_stoploss_pct: plan.dailyStopLossPct,
    calibrated: session.calibrated === true,

    // Profit mode
    profit_mode: session.profitMode,
    position_limit_active: getDynamicPositionLimit(3),

    // Session gate (hanya target_hit)
    session_paused: gate.paused,
    pause_reason: gate.reason || null,
    resume_in_min: gate.resume_in_min || null,

    // Stats
    win_rate_days: total > 0 ? `${wins}/${total}` : "0/0",
    trades_today: session.tradesCount,
    wins_today: session.winCount || 0,
    losses_today: session.lossCount || 0,
    days_completed: total,
  };
}
