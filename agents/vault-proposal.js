/**
 * VaultProposalEngine — Bot menganalisis data learningnya sendiri dan
 * mengajukan proposal perubahan ke operator via Telegram.
 *
 * Proposal types:
 *   lesson          — tambah ke operator-lessons.md (dari learned rules / win patterns)
 *   risk_adjustment — peringatan kondisi berbahaya (loss streak, rug wave)
 *   narrative_block — blacklist narrative yang konsisten rugi
 *   source_quality  — update penilaian kualitas hunter source
 *   strategy_insight— rekomendasi strategi berdasarkan kondisi market
 *
 * Flow:
 *   analyze() → generate proposals → kirim Telegram
 *   User: /approve_vault_UUID → appendOperatorLesson() → vault update
 *   User: /reject_vault_UUID  → discarded
 *
 * Proposal hanya diajukan jika:
 *   - Belum pernah diajukan sebelumnya (dedup by content hash)
 *   - Confidence threshold terpenuhi
 *   - Cooldown antar proposal terpenuhi
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { log } from "../logger.js";
import { agentBus } from "./agent-bus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROPOSALS_FILE = process.env.PONYOU_VAULT_PROPOSALS_FILE
  || path.join(__dirname, "../vault-proposals.json");

const PROPOSAL_TIMEOUT_MS = 48 * 60 * 60 * 1000; // 48h — long enough for async review
const COOLDOWN_BETWEEN_PROPOSALS_MS = 6 * 60 * 60 * 1000; // max 1 proposal per 6h per type
const MIN_CONFIDENCE = 0.70; // 70% win rate minimum to propose a lesson

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(PROPOSALS_FILE)) return JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
  } catch {}
  return { pending: {}, history: [], lastRunAt: null };
}

function saveState(state) {
  state.lastRunAt = new Date().toISOString();
  atomicWriteJson(PROPOSALS_FILE, state);
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

// ─── Analyzers ────────────────────────────────────────────────────────────────

async function analyzeLearnedRules() {
  const proposals = [];
  try {
    const { getLearnedRulesBlock } = await import("../prompt-evolution.js");
    const rulesBlock = getLearnedRulesBlock();
    if (!rulesBlock) return proposals;

    // Parse individual rules: "- FAVOR sol: win_rate=86% avg_pnl=34% (7 trades)"
    const lines = rulesBlock.split("\n").filter(l => l.startsWith("- "));
    for (const line of lines) {
      const m = line.match(/FAVOR\s+(\S+):\s+win_rate=(\d+)%\s+avg_pnl=([\d.-]+)%\s+\((\d+)\s+trades?\)/);
      if (!m) continue;
      const [, tag, wr, avgPnl, tradeCount] = m;
      const winRate = parseInt(wr) / 100;
      const trades = parseInt(tradeCount);
      if (winRate < MIN_CONFIDENCE || trades < 5) continue;

      const lesson = `Prioritaskan entry dengan karakteristik: ${tag} (win rate ${wr}%, avg PnL +${avgPnl}%, dari ${trades} trade)`;
      proposals.push({
        type: "lesson",
        tag,
        confidence: winRate,
        trades,
        lesson,
        reason: `Bot menemukan pattern ${tag} konsisten menguntungkan: WR ${wr}% dari ${trades} trades`,
        data: { winRate, avgPnl: parseFloat(avgPnl), trades },
      });
    }
  } catch (e) {
    log("vault_proposal", `analyzeLearnedRules error: ${e.message}`);
  }
  return proposals;
}

async function analyzeStrategyPerformance() {
  const proposals = [];
  try {
    const { getStrategyPerformance } = await import("./learning-agent.js");
    const perfs = getStrategyPerformance();
    for (const p of perfs) {
      if (p.traded < 5) continue;
      // Underperforming strategy — propose caution
      if (p.win_rate < 0.35 && p.traded >= 8) {
        proposals.push({
          type: "risk_adjustment",
          tag: `strategy:${p.id}`,
          confidence: 1 - p.win_rate,
          trades: p.traded,
          lesson: `Kurangi ukuran entry saat menggunakan strategy ${p.id} — win rate rendah: ${(p.win_rate * 100).toFixed(0)}% dari ${p.traded} trades, avg PnL ${p.avg_pnl_pct}%`,
          reason: `Strategy ${p.id} underperforming: WR ${(p.win_rate * 100).toFixed(0)}% (${p.traded} trades)`,
          data: p,
        });
      }
      // Strong strategy — propose focus
      if (p.win_rate > 0.75 && p.traded >= 10) {
        proposals.push({
          type: "strategy_insight",
          tag: `strategy_good:${p.id}`,
          confidence: p.win_rate,
          trades: p.traded,
          lesson: `Strategy ${p.id} terbukti menguntungkan — pertimbangkan prioritas: WR ${(p.win_rate * 100).toFixed(0)}% avg PnL +${p.avg_pnl_pct}%`,
          reason: `Strategy ${p.id} outperforming: WR ${(p.win_rate * 100).toFixed(0)}% dari ${p.traded} trades`,
          data: p,
        });
      }
    }
  } catch {}
  return proposals;
}

async function analyzeNarrativeHeat() {
  const proposals = [];
  try {
    const { recordRuggedNarrativesForExit, getNarrativeHeat } = await import("../narrative-contagion.js");
    const heat = getNarrativeHeat?.();
    if (!heat?.rugged?.length) return proposals;

    // Narrative with multiple rugs
    for (const n of heat.rugged.slice(0, 3)) {
      if ((n.rug_count || 0) >= 2) {
        proposals.push({
          type: "narrative_block",
          tag: `narrative:${n.narrative}`,
          confidence: Math.min(0.95, 0.6 + n.rug_count * 0.1),
          trades: n.rug_count,
          lesson: `Hindari narrative "${n.narrative}" — ${n.rug_count}x rug terdeteksi, tambah ke blacklist_narratives`,
          reason: `Narrative ${n.narrative} menghasilkan ${n.rug_count} rug, 0 win`,
          data: n,
        });
      }
    }
  } catch {}
  return proposals;
}

async function analyzeHunterSources() {
  const proposals = [];
  try {
    const { getLearningStats } = await import("./learning-agent.js");
    const stats = getLearningStats();
    const ranking = stats.hunter_ranking || [];

    for (const src of ranking) {
      if (src.found < 20) continue;
      const closed = (src.won || 0) + (src.lost || 0) + (src.rugged || 0);
      if (closed < 10) continue;

      if (src.rug_rate > 0.5) {
        proposals.push({
          type: "source_quality",
          tag: `source_bad:${src.source}`,
          confidence: src.rug_rate,
          trades: closed,
          lesson: `Source "${src.source}" memiliki rug rate tinggi: ${(src.rug_rate * 100).toFixed(0)}% dari ${closed} trades — pertimbangkan menaikkan threshold atau hati-hati dengan token dari source ini`,
          reason: `Hunter source ${src.source}: rug ${(src.rug_rate * 100).toFixed(0)}%, win ${(src.win_rate * 100).toFixed(0)}%`,
          data: src,
        });
      }
      if (src.win_rate > 0.65 && src.rug_rate < 0.15) {
        proposals.push({
          type: "source_quality",
          tag: `source_good:${src.source}`,
          confidence: src.win_rate,
          trades: closed,
          lesson: `Source "${src.source}" terbukti berkualitas: win rate ${(src.win_rate * 100).toFixed(0)}%, rug rate rendah ${(src.rug_rate * 100).toFixed(0)}% — bisa diberikan bobot lebih tinggi`,
          reason: `Hunter source ${src.source} outperforming: WR ${(src.win_rate * 100).toFixed(0)}%`,
          data: src,
        });
      }
    }
  } catch {}
  return proposals;
}

async function analyzeAdaptiveRisk() {
  const proposals = [];
  try {
    const { getConsecutiveLosses } = await import("../trading-plan.js");
    const losses = getConsecutiveLosses();
    if (losses >= 3) {
      proposals.push({
        type: "risk_adjustment",
        tag: `consecutive_losses:${losses}`,
        confidence: 0.9,
        trades: losses,
        lesson: `⚠️ Peringatan: ${losses} kerugian berturut-turut terdeteksi. Pertimbangkan: pause trading sementara atau kurangi ukuran hingga ada win`,
        reason: `${losses} consecutive losses — trading cooldown direkomendasikan`,
        data: { consecutive_losses: losses },
      });
    }
  } catch {}
  return proposals;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class VaultProposalEngine {
  #sendTelegram;
  #pending = new Map(); // id → { resolve, timer, proposal }
  #getConfig;           // optional fn() → config — for proposal gate check

  constructor({ sendTelegram, getConfig = null }) {
    this.#sendTelegram = sendTelegram;
    this.#getConfig = getConfig;
  }

  // Check if proposal gate is enabled (requires operator approve).
  // Reads user-config.json FRESH each call so /autonomy toggle takes effect
  // without a bot restart. Falls back to the static config object.
  // When false: auto-apply all proposals without Telegram approval.
  #isGateEnabled() {
    // Fresh read from disk (hot-reload path)
    try {
      const ucPath = path.join(__dirname, "../user-config.json");
      if (fs.existsSync(ucPath)) {
        const uc = JSON.parse(fs.readFileSync(ucPath, "utf8"));
        if (uc.autonomyMode === "full_auto") return false;
        if (uc.vaultProposalEnabled === false) return false;
        return true;
      }
    } catch {}
    // Fallback: static config object
    try {
      const cfg = this.#getConfig?.();
      if (cfg?.autonomyMode === "full_auto") return false;
      if (cfg?.vault?.proposalEnabled === false) return false;
    } catch {}
    return true; // default: gate ON (safe)
  }

  // ── NotebookLM query → generate proposals from AI analysis ──────────────
  async analyzeWithNotebookLM(notebookId) {
    try {
      const { nlmAsk, isNlmConfigured } = await import("../tools/notebooklm.js");
      if (!isNlmConfigured()) {
        log("vault_proposal", "NotebookLM not configured — skipping NLM analysis");
        return 0;
      }

      const questions = [
        "Berdasarkan data ini, pola atau karakteristik token apa yang paling konsisten menguntungkan? Jawab dalam 1-2 kalimat singkat.",
        "Apakah ada narrative atau kategori token yang harus dihindari karena sering rugi atau rug? Jawab dalam 1 kalimat.",
        "Instruksi spesifik apa yang harus ditambahkan ke operator lessons untuk meningkatkan win rate? Jawab dalam 1-2 instruksi konkret.",
        "Apakah ada peringatan risiko yang terdeteksi dari data trading ini? Jawab singkat.",
      ];

      const proposals = [];
      for (const q of questions) {
        const result = await nlmAsk(notebookId, q);
        if (!result?.answer || result.answer.length < 20) continue;

        const lesson = `[NotebookLM] ${result.answer.trim()}`;
        proposals.push({
          type: "lesson",
          tag: `nlm:${contentHash(q).slice(0, 6)}`,
          confidence: 0.75,
          trades: 0,
          lesson,
          reason: `Analisis NotebookLM atas pertanyaan: "${q.slice(0, 60)}..."`,
          data: { question: q, answer: result.answer },
        });
      }

      if (proposals.length === 0) return 0;

      let submitted = 0;
      const state = loadState();
      const gateEnabled = this.#isGateEnabled();
      const now = Date.now();

      for (const p of proposals) {
        const hash = contentHash(p.lesson);
        if (state.history.some(h => h.hash === hash)) continue;
        if (Object.values(state.pending).some(pend =>
          pend.hash === hash || (p.tag && pend.tag === p.tag))) continue;

        const id = `vault_${crypto.randomUUID().slice(0, 8)}`;
        const proposal = { id, hash, ...p, ts: now, status: "pending", source: "notebooklm" };

        if (!gateEnabled) {
          proposal.status = "auto_approved";
          proposal.resolvedAt = now;
          state.history.push(proposal);
          saveState(state);
          await this._applyProposal(proposal);
          submitted++;
          continue;
        }

        state.pending[id] = proposal;
        saveState(state);
        await this._sendProposal(proposal);
        submitted++;
      }

      log("vault_proposal", `NotebookLM analysis: ${submitted} proposals from ${questions.length} questions`);
      return submitted;
    } catch (e) {
      log("vault_proposal_error", `analyzeWithNotebookLM failed: ${e.message}`);
      return 0;
    }
  }

  // ── Analyze + propose ────────────────────────────────────────────────────
  async analyze() {
    const state = loadState();
    const now = Date.now();

    // Gather proposals from all analyzers
    const rawProposals = [
      ...(await analyzeLearnedRules()),
      ...(await analyzeStrategyPerformance()),
      ...(await analyzeNarrativeHeat()),
      ...(await analyzeHunterSources()),
      ...(await analyzeAdaptiveRisk()),
    ];

    const gateEnabled = this.#isGateEnabled();
    let submitted = 0;
    for (const p of rawProposals) {
      const hash = contentHash(p.lesson);

      // Dedup: skip if already in history
      if (state.history.some(h => h.hash === hash)) continue;

      // Cooldown: skip if same type proposed recently
      const lastOfType = state.history
        .filter(h => h.type === p.type)
        .sort((a, b) => b.ts - a.ts)[0];
      if (lastOfType && (now - lastOfType.ts) < COOLDOWN_BETWEEN_PROPOSALS_MS) continue;

      // Skip if already pending — match by content hash OR stable tag. The
      // lesson text embeds changing counts ("rug 100% dari 102/7131/10186
      // trades"), so hash alone re-proposed the same insight every cycle
      // (measured 2026-06-11: 22 identical source_quality proposals pending).
      if (Object.values(state.pending).some(pend =>
        pend.hash === hash || (p.tag && pend.tag === p.tag))) continue;

      const id = `vault_${crypto.randomUUID().slice(0, 8)}`;
      const proposal = { id, hash, ...p, ts: now, status: "pending" };

      // Gate OFF → auto-apply immediately without Telegram approval
      if (!gateEnabled) {
        proposal.status = "auto_approved";
        proposal.resolvedAt = now;
        state.history.push(proposal);
        saveState(state);
        await this._applyProposal(proposal);
        log("vault_proposal", `Auto-applied (gate off): "${proposal.lesson.slice(0, 60)}"`);
        submitted++;
        continue;
      }

      state.pending[id] = proposal;
      saveState(state);

      await this._sendProposal(proposal);
      submitted++;
    }

    if (submitted > 0) log("vault_proposal", `Submitted ${submitted} new vault proposals`);
    else log("vault_proposal", "analyze: no new proposals (all deduped or below threshold)");

    return submitted;
  }

  async _sendProposal(proposal) {
    const typeEmoji = {
      lesson:           "📚",
      risk_adjustment:  "⚠️",
      narrative_block:  "🚫",
      source_quality:   "📊",
      strategy_insight: "🎯",
    }[proposal.type] || "💡";

    const confPct = `${Math.round(proposal.confidence * 100)}%`;
    const lines = [
      `${typeEmoji} <b>Ponyou Proposal</b>`,
      ``,
      `<b>Tipe:</b> ${proposal.type.replace(/_/g, " ")}`,
      `<b>Confidence:</b> ${confPct} (${proposal.trades} trades)`,
      ``,
      `<b>Saran lesson:</b>`,
      `<i>${proposal.lesson}</i>`,
      ``,
      `<b>Alasan:</b> ${proposal.reason}`,
      ``,
      `Approve → <code>/approve_${proposal.id}</code>`,
      `Reject  → <code>/reject_${proposal.id}</code>`,
    ];

    await this.#sendTelegram(lines.join("\n")).catch(e =>
      log("vault_proposal", `sendTelegram failed: ${e.message}`)
    );

    // Set timeout — auto-reject after 48h
    const timer = setTimeout(() => {
      this._expireProposal(proposal.id);
    }, PROPOSAL_TIMEOUT_MS);

    this.#pending.set(proposal.id, { timer, proposal });
    log("vault_proposal", `Proposal sent: ${proposal.id} (${proposal.type}) — "${proposal.lesson.slice(0, 60)}..."`);
  }

  _expireProposal(id) {
    const entry = this.#pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(id);

    const state = loadState();
    if (state.pending[id]) {
      state.history.push({ ...state.pending[id], status: "expired", resolvedAt: Date.now() });
      delete state.pending[id];
      saveState(state);
    }
    log("vault_proposal", `Proposal ${id} expired (48h timeout)`);
  }

  // ── Operator response ─────────────────────────────────────────────────────
  async handleResponse(id, approved) {
    const state = loadState();
    const proposal = state.pending[id];
    if (!proposal) return false;

    // Clear in-memory timer
    const memEntry = this.#pending.get(id);
    if (memEntry) {
      clearTimeout(memEntry.timer);
      this.#pending.delete(id);
    }

    proposal.status = approved ? "approved" : "rejected";
    proposal.resolvedAt = Date.now();
    state.history.push(proposal);
    delete state.pending[id];
    saveState(state);

    if (approved) {
      await this._applyProposal(proposal);
    } else {
      log("vault_proposal", `Proposal ${id} rejected by operator`);
    }

    agentBus.emit("vault_proposal:resolved", { id, approved, proposal });
    return true;
  }

  async _applyProposal(proposal) {
    try {
      const { appendOperatorLesson } = await import("../tools/vault-writer.js");
      const lessonText = `[${proposal.type.toUpperCase()}] ${proposal.lesson}\n(confidence: ${Math.round(proposal.confidence * 100)}%, ${proposal.trades} trades, auto-proposed ${new Date(proposal.ts).toISOString().slice(0, 10)})`;
      await appendOperatorLesson(lessonText, "bot");

      const confirmLines = [
        `✅ <b>Proposal disetujui</b>`,
        ``,
        `Lesson berhasil ditambahkan ke vault:`,
        `<i>${proposal.lesson.slice(0, 150)}</i>`,
        ``,
        `Bot akan membaca lesson ini di screening cycle berikutnya.`,
      ];
      await this.#sendTelegram(confirmLines.join("\n")).catch(() => {});
      log("vault_proposal", `Proposal ${proposal.id} approved + written to vault: "${proposal.lesson.slice(0, 60)}"`);
    } catch (e) {
      log("vault_proposal_error", `Failed to apply proposal ${proposal.id}: ${e.message}`);
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  getDashboard() {
    const state = loadState();
    const pending = Object.values(state.pending);
    const history = state.history.slice(-20);
    return {
      pending_count: pending.length,
      pending: pending.map(p => ({
        id: p.id, type: p.type, confidence: p.confidence,
        lesson_preview: p.lesson.slice(0, 80),
        ts: p.ts,
      })),
      history_count: history.length,
      approved: history.filter(h => h.status === "approved").length,
      rejected: history.filter(h => h.status === "rejected").length,
      last_run: state.lastRunAt,
    };
  }

  // ── Restore pending on restart ────────────────────────────────────────────
  restorePending() {
    const state = loadState();
    const now = Date.now();
    for (const [id, proposal] of Object.entries(state.pending)) {
      const remaining = PROPOSAL_TIMEOUT_MS - (now - proposal.ts);
      if (remaining <= 0) {
        this._expireProposal(id);
        continue;
      }
      const timer = setTimeout(() => this._expireProposal(id), remaining);
      this.#pending.set(id, { timer, proposal });
    }
    const count = this.#pending.size;
    if (count > 0) log("vault_proposal", `Restored ${count} pending proposal(s) from disk`);
    return count;
  }
}
