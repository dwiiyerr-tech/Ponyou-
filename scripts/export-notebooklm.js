#!/usr/bin/env node
/**
 * export-notebooklm.js — Generate export markdown untuk NotebookLM
 *
 * Mengumpulkan semua data bot menjadi 1 file markdown terstruktur
 * yang bisa di-upload ke NotebookLM untuk analisis AI.
 *
 * Usage:
 *   node scripts/export-notebooklm.js
 *   node scripts/export-notebooklm.js --output /path/to/file.md
 *   node scripts/export-notebooklm.js --watch   (re-export setiap jam)
 *
 * Output: ponyou-brain/notebooklm-export.md (+ console path)
 *
 * Cara pakai di NotebookLM:
 *   1. Buka notebooklm.google.com
 *   2. New Notebook → Add Source
 *   3. Upload file: notebooklm-export.md
 *   4. Tanya apapun: "apa pola win terbanyak?", "narrative apa yang harus dihindari?"
 *
 * Untuk auto-refresh via GitHub:
 *   1. Push vault ke GitHub (npm run secondbrain:setup)
 *   2. Di NotebookLM: Add Source → Website URL →
 *      https://raw.githubusercontent.com/USERNAME/ponyou-brain/main/notebooklm-export.md
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_VAULT = process.env.PONYOU_VAULT_DIR || "/home/ubuntu/ponyou-brain";
const OUTPUT_ARG = process.argv.find(a => a.startsWith("--output="))?.slice(9);
const OUTPUT_FILE = OUTPUT_ARG || path.join(DEFAULT_VAULT, "notebooklm-export.md");
const WATCH_MODE = process.argv.includes("--watch");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

function readText(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch { return null; }
}

function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function pct(n, decimals = 1) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(decimals)}%` : "N/A";
}

function sol(n) {
  return Number.isFinite(n) ? `${Number(n).toFixed(4)} SOL` : "N/A";
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildHeader() {
  const now = new Date();
  return `# Ponyou Trading Bot — Knowledge Base untuk NotebookLM

> **Bot:** Ponyou Solana Memecoin Trading Bot
> **Mode:** ${process.env.EXECUTION_MODE || "demo"}
> **Generated:** ${now.toISOString()}
> **Tujuan file ini:** Dianalisis oleh NotebookLM untuk membantu operator memahami performa, pola, dan perkembangan bot.

---
`;
}

function buildBotStatus() {
  const state = readJson(path.join(ROOT, "state.json"))
    || readJson(path.join(ROOT, "demo", "state.json"));
  const plan = readJson(path.join(ROOT, "trading-plan.json"))
    || readJson(path.join(ROOT, "demo", "trading-plan.json"));
  const active = readJson(path.join(ROOT, "active-strategy.json"));
  const metrics = readJson(path.join(ROOT, "metrics.json"));

  const lines = [`## 1. Status Bot Saat Ini\n`];

  lines.push(`**Strategi aktif:** ${active?.id || "unknown"}`);
  lines.push(`**Mode:** ${process.env.EXECUTION_MODE || "demo"} | DryRun: ${process.env.DRY_RUN || "true"}`);

  if (plan) {
    lines.push(`\n### Trading Plan`);
    lines.push(`- **Hari ke:** ${plan.currentDay || 1} dari ${plan.days || 30}`);
    lines.push(`- **Modal awal:** $${plan.initialCapitalUsd || 10}`);
    lines.push(`- **Target harian:** +${plan.dailyTargetPct || 25}%`);
    lines.push(`- **Stop loss harian:** ${plan.dailyStopLossPct || -10}%`);
    const session = plan.session;
    if (session) {
      lines.push(`- **P&L hari ini:** ${(session.profitPct || 0).toFixed(2)}%`);
      lines.push(`- **Trade hari ini:** ${session.tradesCount || 0}`);
      lines.push(`- **Win hari ini:** ${session.winCount || 0}`);
    }
  }

  if (state) {
    const positions = Object.values(state.positions || {}).filter(p => !p.closed);
    lines.push(`\n**Open positions:** ${positions.length}`);
    if (positions.length > 0) {
      for (const p of positions.slice(0, 5)) {
        lines.push(`- ${p.symbol || p.mint?.slice(0, 8)} | ${p.strategy || "?"} | entry ${sol(p.amount_sol)}`);
      }
    }
  }

  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildOperatorLessons() {
  const vaultFile = path.join(DEFAULT_VAULT, "operator-lessons.md");
  const content = readText(vaultFile);
  if (!content || content.length < 20) {
    return `## 2. Operator Lessons\n\n*Belum ada lessons. Tambahkan via Telegram: "ingat [instruksi]"*\n\n---\n`;
  }
  return `## 2. Operator Lessons (Instruksi dari Operator)\n\n${content}\n\n---\n`;
}

function buildLearnedRules() {
  const pe = readJson(path.join(ROOT, "prompt-evolution.json"))
    || readJson(path.join(ROOT, "demo", "prompt-evolution.json"));
  if (!pe?.rules?.length) {
    return `## 3. Learned Rules (Aturan dari Trade History)\n\n*Belum ada rules. Bot perlu lebih banyak trades untuk belajar.*\n\n---\n`;
  }

  const lines = [`## 3. Learned Rules (Auto-generated dari Trade History)\n`];
  lines.push(`Bot telah mempelajari **${pe.rules.length} aturan** dari riwayat trade:\n`);
  for (const r of pe.rules) {
    lines.push(`- **${r.tag || r.label || "Rule"}:** ${r.description || r.rule || JSON.stringify(r).slice(0, 100)}`);
    if (r.win_rate) lines.push(`  - Win rate: ${pct(r.win_rate)} | Trades: ${r.trades || "?"} | Avg PnL: ${r.avg_pnl_pct || "?"}%`);
  }
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildStrategyPerformance() {
  const perf = readJson(path.join(ROOT, "strategy-performance.json"));
  const lines = [`## 4. Performa per Strategi\n`];
  if (!perf?.strategies || Object.keys(perf.strategies).length === 0) {
    lines.push(`*Belum ada data performa strategi. Bot perlu lebih banyak trades.*\n`);
  } else {
    lines.push(`| Strategi | Trades | Win Rate | Rug Rate | Avg PnL |`);
    lines.push(`|----------|--------|----------|----------|---------|`);
    for (const [id, s] of Object.entries(perf.strategies)) {
      lines.push(`| ${id} | ${s.traded} | ${pct(s.win_rate)} | ${pct(s.rug_rate)} | ${s.avg_pnl_pct}% |`);
    }
  }
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildHunterStats() {
  const hp = readJson(path.join(ROOT, "hunter-performance.json"));
  const lines = [`## 5. Kualitas Hunter Sources\n`];
  if (!hp?.sources || Object.keys(hp.sources).length === 0) {
    lines.push(`*Belum ada data hunter performance.*\n`);
  } else {
    lines.push(`| Source | Found | Won | Lost | Rugged | Win Rate | Rug Rate |`);
    lines.push(`|--------|-------|-----|------|--------|----------|----------|`);
    for (const [src, s] of Object.entries(hp.sources)) {
      lines.push(`| ${src} | ${s.found} | ${s.won} | ${s.lost} | ${s.rugged} | ${pct(s.win_rate)} | ${pct(s.rug_rate)} |`);
    }
  }
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildEpisodicMemory() {
  const em = readJson(path.join(ROOT, "episodic-memory.json"))
    || readJson(path.join(ROOT, "demo", "episodic-memory.json"));
  const lines = [`## 6. Episodic Memory (Pattern Fingerprints)\n`];
  if (!em?.episodes || Object.keys(em.episodes).length === 0) {
    lines.push(`*Belum ada episodic memory. Bot perlu trade yang selesai untuk membangun pattern.*\n`);
  } else {
    lines.push(`Bot telah membangun **${Object.keys(em.episodes).length} fingerprint** dari trade history:\n`);
    for (const [key, ep] of Object.entries(em.episodes)) {
      const winRate = ep.n > 0 ? (ep.wins / ep.n) : 0;
      const avgPnl = ep.n > 0 ? (ep.pnl_sum / ep.n) : 0;
      lines.push(`- **${key}**`);
      lines.push(`  - Trades: ${ep.n} | Wins: ${ep.wins} | Win rate: ${pct(winRate)} | Avg PnL: ${avgPnl.toFixed(1)}%`);
    }
  }
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildVaultProposals() {
  const vp = readJson(path.join(ROOT, "vault-proposals.json"));
  const lines = [`## 7. Vault Proposals (Saran Bot ke Operator)\n`];
  if (!vp) {
    lines.push(`*Vault proposal engine belum pernah berjalan.*\n`);
  } else {
    const pending = Object.values(vp.pending || {});
    const history = vp.history || [];
    const approved = history.filter(h => h.status === "approved");
    const rejected = history.filter(h => h.status === "rejected");

    lines.push(`**Summary:** ${pending.length} pending | ${approved.length} approved | ${rejected.length} rejected\n`);

    if (pending.length > 0) {
      lines.push(`### Pending (belum direspons):`);
      for (const p of pending) {
        lines.push(`- **[${p.type}]** ${p.lesson}`);
        lines.push(`  - Confidence: ${Math.round(p.confidence * 100)}% | Trades: ${p.trades}`);
      }
      lines.push(``);
    }

    if (approved.length > 0) {
      lines.push(`### Sudah Diapprove:`);
      for (const p of approved.slice(-10)) {
        lines.push(`- ✅ [${p.type}] ${p.lesson?.slice(0, 120)}`);
      }
      lines.push(``);
    }
  }
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildTradeHistory() {
  const archive = readJson(path.join(ROOT, "closed-positions-archive.json"));
  const lines = [`## 8. Riwayat Trade (Closed Positions)\n`];

  if (!archive?.positions || archive.positions.length === 0) {
    lines.push(`*Belum ada trade history tersimpan.*\n`);
  } else {
    const trades = archive.positions.slice(-30); // last 30
    const wins = trades.filter(t => t.pnl_pct > 0);
    const losses = trades.filter(t => t.pnl_pct <= 0 && !t.is_rug);
    const rugs = trades.filter(t => t.is_rug);
    const avgPnl = trades.length > 0
      ? trades.reduce((s, t) => s + (t.pnl_pct || 0), 0) / trades.length
      : 0;

    lines.push(`**${trades.length} trade terakhir:** ${wins.length} win | ${losses.length} loss | ${rugs.length} rug`);
    lines.push(`**Win rate:** ${pct(wins.length / Math.max(1, trades.length))}`);
    lines.push(`**Avg PnL:** ${avgPnl.toFixed(2)}%\n`);

    lines.push(`| Token | Strategy | PnL | Hold | Exit Reason |`);
    lines.push(`|-------|----------|-----|------|-------------|`);
    for (const t of trades.slice(-20)) {
      const rug = t.is_rug ? "🚨" : t.pnl_pct > 0 ? "✅" : "❌";
      lines.push(`| ${rug} ${t.symbol || t.mint?.slice(0, 8)} | ${t.strategy || "?"} | ${(t.pnl_pct || 0).toFixed(1)}% | ${Math.round(t.hold_minutes || 0)}m | ${(t.exit_reason || "?").slice(0, 30)} |`);
    }
  }
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildVaultNarratives() {
  const vaultDir = DEFAULT_VAULT;
  const heatFile = path.join(vaultDir, "30-Narratives", "_heat.md");
  const content = readText(heatFile);
  if (!content) return `## 9. Narrative Heat\n\n*Data narrative belum tersedia.*\n\n---\n`;
  return `## 9. Narrative Heat (Hot/Cold Narratives)\n\n${content.slice(0, 2000)}\n\n---\n`;
}

function buildSmartMoney() {
  const vaultDir = DEFAULT_VAULT;
  const smFile = path.join(vaultDir, "10-SmartMoney", "_live.md");
  const content = readText(smFile);
  if (!content) {
    // fallback to discovered-wallets.json
    const dw = readJson(path.join(ROOT, "discovered-wallets.json"));
    if (!dw) return `## 10. Smart Money Wallets\n\n*Belum ada data smart money.*\n\n---\n`;
    const wallets = Object.entries(dw).slice(0, 10);
    const lines = [`## 10. Smart Money Wallets\n`];
    lines.push(`**${Object.keys(dw).length} wallet** sedang ditrack:\n`);
    for (const [addr, w] of wallets) {
      lines.push(`- \`${addr.slice(0, 8)}...\` | score: ${(w.selection?.score || 0).toFixed(1)} | ${w.label || "?"}`);
    }
    return lines.join("\n") + "\n\n---\n";
  }
  return `## 10. Smart Money Wallets\n\n${content.slice(0, 1500)}\n\n---\n`;
}

function buildDecisionLog() {
  const vaultDir = DEFAULT_VAULT;
  const today = ymd();
  const yesterday = ymd(new Date(Date.now() - 86400000));
  const files = [
    path.join(vaultDir, "05-Decisions", `auto-${today}.md`),
    path.join(vaultDir, "05-Decisions", `auto-${yesterday}.md`),
  ];

  const lines = [`## 11. Decision Log (2 Hari Terakhir)\n`];
  let found = false;
  for (const f of files) {
    const content = readText(f);
    if (content && content.length > 50) {
      lines.push(`### ${path.basename(f, ".md")}\n`);
      lines.push(content.slice(0, 3000));
      found = true;
    }
  }
  if (!found) lines.push(`*Belum ada decision log. Bot perlu screening cycles untuk mengisi ini.*\n`);
  lines.push(``);
  return lines.join("\n") + "\n---\n";
}

function buildNotebookLMGuide() {
  return `## 12. Panduan Pertanyaan untuk NotebookLM

Berikut contoh pertanyaan yang bisa kamu ajukan di NotebookLM setelah upload file ini:

### Tentang Performa
- "Apa win rate keseluruhan bot dan strategi mana yang paling bagus?"
- "Sebutkan 5 trade terbaik dan terburuk, apa polanya?"
- "Bagaimana trend performa dari waktu ke waktu?"

### Tentang Learning
- "Apa saja aturan yang sudah dipelajari bot dari trade history?"
- "Pattern atau karakteristik token apa yang paling sering menguntungkan?"
- "Apa pola kegagalan yang harus dihindari?"

### Tentang Risk
- "Narrative atau kategori token apa yang paling sering rug?"
- "Source hunter mana yang paling banyak menghasilkan rug?"
- "Apa kondisi market yang harus dihindari untuk trading?"

### Saran Strategi
- "Berdasarkan data ini, instruksi apa yang harus ditambahkan ke operator lessons?"
- "Strategy mana yang harus mendapat bobot lebih tinggi dan kenapa?"
- "Apa 3 improvement terpenting yang bisa dilakukan operator sekarang?"

### Proposal Bot
- "Apa saja proposal yang diajukan bot tapi belum direspons?"
- "Proposal mana yang paling penting untuk di-approve?"

---

*File ini di-generate otomatis oleh Ponyou. Upload ulang untuk mendapat data terbaru.*
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generate() {
  const sections = [
    buildHeader(),
    buildBotStatus(),
    buildOperatorLessons(),
    buildLearnedRules(),
    buildStrategyPerformance(),
    buildHunterStats(),
    buildEpisodicMemory(),
    buildVaultProposals(),
    buildTradeHistory(),
    buildVaultNarratives(),
    buildSmartMoney(),
    buildDecisionLog(),
    buildNotebookLMGuide(),
  ];

  const content = sections.join("\n");

  // Ensure output dir exists
  const outDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT_FILE, content, "utf8");

  const sizeKB = Math.round(content.length / 1024);
  const wordCount = content.split(/\s+/).length;
  console.log(`✅ NotebookLM export generated:`);
  console.log(`   File: ${OUTPUT_FILE}`);
  console.log(`   Size: ${sizeKB}KB | ~${wordCount} words`);
  console.log(`   Sections: 12`);
  console.log(``);
  console.log(`📋 Cara pakai:`);
  console.log(`   1. notebooklm.google.com → New Notebook → Add Source`);
  console.log(`   2. Upload: ${OUTPUT_FILE}`);
  console.log(`   3. Tanya: "apa pattern win terbanyak?"`);
  console.log(``);
  console.log(`🔄 Untuk auto-refresh via URL:`);
  console.log(`   Push vault ke GitHub → NotebookLM add source URL:`);
  console.log(`   https://raw.githubusercontent.com/USERNAME/ponyou-brain/main/notebooklm-export.md`);

  return OUTPUT_FILE;
}

// Watch mode — re-generate setiap jam
if (WATCH_MODE) {
  console.log("👁️ Watch mode aktif — re-generate setiap jam");
  await generate();
  setInterval(generate, 60 * 60 * 1000);
} else {
  await generate();
}
