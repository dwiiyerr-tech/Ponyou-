/**
 * Continuous Learning — Belajar dari setiap kejadian, bukan hanya loss.
 *
 * 1. Observasi: Mencatat token yang TIDAK dibeli untuk dicek performanya nanti.
 * 2. Success Analysis: Menganalisis kenapa trade profit agar pola sukses bisa diulang.
 * 3. Trash Analysis: Menganalisis token yang rug/dump meskipun kita tidak beli.
 */

import fs from "fs";
import { log } from "./logger.js";
import { addLesson } from "./lessons.js";
import { getTokenMarketInfo } from "./tools/gmgn.js";

const OBSERVATION_FILE = "./observed-tokens.json";

// ─── Observation Management ────────────────────────────────────

function loadObservations() {
  if (!fs.existsSync(OBSERVATION_FILE)) return { observed: [] };
  try { return JSON.parse(fs.readFileSync(OBSERVATION_FILE, "utf8")); }
  catch { return { observed: [] }; }
}

function saveObservations(data) {
  fs.writeFileSync(OBSERVATION_FILE, JSON.stringify(data, null, 2));
}

/**
 * Catat token yang masuk radar tapi tidak dibeli (atau difilter).
 * @param {Array} candidates - List token dari screening
 */
export function recordObservations(candidates) {
  const data = loadObservations();
  const now = Date.now();

  for (const token of candidates) {
    // Hindari duplikasi
    if (data.observed.some(o => o.mint === token.mint)) continue;

    data.observed.push({
      mint: token.mint,
      symbol: token.symbol,
      observed_at: new Date().toISOString(),
      check_at: new Date(now + 60 * 60 * 1000).toISOString(), // Cek 60 menit kemudian
      initial_mcap: token.mcap || token.initial_mcap,
      initial_price: token.price,
      passed_filters: token.passed || false,
      flags: token.flags || [],
      rug_score: token.rug_score || 0,
      market_condition: token.market_condition || "UNKNOWN",
      status: "PENDING",
    });
  }

  // Batasi jumlah observasi (misal 50 terakhir)
  if (data.observed.length > 100) data.observed = data.observed.slice(-100);
  
  saveObservations(data);
  log("learning", `Mencatat ${candidates.length} observasi untuk evaluasi masa depan.`);
}

/**
 * Cek performa token yang diobservasi.
 * Mencari "Missed Gems" atau "Confirmed Trash".
 */
export async function processObservations() {
  const data = loadObservations();
  const now = Date.now();
  const due = data.observed.filter(o => o.status === "PENDING" && new Date(o.check_at).getTime() <= now);

  if (due.length === 0) return null;

  log("learning", `Mengevaluasi ${due.length} token observasi...`);
  const results = [];

  for (const obs of due) {
    try {
      const market = await getTokenMarketInfo({ mint: obs.mint });
      if (market.error) {
        obs.status = "FAILED";
        continue;
      }

      const currentMcap = market.mcap || 0;
      const initialMcap = obs.initial_mcap || 0;
      
      let performance = "NEUTRAL";
      let changePct = 0;

      if (initialMcap > 0) {
        changePct = ((currentMcap - initialMcap) / initialMcap) * 100;
        if (changePct >= 100) performance = "GEM";          // 2x lipat
        else if (changePct <= -50) performance = "TRASH";   // Dump 50%
      }

      obs.status = "COMPLETED";
      obs.final_mcap = currentMcap;
      obs.change_pct = changePct;
      obs.performance = performance;

      if (performance !== "NEUTRAL") {
        results.push({
          symbol: obs.symbol,
          mint: obs.mint,
          performance,
          change_pct: changePct,
          passed: obs.passed_filters,
          flags: obs.flags,
        });
      }
    } catch (e) {
      log("learning_error", `Gagal cek observasi ${obs.symbol}: ${e.message}`);
    }
  }

  saveObservations(data);
  return results;
}

/**
 * Bangun prompt untuk menganalisis hasil observasi.
 */
export function buildObservationAnalysisPrompt(results) {
  const gems = results.filter(r => r.performance === "GEM");
  const trash = results.filter(r => r.performance === "TRASH");

  if (gems.length === 0 && trash.length === 0) return null;

  return `
CONTINUOUS LEARNING — OBSERVATION ANALYSIS

Kamu menganalisis token yang SEBELUMNYA masuk radar tapi tidak dibeli atau difilter.

MISSED GEMS (Naik >100%):
${gems.map(g => `- ${g.symbol}: +${g.change_pct.toFixed(1)}% (Passed Filter: ${g.passed}, Flags: ${g.flags.join(", ") || "None"})`).join("\n") || "None"}

CONFIRMED TRASH (Turun >50%):
${trash.map(t => `- ${t.symbol}: ${t.change_pct.toFixed(1)}% (Passed Filter: ${t.passed}, Flags: ${t.flags.join(", ") || "None"})`).join("\n") || "None"}

TUGAS:
1. Mengapa kita melewatkan GEMS? Apakah filter terlalu ketat?
2. Apakah TRASH yang lolos filter memiliki pola tersembunyi?
3. Update strategi untuk membedakan GEMS vs TRASH di masa depan.

FORMAT JAWABAN:
INSIGHT: [analisis singkat]
ADJUSTMENT: [saran perubahan parameter/pola]
LESSON: [pelajaran konkret untuk dicatat]

Jawab dalam Bahasa Indonesia, singkat.
`.trim();
}

/**
 * Bangun prompt untuk sukses (Profit > 20%).
 */
export function buildSuccessAnalysisPrompt(tradeContext, marketCondition = "UNKNOWN") {
  const ctx = tradeContext || {};
  return `
LEARNING MODE — SUCCESS ANALYSIS

Trade ini sangat menguntungkan. Analisis MENGAPA ini sukses agar bisa diulangi.

SUCCESSFUL TRADE:
- Token: ${ctx.symbol} (${ctx.mint?.slice(0, 12)})
- P&L: +${ctx.pnl_pct?.toFixed(2)}%
- Hold Time: ${ctx.hold_minutes} menit
- Market: ${marketCondition}
- Entry Reason: ${ctx.entry_reason || "Passed 4-Filter Protocol"}

TUGAS:
1. Apa ciri utama token ini yang membuatnya sukses?
2. Apakah ada sinyal "Super Alpha" yang terdeteksi?
3. Pola seperti apa yang harus kita cari lagi di masa depan?

FORMAT JAWABAN:
SUCCESS_FACTOR: [faktor kunci]
ALPHA_SIGNAL: [sinyal kuat yang ada]
REPLICATE_PATTERN: [pola untuk dicari lagi]
LESSON: [pelajaran konkret]

Jawab dalam Bahasa Indonesia, singkat.
`.trim();
}
