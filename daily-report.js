/**
 * Daily Report — Laporan trading 24 jam.
 *
 * Dikompilasi setiap 24 jam dan dikirim via Telegram + disimpan ke logs/.
 * Isi laporan:
 *  - Ringkasan P&L hari ini (compound plan)
 *  - Semua trade dalam 24 jam terakhir
 *  - Win rate & statistik
 *  - Kondisi market dominan hari ini
 *  - Learning mode events (loss analyses)
 *  - Status vault (hari menuju vault berikutnya)
 *  - Lessons baru yang ditambahkan hari ini
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { getPlanSummary } from "./trading-plan.js";
import { getMarketIntelligence, getMarketTrend } from "./market-intelligence.js";
import { getVaultStatus } from "./vault.js";
import { getLearningHistory, getLearningStatusSummary } from "./learning-mode.js";
import { getPerformanceHistory } from "./lessons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "logs");
const LAST_REPORT_FILE = path.join(__dirname, "last-report.json");

// ─── Helpers ───────────────────────────────────────────────────

function loadLastReport() {
  if (!fs.existsSync(LAST_REPORT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(LAST_REPORT_FILE, "utf8")); }
  catch { return null; }
}

function saveLastReport(data) {
  atomicWriteJson(LAST_REPORT_FILE, data);
}

/**
 * Filter trades dalam 24 jam terakhir.
 */
function getTradesLast24h() {
  const trades = getPerformanceHistory({ limit: 200 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return trades.filter(t => t.ts && new Date(t.ts).getTime() >= cutoff);
}

/**
 * Hitung statistik dari daftar trades.
 */
function computeStats(trades) {
  if (!trades.length) return null;

  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const rugs = trades.filter(t => t.rug_detected);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl_pct || 0), 0);
  const avgPnl = totalPnl / trades.length;
  const avgHold = trades.reduce((s, t) => s + (t.hold_minutes || 0), 0) / trades.length;

  const best = trades.reduce((a, b) => (a.pnl_pct || 0) > (b.pnl_pct || 0) ? a : b, trades[0]);
  const worst = trades.reduce((a, b) => (a.pnl_pct || 0) < (b.pnl_pct || 0) ? a : b, trades[0]);

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    rugs: rugs.length,
    win_rate_pct: parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    avg_pnl_pct: parseFloat(avgPnl.toFixed(2)),
    total_pnl_pct: parseFloat(totalPnl.toFixed(2)),
    avg_hold_min: Math.round(avgHold),
    best_trade: best ? { symbol: best.symbol, pnl_pct: parseFloat((best.pnl_pct || 0).toFixed(2)) } : null,
    worst_trade: worst ? { symbol: worst.symbol, pnl_pct: parseFloat((worst.pnl_pct || 0).toFixed(2)) } : null,
  };
}

// ─── Report Generation ─────────────────────────────────────────

/**
 * Kompilasi data untuk laporan harian.
 */
export function compileReport() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  const plan = getPlanSummary();
  const market = getMarketIntelligence();
  const marketTrend = getMarketTrend();
  const vault = getVaultStatus();
  const learning = getLearningHistory({ limit: 5 });
  const learnStatus = getLearningStatusSummary();
  const trades24h = getTradesLast24h();
  const stats = computeStats(trades24h);

  return {
    date: dateStr,
    generated_at: now.toISOString(),
    plan: plan ? {
      day: plan.day,
      days_total: plan.days_total,
      start_usd: plan.today_start_usd,
      end_usd: plan.today_current_usd,
      target_usd: plan.today_target_usd,
      pnl_pct: plan.today_pnl_pct,
      pnl_usd: plan.today_pnl_usd,
      target_pct: plan.daily_target_pct,
      stoploss_pct: plan.daily_stoploss_pct,
      win_rate_days: plan.win_rate_days,
      achieved_today: !!(plan.today_target_usd && plan.today_current_usd >= plan.today_target_usd),
      days_completed: plan.days_completed,
    } : null,
    trades: {
      last_24h: trades24h,
      stats,
    },
    market: {
      current_condition: market.condition,
      description: market.description,
      trend: marketTrend.trend,
      metrics: market.latest_metrics,
    },
    learning: {
      events_total: learnStatus.total_learning_events,
      analyses_total: learnStatus.total_analyses,
      recent_analyses: learning?.recent || [],
    },
    vault: {
      configured: vault.configured,
      vault_wallet: vault.vault_wallet,
      total_vaulted_sol: vault.total_vaulted_sol,
      total_vaulted_usd: vault.total_vaulted_usd,
      vault_pct: vault.vault_pct,
      days_until_next: vault.days_until_next,
      is_due: vault.is_due,
      last_vault_date: vault.last_vault_date,
    },
  };
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const DIVIDER = "──────────────";
const signed = (n, suf = "") => (n > 0 ? "+" : "") + Number(n || 0).toFixed(2) + suf;

