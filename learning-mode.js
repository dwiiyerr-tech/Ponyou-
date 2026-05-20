/**
 * Learning Mode — Analisis mendalam saat terjadi loss.
 *
 * Ketika ada trade rugi (stop-loss hit / loss signifikan):
 *  1. Aktifkan LEARNING_MODE selama ~60 menit (tidak ada entry baru)
 *  2. Jalankan LLM untuk menganalisis KENAPA rugi
 *  3. Catat temuan di loss-analysis.json
 *  4. Auto-tambah lessons dari temuan
 *  5. Setelah jeda selesai, resume normal
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { addLesson } from "./lessons.js";
import { buildStructuredOutputBlock, tryParseStructuredOutput, validateStructuredOutput, extractLessonsFromStructuredOutput } from "./structured-output.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_FILE = path.join(__dirname, "loss-analysis.json");
const LEARNING_STATE_FILE = path.join(__dirname, "learning-state.json");

// ─── State ─────────────────────────────────────────────────────

function loadLearningState() {
  if (!fs.existsSync(LEARNING_STATE_FILE)) {
    return {
      active: false,
      startedAt: null,
      endAt: null,
      triggerType: null,  // "STOP_LOSS" | "SERIES_LOSS" | "DAILY_STOPLOSS"
      lossContext: null,
      analysisRun: false,
      totalLearningEvents: 0,
    };
  }
  try { return JSON.parse(fs.readFileSync(LEARNING_STATE_FILE, "utf8")); }
  catch { return { active: false }; }
}

function saveLearningState(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEARNING_STATE_FILE, JSON.stringify(state, null, 2));
}

function loadAnalyses() {
  if (!fs.existsSync(ANALYSIS_FILE)) return { analyses: [] };
  try { return JSON.parse(fs.readFileSync(ANALYSIS_FILE, "utf8")); }
  catch { return { analyses: [] }; }
}

function saveAnalyses(data) {
  fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(data, null, 2));
}

// ─── Core API ──────────────────────────────────────────────────

/**
 * Cek apakah sedang dalam learning mode.
 * Auto-clear jika sudah melewati waktu jeda.
 * @returns {{ active: boolean, reason?: string, resume_in_min?: number }}
 */
export function getLearningModeStatus() {
  const state = loadLearningState();
  if (!state.active) return { active: false };

  const now = Date.now();
  const endAt = new Date(state.endAt).getTime();

  if (now >= endAt) {
    // Jeda selesai — reset
    state.active = false;
    state.triggerType = null;
    state.lossContext = null;
    state.analysisRun = false;
    saveLearningState(state);
    log("learning", "Learning mode selesai — trading dilanjutkan");
    return { active: false, just_ended: true };
  }

  const remainingMin = Math.ceil((endAt - now) / 60000);
  return {
    active: true,
    trigger: state.triggerType,
    resume_in_min: remainingMin,
    resume_at: state.endAt,
    analysis_run: state.analysisRun,
  };
}

/**
 * Aktifkan learning mode setelah loss.
 * @param {object} lossContext - info tentang trade yang rugi
 * @param {'STOP_LOSS'|'SERIES_LOSS'|'DAILY_STOPLOSS'} triggerType
 * @param {number} durationMin - durasi jeda (default 60)
 */
export function activateLearningMode(lossContext, triggerType = "STOP_LOSS", durationMin = 60) {
  const state = loadLearningState();

  // Jangan aktifkan ulang jika sudah aktif
  if (state.active) {
    log("learning", "Learning mode sudah aktif, skip aktivasi ulang");
    return false;
  }

  state.active = true;
  state.startedAt = new Date().toISOString();
  state.endAt = new Date(Date.now() + durationMin * 60 * 1000).toISOString();
  state.triggerType = triggerType;
  state.lossContext = lossContext;
  state.analysisRun = false;
  state.totalLearningEvents = (state.totalLearningEvents || 0) + 1;

  saveLearningState(state);
  log("learning", `LEARNING MODE AKTIF — Trigger: ${triggerType}, Jeda: ${durationMin}min`);
  return true;
}

/**
 * Tandai bahwa analisis LLM sudah dijalankan untuk sesi learning ini.
 */
export function markAnalysisRun() {
  const state = loadLearningState();
  state.analysisRun = true;
  saveLearningState(state);
}

/**
 * Bangun prompt untuk LLM menganalisis kenapa loss terjadi.
 */
