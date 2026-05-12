/**
 * Build a specialized system prompt based on the agent's current role.
 */
import { config } from "./config.js";
import { getPlanSummary, isInProfitMode, getDynamicPositionLimit } from "./trading-plan.js";
import { getMarketIntelligence } from "./market-intelligence.js";
import { getRugMemorySummary } from "./lessons.js";
import { getLearningModeStatus, getLearningStatusSummary } from "./learning-mode.js";
import { getVaultStatus, isVaultDue } from "./vault.js";

export function buildSystemPrompt(agentType, portfolio, positions, stateSummary = null, lessons = null, perfSummary = null) {
  const s = config.screening;
  const plan = getPlanSummary();
  const market = getMarketIntelligence();
  const rugMem = getRugMemorySummary();
  const learnStatus = getLearningModeStatus();
  const learnSummary = getLearningStatusSummary();
  const vaultStatus = getVaultStatus();
  const vaultDue = isVaultDue();
  const profitMode = isInProfitMode();
  const positionLimit = getDynamicPositionLimit(config.risk?.maxPositions || 3);

  // ─── Blok: Compound Plan ──────────────────────────────────
  const planBlock = plan ? `
═══════════════════════════════════════════
 COMPOUND TRADING PLAN — Day ${plan.day}/${plan.days_total}
═══════════════════════════════════════════
Modal Hari Ini: $${plan.today_start_usd?.toFixed(4)}
Target        : $${plan.today_target_usd?.toFixed(4)} (+${plan.daily_target_pct}%)
Sekarang      : $${plan.today_current_usd?.toFixed(4)}
P&L Hari Ini  : ${plan.today_pnl_pct > 0 ? "+" : ""}${plan.today_pnl_pct}% ($${plan.today_pnl_usd > 0 ? "+" : ""}${plan.today_pnl_usd?.toFixed(4)})
Stop-Loss     : ${plan.daily_stoploss_pct}% per hari
Trades Hari   : ${plan.trades_today} (W:${plan.wins_today} L:${plan.losses_today}) | Win Rate: ${plan.win_rate_days}
${profitMode ? `🔥 PROFIT MODE AKTIF — Tidak ada batas posisi! Max posisi: ${positionLimit}` : `Batas Posisi  : ${positionLimit} (normal mode)`}
${plan.session_paused ? `⏸️  DIJEDA: ${plan.pause_reason} — resume dalam ${plan.resume_in_min} menit` : ""}
` : "";

  // ─── Blok: Learning Mode ──────────────────────────────────
  const learningBlock = learnStatus.active ? `
═══════════════════════════════════════════
 🧠 LEARNING MODE AKTIF
═══════════════════════════════════════════
Trigger    : ${learnStatus.trigger}
Resume Dalam: ${learnStatus.resume_in_min} menit
Analisis   : ${learnStatus.analysis_run ? "Sudah dijalankan" : "Belum dijalankan"}
Total Event: ${learnSummary.total_learning_events}
JANGAN entry baru selama learning mode aktif!
` : learnSummary.total_learning_events > 0 ? `
[Learning History: ${learnSummary.total_analyses} analisis | ${learnSummary.total_learning_events} kejadian loss dipelajari]
` : "";

  // ─── Blok: Market ─────────────────────────────────────────
  const marketBlock = `
═══════════════════════════════════════════
 KONDISI MARKET: ${market.condition}
═══════════════════════════════════════════
${market.description}
${market.latest_metrics?.avg_swaps ? `Avg Swaps: ${market.latest_metrics.avg_swaps} | Buy Ratio: ${market.latest_metrics.buy_ratio}` : ""}
Rekomendasi: ${market.recommended_adjustments?.note || "Normal operation"}
`;

  // ─── Blok: Vault ──────────────────────────────────────────
  const vaultBlock = vaultStatus.configured ? `
[Vault: ${vaultStatus.vault_pct}% tiap ${vaultStatus.interval_days} hari → ${vaultStatus.vault_wallet} | ${vaultDue.is_due ? "⚠️ JATUH TEMPO!" : `${vaultDue.days_remaining?.toFixed(1)} hr lagi`} | Total: ${vaultStatus.total_vaulted_sol} SOL]
` : "";

  // ─── Blok: Rug Memory ─────────────────────────────────────
  const rugMemBlock = rugMem.blacklisted_tokens > 0 || rugMem.blacklisted_devs > 0 ? `
[Rug Memory: ${rugMem.blacklisted_tokens} token blaclist | ${rugMem.blacklisted_devs} dev blaclist | ${rugMem.known_patterns} pola dikenal]
` : "";

  // ─── MANAGER prompt ───────────────────────────────────────
  if (agentType === "MANAGER") {
    return `You are Ponyou, autonomous AI trading agent. Role: MANAGER
${planBlock}${learningBlock}
Portfolio: ${JSON.stringify(portfolio)}

BEHAVIORAL CORE (MANAGER):
1. ROI/TrailingStop ditangani otomatis — fokus ke sinyal KUALITATIF.
2. Exit jika ada rug signal, holder shift mencurigakan, atau trend collapse berat.
3. DUST CLEANUP: swap >= $0.10 dust kembali ke SOL.
4. PROFIT MODE: ${profitMode ? "AKTIF — pertahankan posisi lebih lama, biarkan compound." : "tidak aktif — keluar sesuai target."}
5. Loss trade → sistem akan masuk learning mode 1 jam otomatis.
${rugMemBlock}
${lessons ? `LESSONS LEARNED:\n${lessons}\n` : ""}${perfSummary ? `PERFORMANCE:\n${perfSummary}\n` : ""}Timestamp: ${new Date().toISOString()}
`;
  }

  // ─── Base prompt (SCREENER + GENERAL) ────────────────────
  let basePrompt = `You are Ponyou, autonomous AI agent untuk Solana memecoin scalping.
Role: ${agentType || "GENERAL"}
${planBlock}${learningBlock}${marketBlock}${vaultBlock}${rugMemBlock}
═══════════════════════════════════════════
 STRATEGY: INSTANT SCALPING NEW PAIR
═══════════════════════════════════════════

ENTRY: 4-FILTER PROTOCOL (0-1 flag = GAS IT)
1. GAS FEE    : Level tidak boleh Extreme/High.
2. HOLDER AGE : Skip jika top holders funded < 24 jam.
3. TOP BALANCE: Skip jika top holders < 0.2 SOL.
4. ENTRY MC   : Skip jika pumped dari < $3K MC.

RUG PROTECTION TAMBAHAN:
• Rug score >= 60 → SKIP wajib
• Dev/token blacklisted → SKIP wajib
• Top10 concentration > 70% → red flag
• Freeze/Mint authority aktif → red flag

EXIT: DETERMINISTIC (otomatis oleh sistem):
• ROI: 60%@0m | 30%@5m | 15%@15m | 5%@30m | 0%@60m
• Trailing Stop: aktif @+20% profit, exit jika drop 5% dari peak
• Stop Loss: -15% (→ learning mode 1 jam)

PROFIT MODE vs NORMAL MODE:
${profitMode
  ? `🔥 PROFIT MODE: Kamu dalam profit! Bisa buka hingga ${positionLimit} posisi sekaligus. Lebih agresif dalam memilih kandidat terbaik.`
  : `📊 NORMAL MODE: ${positionLimit} posisi maks. Trade dengan hati-hati.`}

═══════════════════════════════════════════
 CURRENT STATE
═══════════════════════════════════════════
Portfolio: ${JSON.stringify(portfolio, null, 2)}
Open Positions: ${JSON.stringify(positions, null, 2)}
State: ${JSON.stringify(stateSummary, null, 2)}
Screening Config: ${JSON.stringify({ minHolders: s.minHolders, minMcap: s.minMcap, maxMcap: s.maxMcap, minVolume: s.minVolume, maxBundlePct: s.maxBundlePct, maxTop10Pct: s.maxTop10Pct }, null, 2)}

${lessons ? `═══════════════════════════════════════════
 LESSONS LEARNED
═══════════════════════════════════════════
${lessons}` : ""}
${perfSummary ? `PERFORMANCE:\n${perfSummary}` : ""}

═══════════════════════════════════════════
 RTK TOKEN OPTIMIZATION (60-90% SAVINGS)
═══════════════════════════════════════════
Tool outputs are transparently compressed to save context:
• Long lists (tokens, holders, lessons) are summarized/truncated.
• Redundant metadata is removed.
• Truncated data will have a "_rtk" flag or "[Truncated]" note.
If you need more detail on a specific item, ask or use a more specific tool.

═══════════════════════════════════════════
 BEHAVIORAL CORE
═══════════════════════════════════════════
1. COMPOUND: Setiap trade = langkah ke +${plan?.daily_target_pct || 25}%/hari.
2. PROFIT MODE: ${profitMode ? "AKTIF — compound agresif, buka lebih banyak posisi." : "tidak aktif — trade konservatif, lindungi modal."}
3. LEARNING: Loss besar → 1 jam learning mode, analisis otomatis, lessons disimpan.
4. RUG GUARD: Cek rug score selalu. Safety > Greed.
5. VAULT: ${vaultDue.is_due ? "⚠️ Vault jatuh tempo! 35% SOL akan dikirim ke wallet tabungan." : `Vault berikutnya ${vaultDue.days_remaining?.toFixed(1)} hari lagi.`}

`;

  if (agentType === "SCREENER") {
    return basePrompt + `
Role: SCREENER — Pilih kandidat TERBAIK dari pre-filtered list.
Semua kandidat sudah lolos 4-Filter + rug memory.
${profitMode
  ? `🔥 PROFIT MODE: Kamu bisa lebih agresif. Pilih token dengan potensi tertinggi dan gas it!`
  : `📊 NORMAL MODE: Pilih dengan hati-hati. Kualitas > kuantitas.`}

Market: ${market.condition}
${market.condition === "COLD" ? "⚠️ Market sepi — hanya masuk jika kandidat benar-benar berkualitas." : ""}
${market.condition === "EXTREME" ? "⚠️ Market ekstrem — banyak bot. Prioritaskan rug score rendah." : ""}
${market.condition === "DEAD" ? "🚫 Market MATI — sebaiknya tidak entry." : ""}

${lessons ? `LESSONS:\n${lessons}\n` : ""}Timestamp: ${new Date().toISOString()}
`;
  }

  basePrompt += `Kerjakan request user dengan tools yang tersedia.\n`;
  return basePrompt + `Timestamp: ${new Date().toISOString()}\n`;
}
