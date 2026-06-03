/**
 * General Agent — Ponyou Assistant & Control Interface
 *
 * Tugas utama:
 *   - Menjawab semua pertanyaan user tentang Ponyou (fitur, status, performa)
 *   - Mengontrol Ponyou sesuai perintah user (start/stop, ganti strategi, toggle fitur)
 *   - Memelihara riwayat percakapan agar konteks tidak hilang
 *   - Menyediakan ringkasan status real-time setiap sesi
 *
 * Interface:
 *   Telegram → handleGeneralMessage(text) → response string (HTML)
 *   Dashboard → handleGeneralMessage(text) → response string (plain)
 *
 * TIDAK membuat keputusan BUY/SELL — itu milik Management Agent.
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth, getAllAgentStatuses } from "./agent-registry.js";
import { log } from "../logger.js";

const AGENT_NAME = "general";

let _agentLoop    = null;
let _config       = null;
let _controls     = null;
let _initialized  = false;

// Riwayat percakapan — persisten selama runtime, bukan per-restart
const _history = [];
const MAX_HISTORY = 20; // 10 pasang user/assistant

// ─── System Prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt(stateSnapshot) {
  return `Kamu adalah Ponyou Assistant — asisten cerdas untuk bot trading Solana memecoin bernama Ponyou.

## Identitas & Peran
- Kamu membantu operator (user) memahami dan mengontrol Ponyou
- Kamu BISA mengeksekusi kontrol (start/stop, ganti strategi, toggle fitur) menggunakan tools yang tersedia
- Kamu TIDAK membuat keputusan BUY/SELL — itu dilakukan oleh Management Agent secara otomatis
- Jawab dalam bahasa yang sama dengan user (Indonesia atau Inggris)
- Respon ringkas dan to the point — ini Telegram, bukan dokumen
- Gunakan format HTML Telegram: <b>bold</b>, <i>italic</i>, <code>mono</code>

## Status Ponyou Saat Ini
${stateSnapshot}

## Controls yang Bisa Kamu Eksekusi

### 📊 Status & Info
- **ponyou_get_status** — status lengkap real-time
- **ponyou_get_agents** — status semua sub-agent
- **ponyou_get_open_positions** — daftar posisi aktif
- **get_performance_history** — riwayat P&L
- **get_market_intelligence** — kondisi market sekarang
- **get_wallet_balance** — saldo wallet
- **get_learning_status** — status mode belajar
- **score_rug_risk** — cek rug risk sebuah token

### 🎮 Trading Control
- **ponyou_toggle_automation** — start/stop automation (enable: true/false)
- **ponyou_switch_strategy** — ganti strategi (scalping/sniper/dip_buy/smart_money/degen/day_phase_trading)
- **ponyou_toggle_feature** — enable/disable fitur
- **ponyou_set_confirm_mode** — mode konfirmasi sebelum trade
- **add_to_blacklist** — blacklist token

### 📋 Trading Plan Management
- **ponyou_get_plan** — lihat trading plan saat ini (target harian, stop loss, dll)
- **ponyou_update_plan** — ubah parameter plan:
  - dailyTargetPct: target profit harian (%)
  - dailyStopLossPct: batas kerugian harian (negatif, misal -15)
  - maxPositions: maks posisi terbuka (1-5)
  - deployAmountSol: ukuran entry per posisi (SOL)

### 🧠 Memory & Second Brain (PENTING)
- **ponyou_remember** — simpan pelajaran/preferensi user ke second brain Ponyou
  Contoh: "ingat bahwa saya suka AI narrative" → tersimpan di vault, berlaku setiap cycle
  Contoh: "jangan trading saat market DEAD" → bot akan ikuti ini otomatis
  Contoh: "BSC terlalu berisiko, skip saja" → ditambahkan ke operator lessons
- **ponyou_vault_summary** — lihat semua yang sudah Ponyou "ingat" (vault intelligence)
- **add_lesson** — tambah pelajaran teknis ke memory
- **list_lessons** — lihat semua pelajaran teknis tersimpan

## Perintah yang Tidak Perlu Tool
- "/help" atau "help" → jelaskan commands tersedia
- Pertanyaan umum tentang fitur → jawab dari pengetahuan kamu

## Aturan Penting
1. Kalau user minta start/stop bot → gunakan ponyou_toggle_automation
2. Kalau user minta ganti strategi → gunakan ponyou_switch_strategy
3. Kalau user minta info status → gunakan ponyou_get_status
4. Kalau user bilang "ingat", "remember", "catat", "simpan" → gunakan ponyou_remember SEGERA
5. Kalau user minta ubah target/stop loss/max positions → gunakan ponyou_update_plan
6. Jangan mengarang data — kalau tidak tahu, gunakan tool yang sesuai
7. Setelah eksekusi control → konfirmasi hasilnya ke user dengan jelas
8. ponyou_remember sangat penting — ini cara user "mengajari" Ponyou strategi mereka
   Setiap instruksi dari user yang bersifat preferensi/strategi HARUS disimpan`;
}

// ─── State Snapshot ───────────────────────────────────────────────────────

function buildStateSnapshot() {
  if (!_controls) return "Status tidak tersedia (controls belum diregistrasi)";
  try {
    const s = _controls.getStatus();
    const lines = [];
    lines.push(`🤖 Automation: ${s.automation_on ? "🟢 ON" : "🔴 OFF"}`);
    lines.push(`📊 Market: ${s.market_condition || "UNKNOWN"}`);
    lines.push(`🎯 Strategy: ${s.active_strategy || "unknown"}`);
    lines.push(`💼 Open Positions: ${s.open_positions ?? 0}/${s.max_positions ?? 0}`);
    if (s.today_pnl_pct != null) lines.push(`📈 Today P&L: ${s.today_pnl_pct >= 0 ? "+" : ""}${s.today_pnl_pct.toFixed(1)}%`);
    if (s.confirm_mode != null) lines.push(`✋ Confirm Mode: ${s.confirm_mode ? "ON" : "OFF"}`);
    return lines.join("\n");
  } catch (e) {
    return `Status error: ${e.message}`;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initGeneralAgent({ agentLoop, config, controls }) {
  if (_initialized) return;
  _initialized = true;

  _agentLoop = agentLoop;
  _config    = config;
  _controls  = controls || null;

  setAgentStatus(AGENT_NAME, "running", "General agent — Ponyou assistant & control interface");

  // ── Agent bus: legacy support ──
  agentBus.on("general:telegram", async (payload) => {
    const reqId = payload?._reqId;
    if (!reqId) return;
    const text = payload?.text?.trim() || "";
    try {
      const response = await handleGeneralMessage(text);
      agentBus.respond(reqId, { response });
    } catch (e) {
      agentBus.respond(reqId, { response: `Error: ${e.message}` });
    }
  });

  agentBus.on("general:dashboard_query", async (payload) => {
    const reqId = payload?._reqId;
    if (!reqId) return;
    const query = payload?.query || "";
    try {
      const response = await handleGeneralMessage(query);
      agentBus.respond(reqId, { response });
    } catch (e) {
      agentBus.respond(reqId, { response: `Error: ${e.message}` });
    }
  });

  log("general", "General agent initialized — assistant & control interface ready");
}

// ─── Main Message Handler ─────────────────────────────────────────────────
// Entry point utama — dipanggil dari handleIncomingTelegramMessage

export async function handleGeneralMessage(text) {
  if (!text) return "";

  // Quick responses tanpa LLM
  const quick = _quickResponse(text);
  if (quick) return quick;

  // ── Direct memory shortcuts (no LLM needed for explicit remember commands) ──
  const rememberMatch = text.match(/^(?:ingat|remember|catat|simpan)[:\s]+(.+)/is);
  if (rememberMatch && _controls?.rememberLesson) {
    const lesson = rememberMatch[1].trim();
    _controls.rememberLesson(lesson, "user");
    log("general", `Memory saved: "${lesson.slice(0, 80)}"`);
    return `✅ <b>Disimpan ke Second Brain</b>\n<i>"${lesson.slice(0, 100)}"</i>\n\nPonyou akan menggunakan pelajaran ini pada setiap screening cycle berikutnya.`;
  }

  if (!_agentLoop) {
    return "LLM belum siap. Coba lagi sebentar.";
  }

  const stateSnapshot = buildStateSnapshot();
  const systemPrompt  = buildSystemPrompt(stateSnapshot);

  // Build history untuk konteks percakapan
  const messages = [..._history, { role: "user", content: text }];

  try {
    const { content } = await _agentLoop(
      text,
      _config?.llm?.maxSteps || 6,
      _history,
      "GENERAL",
      _config?.llm?.generalModel || null,
      2048,
      { systemPromptOverride: systemPrompt }
    );

    // Simpan ke riwayat
    _history.push({ role: "user", content: text });
    _history.push({ role: "assistant", content: content || "" });
    if (_history.length > MAX_HISTORY) _history.splice(0, 2);

    updateAgentHealth(AGENT_NAME, {
      last_message: new Date().toISOString(),
      last_intent: text.slice(0, 60),
      history_size: _history.length,
    });

    return content || "Tidak ada respons dari LLM.";
  } catch (e) {
    log("general_error", `LLM failed: ${e.message}`);
    return `❌ <b>Error</b>\n<code>${e.message.slice(0, 200)}</code>`;
  }
}

// ─── Quick Response (tanpa LLM) ───────────────────────────────────────────

function _quickResponse(text) {
  const t = text.toLowerCase().trim();

  if (t === "/help" || t === "help" || t === "bantuan") {
    return [
      "🤖 <b>Ponyou Assistant</b>",
      "",
      "<b>📊 Info</b>",
      "/status — Status bot & market",
      "/pnl — Riwayat P&L",
      "/menu — Menu lengkap",
      "/agents — Status semua agent",
      "/positions — Posisi aktif",
      "/qualification — Progress automation",
      "",
      "<b>🎮 Control</b>",
      "/auto on|off — Start/stop automation",
      "/strategy <id> — Ganti strategi",
      "/confirm on|off — Mode konfirmasi",
      "/feature <name> on|off — Toggle fitur",
      "/strategies — List semua strategi",
      "/health — Health semua fitur",
      "",
      "<b>💬 Chat</b>",
      "Tanya apa saja dalam bahasa natural.",
      "Contoh: <i>\"bagaimana performa hari ini?\"</i>",
      "<i>\"matikan automation\"</i>, <i>\"ganti ke strategi sniper\"</i>",
    ].join("\n");
  }

  if (t === "/clear_history" || t === "/reset_chat") {
    _history.length = 0;
    return "✅ Riwayat percakapan direset.";
  }

  return null;
}

// ─── Reset history (untuk debugging) ──────────────────────────────────────

export function clearGeneralAgentHistory() {
  _history.length = 0;
}

// ─── Status ───────────────────────────────────────────────────────────────

export function isGeneralAgentReady() {
  return _initialized && !!_agentLoop;
}

export function getGeneralAgentStatus() {
  return {
    name: AGENT_NAME,
    role: "general",
    initialized: _initialized,
    llmReady: !!_agentLoop,
    controlsRegistered: !!_controls,
    historyLength: _history.length,
    description: "Ponyou assistant & control interface",
  };
}

export default { initGeneralAgent, handleGeneralMessage, isGeneralAgentReady, getGeneralAgentStatus };