export function buildLossAnalysisPrompt(lossContext, recentTrades = [], marketCondition = "UNKNOWN") {
  const ctx = lossContext || {};
  return `
LEARNING MODE — ANALISIS LOSS

Kamu adalah Ponyou dalam mode belajar. Ada trade yang rugi. Analisis mendalam KENAPA ini bisa terjadi.

TRADE YANG RUGI:
- Token: ${ctx.symbol || "?"} (${ctx.mint?.slice(0, 12) || "?"})
- Entry: $${ctx.entry_usd || "?"}
- Exit: $${ctx.exit_usd || "?"}
- P&L: ${ctx.pnl_pct?.toFixed(2) || "?"}%
- Hold Time: ${ctx.hold_minutes || "?"} menit
- Exit Reason: ${ctx.exit_reason || "?"}
- Rug Signals Saat Entry: ${JSON.stringify(ctx.rug_signals || {})}
- Launchpad: ${ctx.launchpad || "?"}
- Market Saat Entry: ${ctx.market_condition || marketCondition}

TRADES TERAKHIR (konteks):
${recentTrades.slice(-5).map(t => `  - ${t.symbol}: ${t.pnl_pct?.toFixed(1)}% (${t.exit_reason})`).join("\n") || "Tidak ada data"}

TUGAS:
1. Identifikasi ROOT CAUSE kenapa trade ini rugi (1-3 poin)
2. Red flags apa yang SEHARUSNYA terdeteksi tapi tidak?
3. Pola apa yang harus DIHINDARI di masa depan?
4. Apakah ini rug pull, dump normal, atau bad entry timing?
5. Apa lesson spesifik yang harus dicatat?

FORMAT JAWABAN:
ROOT_CAUSE: [penjelasan singkat]
MISSED_FLAGS: [apa yang terlewat]
AVOID_PATTERN: [pola yang harus dihindari]
LESSON_1: [pelajaran konkret 1]
LESSON_2: [pelajaran konkret 2, jika ada]
LESSON_3: [pelajaran konkret 3, jika ada]

OUTPUT:
${buildStructuredOutputBlock("LOSS_ANALYSIS")}

Jawab hanya JSON valid, tanpa markdown atau penjelasan tambahan.
`.trim();
}

/**
 * Simpan hasil analisis LLM ke loss-analysis.json.
 * Auto-ekstrak lessons dan tambahkan ke lessons.js.
 */
export function recordLossAnalysis({ lossContext, analysisText, marketCondition, analysisRole = "LOSS_ANALYSIS" }) {
  const data = loadAnalyses();
  const parsed = tryParseStructuredOutput(analysisText);
  const validation = validateStructuredOutput(analysisRole, parsed);
  const confidence = validation.ok ? Number(validation.normalized.confidence || 0) : 0;
  const lessons = validation.ok ? extractLessonsFromStructuredOutput(validation.normalized) : [];
  const promotionEligible = validation.ok && confidence >= 70;

  if (!validation.ok) {
    log("learning_warning", `Structured output rejected for ${analysisRole}: ${validation.errors.join("; ")}`);
  }

  const entry = {
    ts: new Date().toISOString(),
    analysis_role: String(analysisRole || "LOSS_ANALYSIS").toUpperCase(),
    trigger: lossContext?.exit_reason || "UNKNOWN",
    symbol: lossContext?.symbol || "?",
    pnl_pct: lossContext?.pnl_pct,
    market_condition: marketCondition || "UNKNOWN",
    confidence,
    structured_valid: validation.ok,
    validation_errors: validation.errors,
    analysis: analysisText?.slice(0, 2000),
    lessons_extracted: lessons,
    lesson_promotion: promotionEligible ? "approved" : "pending",
  };

  data.analyses.push(entry);
  if (data.analyses.length > 100) data.analyses = data.analyses.slice(-100);
  saveAnalyses(data);

  if (promotionEligible) {
    for (const lesson of lessons) {
      addLesson(lesson, ["loss_analysis", "auto"], { role: "SCREENER" });
    }
  } else if (lessons.length > 0) {
    log("learning", `Analysis stored with ${lessons.length} lessons pending review (confidence ${confidence}).`);
  }

  log("learning", `Analisis ${analysisRole} disimpan. ${promotionEligible ? lessons.length : 0} lesson ditambahkan.`);
  return { saved: true, lessons_added: promotionEligible ? lessons.length : 0, lessons, structured_valid: validation.ok, validation_errors: validation.errors, confidence, promotion_eligible: promotionEligible };
}

/**
 * Cek apakah analisis perlu dijalankan (aktif tapi belum run).
 */
export function shouldRunAnalysis() {
  const state = loadLearningState();
  return state.active && !state.analysisRun;
}

/**
 * Ambil konteks loss aktif untuk dipakai dalam analisis.
 */
export function getActiveLossContext() {
  const state = loadLearningState();
  return state.active ? state.lossContext : null;
}

/**
 * Dapatkan ringkasan riwayat learning untuk prompt sistem.
 */
export function getLearningHistory({ limit = 5 } = {}) {
  const data = loadAnalyses();
  const recent = data.analyses.slice(-limit);
  if (!recent.length) return null;

  return {
    total_analyses: data.analyses.length,
    recent: recent.map(a => ({
      ts: a.ts,
      symbol: a.symbol,
      pnl_pct: a.pnl_pct,
      trigger: a.trigger,
      lessons_count: a.lessons_extracted?.length || 0,
    })),
    all_extracted_lessons: data.analyses
      .flatMap(a => a.lessons_extracted || [])
      .slice(-20),
  };
}

/**
 * Buat ringkasan status learning untuk prompt/laporan.
 */
export function getLearningStatusSummary() {
  const status = getLearningModeStatus();
  const state = loadLearningState();
  const data = loadAnalyses();

  return {
    active: status.active,
    trigger: status.trigger || null,
    resume_in_min: status.resume_in_min || null,
    analysis_run: status.analysis_run || false,
    total_learning_events: state.totalLearningEvents || 0,
    total_analyses: data.analyses.length,
  };
}