/**
 * Format laporan menjadi HTML minimalist untuk Telegram.
 */
export function formatReportTelegram(report) {
  const p = report.plan;
  const s = report.trades.stats;
  const v = report.vault;
  const lines = [];

  lines.push(`📊 <b>Laporan harian</b> · ${esc(report.date)}`);
  lines.push(DIVIDER);

  if (p) {
    const emoji = p.achieved_today ? "✅" : p.pnl_pct > 0 ? "📈" : "📉";
    lines.push(
      `${emoji} <b>Day ${p.day}/${p.days_total}</b> · target +${p.target_pct}%`,
    );
    lines.push(
      `$${Number(p.start_usd || 0).toFixed(2)} → $${Number(p.end_usd || 0).toFixed(2)}  (${signed(p.pnl_pct, "%")})`,
    );
    lines.push(`Wins: ${esc(p.win_rate_days)} · selesai ${p.days_completed}d`);
    lines.push(``);
  }

  lines.push(`📈 <b>Trades 24h</b>`);
  if (s) {
    lines.push(`${s.total} total · W ${s.wins} · L ${s.losses}${s.rugs ? ` · rug ${s.rugs}` : ""}`);
    lines.push(`WR ${s.win_rate_pct}% · avg ${signed(s.avg_pnl_pct, "%")} · hold ${s.avg_hold_min}m`);
    if (s.best_trade)  lines.push(`🏆 ${esc(s.best_trade.symbol)}  ${signed(s.best_trade.pnl_pct, "%")}`);
    if (s.worst_trade) lines.push(`💀 ${esc(s.worst_trade.symbol)}  ${signed(s.worst_trade.pnl_pct, "%")}`);
  } else {
    lines.push(`<i>Tidak ada trade</i>`);
  }
  lines.push(``);

  lines.push(`🌡️ <b>Market</b> · ${esc(report.market.current_condition)} (${esc(report.market.trend)})`);

  if (report.learning.events_total > 0) {
    lines.push(``);
    lines.push(`🧠 <b>Learning</b> · ${report.learning.events_total} events · ${report.learning.analyses_total} analyses`);
    const last = report.learning.recent_analyses[report.learning.recent_analyses.length - 1];
    if (last) lines.push(`Last: ${esc(last.symbol)} ${signed(last.pnl_pct, "%")} · ${last.lessons_count} lessons`);
  }

  lines.push(``);
  if (v.configured) {
    const due = v.is_due
      ? `<b>jatuh tempo</b> · siap transfer ${v.vault_pct}%`
      : `next ${Number(v.days_until_next || 0).toFixed(1)}d`;
    lines.push(`🏦 <b>Vault</b> · ${Number(v.total_vaulted_sol || 0).toFixed(3)} SOL ($${Number(v.total_vaulted_usd || 0).toFixed(2)}) · ${due}`);
  } else {
    lines.push(`🏦 <i>Vault belum dikonfigurasi</i>`);
  }

  return lines.join("\n");
}

/**
 * Simpan laporan ke file logs/report-YYYY-MM-DD.json.
 */
export function saveReport(report) {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filePath = path.join(REPORT_DIR, `report-${report.date}.json`);
  atomicWriteJson(filePath, report);

  saveLastReport({
    date: report.date,
    generated_at: report.generated_at,
    summary: {
      pnl_pct: report.plan?.pnl_pct,
      trades: report.trades.stats?.total || 0,
      win_rate: report.trades.stats?.win_rate_pct || 0,
      market: report.market.current_condition,
    },
  });

  log("report", `Laporan harian disimpan: logs/report-${report.date}.json`);
  return filePath;
}

/**
 * Generate dan simpan laporan, return formatted text.
 * Call ini dari cron job.
 */
export function generateDailyReport() {
  const report = compileReport();
  const filePath = saveReport(report);
  const text = formatReportTelegram(report);
  return { report, text, filePath };
}

/**
 * Cek apakah laporan hari ini sudah digenerate.
 */
export function wasTodayReported() {
  const last = loadLastReport();
  if (!last) return false;
  const today = new Date().toISOString().slice(0, 10);
  return last.date === today;
}

/**
 * Get status laporan untuk prompt.
 */
export function getReportStatus() {
  const last = loadLastReport();
  return {
    last_report_date: last?.date || null,
    last_report_pnl: last?.summary?.pnl_pct || null,
    last_report_trades: last?.summary?.trades || 0,
    last_report_win_rate: last?.summary?.win_rate || 0,
  };
}
