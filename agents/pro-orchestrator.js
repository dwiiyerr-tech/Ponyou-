/**
 * Pro Orchestrator — Elite Full Automation Brain
 *
 * ACTIVATES ONLY AFTER:
 *   1. All 8 automation qualification requirements met
 *   2. User approved via Telegram (/approve_automation)
 *   3. 1000+ hours market exposure accumulated
 *
 * Once active, this layer has DEEP access to ALL experience data:
 *   - Conviction memory (coin + narrative patterns)
 *   - Trade attribution (why trades won/lost)
 *   - Regime memory (which regimes produce best returns)
 *   - Lessons learned (what went wrong, what worked)
 *   - Strategy performance (which strategies win in which conditions)
 *   - Execution quality (slippage, timing, provider performance)
 *   - Smart wallet intelligence (who's trading what)
 *   - Narrative velocity (what's trending, what's dying)
 *
 * CAPABILITIES:
 *   - Auto-select best strategy per market regime from performance data
 *   - Auto-create new strategies by combining winning patterns
 *   - Auto-BUY with conviction-weighted Kelly sizing
 *   - Auto-SELL on multi-signal convergence (not just single threshold)
 *   - Auto-SKIP when risk/reward doesn't meet pro threshold
 *   - Auto-CUTLOSS at optimal levels from historical loss patterns
 *   - Strategy rotation when win rate degrades
 *   - Narrative-aware position sizing
 *   - Correlation-aware portfolio management
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { isAutomationActive } from "./automation-rules.js";
import { log } from "../logger.js";
import { evaluateCastNet } from "../tools/cast-net-gate.js";
import { getActiveStrategy } from "../strategies.js";
import { scoreTrash } from "../tools/trash-filter.js";
import { getExperienceScore } from "../conviction-memory.js";
import { getAllWallets } from "../tools/wallet-manager.js";
import { config as _runtimeConfig } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const AGENT_NAME = "pro-orchestrator";

let _initialized = false;
let _proModeActive = false;
let _validationMode = false;
let _tradesSinceLastAnalysis = 0;
let _analysisCache = null;
let _analysisCacheTime = 0;
let _consecutiveErrors = 0;
const ANALYSIS_CACHE_TTL_MS = 120_000; // 2 min — matches orchestrator cycle
const MAX_CONSECUTIVE_ERRORS = 5;      // auto-suspend pro mode after this many errors

function proValidationModeEnabled() {
  const requested = process.env.PRO_VALIDATION_MODE === "true" || _runtimeConfig.pro?.validationMode === true;
  const demoSafe = process.env.EXECUTION_MODE === "demo" && process.env.DRY_RUN === "true";
  return requested && demoSafe;
}

/**
 * In validation mode, pro decisions are SHADOW-ONLY: logged but do NOT veto.
 * Only full pro mode (all 8 requirements + manual approval) vetoes entries.
 * This allows safe testing of pro logic without blocking the screening pipeline.
 */
export function isProValidationMode() {
  return _validationMode;
}

// ─── Pro Decision Thresholds (configurable via user-config) ───────────────

function _buildThresholds() {
  const cfg = _runtimeConfig.pro || {};
  return {
    buy: {
      minConvictionScore:       cfg.minConvictionScore       ?? 65,
      minSignalAggregate:       cfg.minSignalAggregate       ?? 55,
      minKellyEdge:             cfg.minKellyEdge             ?? 0.08,
      maxRugScore:              cfg.maxRugScore              ?? 25,
      requiredSignalsConverging: cfg.requiredSignals         ?? 4,
      minLiquidityUSD:          cfg.minLiquidityUsd          ?? 2000,
      maxVolatilityPercentile:  cfg.maxVolatilityPercentile  ?? 80,
      requireNarrativeVelocity: cfg.requireNarrativeVelocity ?? false,
    },

  // SELL: multi-signal exit triggers
  sell: {
    convictionDecayThreshold: -20,    // conviction dropped 20+ points
    narrativeDeathThreshold: -15,      // narrative velocity dropped 15+
    regimeDowngradeExit: true,        // exit when regime goes DEAD
    minHoldMinutesForReview: 5,       // don't review positions < 5min old
    trailingActivationPnL: 8,         // activate trailing after 8% profit
    profitSweepPnL: 45,               // sweep 50% of position at 45% profit
  },

  // SKIP: conditions that override BUY signal
  skip: {
    marketDeadOrExtreme: true,
    maxDrawdownActive: true,
    dailyLossLimitReached: true,
    consecutiveLossStreak: 3,         // skip after 3 consecutive losses
    lowConfidenceRegime: true,        // skip if regime confidence < 40%
  },

    // CUTLOSS: adaptive cut-loss based on historical patterns
    cutloss: {
      fastFailureMinutes: 8,            // cut if down -8% in < 8 min
      fastFailurePnL: -8,
      standardCutLossPnL: -15,          // standard hard cut
      convictionCollapsePnL: -10,       // cut sooner if conviction collapses
      regimeAdjustedCutLoss: {
        HOT: -18,    // wider stops in volatile markets
        NORMAL: -15,
        COLD: -10,   // tighter stops in thin markets
        DEAD: -5,     // immediate exit
      },
    },
  };
}

// Backward-compatible static snapshot (defaults). Live decisions use
// _buildThresholds() so user-config.pro overrides apply without restart.
const PRO_THRESHOLDS = _buildThresholds();

// ─── Data Loaders ─────────────────────────────────────────────

function tryReadJson(filename) {
  try {
    const fp = path.join(PROJECT_ROOT, filename);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { return null; }
}

// ─── Pro Analysis Engine ──────────────────────────────────────

/**
 * Analyze ALL historical data to find winning patterns.
 * Returns intelligence that feeds into pro decisions.
 */
export function runProAnalysis() {
  if (!_proModeActive) return null;

  // Return cached result if still fresh
  if (_analysisCache && (Date.now() - _analysisCacheTime) < ANALYSIS_CACHE_TTL_MS) {
    return _analysisCache;
  }

  try {
  const intelligence = {
    analyzedAt: new Date().toISOString(),
    regimes: {},
    narratives: {},
    conviction: {},
    strategies: {},
    execution: {},
    recommendations: [],
  };

  // PO-4/PO-5: minimum sample thresholds for recommendation labels.
  // Without these, a 1-win/1-trade regime got tagged "PREFERRED" purely
  // from noise, and a narrative with obs=100, rugs=2 (2% rug rate) got
  // tagged "AVOID" just because the absolute count crossed 2.
  const MIN_REGIME_TRADES = 10;
  const MIN_NARRATIVE_OBS = 10;
  const HIGH_RUG_RATE = 0.10;        // 10% rug rate triggers AVOID

  // 1. Regime analysis — which regimes produce best returns?
  const regimeMem = tryReadJson("regime-memory.json") || {};
  const regimes = regimeMem.regimes || regimeMem.observations || {};
  for (const [name, data] of Object.entries(regimes)) {
    const trades = data.trades || data.observation_count || 0;
    const wins = data.wins || 0;
    const wr = trades > 0 ? wins / trades : 0;
    const avgPnl = data.avg_pnl_pct || data.cumulative_pnl || 0;
    const hasSample = trades >= MIN_REGIME_TRADES;
    intelligence.regimes[name] = {
      trades,
      winRate: wr,
      avgPnl,
      score: wr * 0.6 + (avgPnl > 0 ? 0.4 : 0),
      recommendation: !hasSample ? "INSUFFICIENT_DATA"
        : wr >= 0.55 ? "PREFERRED"
        : wr >= 0.40 ? "NEUTRAL"
        : "AVOID",
    };
  }

  // 2. Narrative analysis — which narratives win most?
  const conviction = tryReadJson("coin-conviction.json") || {};
  const narratives = conviction.narratives || {};
  for (const [name, data] of Object.entries(narratives)) {
    const obs = data.observation_count || 0;
    const wins = data.win_count || 0;
    const gems = data.gem_count || 0;
    const rugs = data.rug_count || 0;
    const wr = obs > 0 ? wins / obs : 0;
    const rugRate = obs > 0 ? rugs / obs : 0;
    const hasSample = obs >= MIN_NARRATIVE_OBS;
    intelligence.narratives[name] = {
      observations: obs,
      winRate: wr,
      gems,
      rugs,
      riskScore: rugRate,
      recommendation: !hasSample ? "INSUFFICIENT_DATA"
        : wr >= 0.50 && rugRate === 0 ? "STRONG_BUY"
        : wr >= 0.40 ? "BUY"
        : rugRate >= HIGH_RUG_RATE ? "AVOID"   // PO-5: rate, not absolute count
        : "NEUTRAL",
    };
  }

  // 3. Strategy performance
  const strategyReg = tryReadJson("data/strategy-registry.json") || {};
  const strategies = strategyReg.strategies || strategyReg.entries || [];
  for (const strat of strategies) {
    const trades = strat.live_trades || strat.trades || 0;
    const wr = strat.live_win_rate || strat.win_rate || 0;
    const pf = strat.live_profit_factor || strat.profit_factor || 0;
    intelligence.strategies[strat.id || strat.name] = {
      trades,
      winRate: wr,
      profitFactor: pf,
      status: strat.status || "unknown",
      recommendation: pf >= 1.15 && wr >= 0.50 ? "ACTIVE"
        : pf >= 1.0 ? "WATCH"
        : "DEGRADED",
    };
  }

  // 4. Execution quality analysis
  const execQual = tryReadJson("execution-quality-memory.json") || {};
  const providers = execQual.providers || execQual.entries || [];
  const providerStats = {};
  for (const p of providers) {
    const name = p.provider || p.name || "unknown";
    if (!providerStats[name]) providerStats[name] = { attempts: 0, successes: 0, totalLatency: 0 };
    providerStats[name].attempts++;
    if (p.success) providerStats[name].successes++;
    providerStats[name].totalLatency += p.latency_ms || 0;
  }
  for (const [name, stats] of Object.entries(providerStats)) {
    intelligence.execution[name] = {
      successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
      avgLatencyMs: stats.attempts > 0 ? stats.totalLatency / stats.attempts : 0,
    };
  }

  // 5. Generate pro recommendations
  const topRegime = Object.entries(intelligence.regimes)
    .sort(([,a], [,b]) => (b.score || 0) - (a.score || 0))[0];
  const topNarrative = Object.entries(intelligence.narratives)
    .filter(([,d]) => d.recommendation === "STRONG_BUY" || d.recommendation === "BUY")
    .sort(([,a], [,b]) => (b.winRate || 0) - (a.winRate || 0))[0];
  const bestStrategy = Object.entries(intelligence.strategies)
    .filter(([,d]) => d.recommendation === "ACTIVE")
    .sort(([,a], [,b]) => (b.profitFactor || 0) - (a.profitFactor || 0))[0];

  if (topRegime) {
    intelligence.recommendations.push({
      type: "regime_preference",
      detail: `Best regime: ${topRegime[0]} (WR: ${(topRegime[1].winRate * 100).toFixed(0)}%)`,
    });
  }
  if (topNarrative) {
    intelligence.recommendations.push({
      type: "narrative_preference",
      detail: `Best narrative: ${topNarrative[0]} (WR: ${(topNarrative[1].winRate * 100).toFixed(0)}%)`,
    });
  }
  if (bestStrategy) {
    intelligence.recommendations.push({
      type: "strategy_preference",
      detail: `Best strategy: ${bestStrategy[0]} (PF: ${bestStrategy[1].profitFactor?.toFixed(2)})`,
    });
  }

  _analysisCache = intelligence;
  _analysisCacheTime = Date.now();
  _consecutiveErrors = 0;          // reset error counter on a clean analysis
  return intelligence;
  } catch (e) {
    _consecutiveErrors++;
    log("pro_orchestrator_error", `Analysis failed (${_consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${e.message}`);
    if (_consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      _proModeActive = false;
      setAgentStatus(AGENT_NAME, "stopped", `Auto-suspended after ${MAX_CONSECUTIVE_ERRORS} consecutive analysis errors`);
      log("pro_orchestrator", "AUTO-SUSPEND: pro mode disabled — screening pipeline continues without pro gate");
    }
    return null;
  }
}

export function clearProAnalysisCache() {
  _analysisCache = null;
  _analysisCacheTime = 0;
}

// ─── Fundamental Strategy Analyst ─────────────────────────────
//
// AGENT TIDAK BOLEH DELUSI. Sebelum menciptakan strategi baru,
// agent harus membuktikan bahwa ia punya:
//
//   1. Data nyata (bukan simulated/paper-only)
//   2. Fakta terverifikasi (PnL riil, bukan 0%)
//   3. Bukti pengalaman (multi-regime, multi-narrative)
//   4. Eksekusi bersih (slippage rendah, latency ok)
//   5. Simulasi & backtest (paper/backtest evidence)
//   6. Konsistensi profit (win rate stabil, drawdown terkendali)
//   7. Data maturity (cukup umur, bukan data segar 2 hari)
//
// TUJUH komponen — SEMUA WAJIB. Satu gagal = creation DIBLOKIR.
// Tidak ada toleransi. Agent harus MEMBUKTIKAN, bukan MENGKLAIM.

const STRATEGY_CREATION_REQUIREMENTS = {
  // Komponen 1: Trade Evidence — bukti nyata dari trading sungguhan
  tradeEvidence: {
    minClosedTrades: 50,          // minimum total closed positions (naik dari 30)
    minVerifiedTrades: 20,        // minimum trades dengan PnL TERVERIFIKASI (naik dari 10)
    minWinSamples: 10,            // minimum winning trades (naik dari 5)
    minLossSamples: 10,           // minimum losing trades (naik dari 5)
    minAvgPnlPct: -5,            // rata-rata PnL tidak boleh lebih buruk dari -5%
    maxRugRate: 0.25,            // maksimum 25% trades kena rug
  },
  // Komponen 2: Regime Competence — pengalaman di SEMUA kondisi pasar
  regimeCoverage: {
    minDistinctRegimes: 4,        // HARUS experienced di SEMUA 4 regime (naik dari 3)
    minTradesPerRegime: 5,        // minimum 5 trades per regime (naik dari 3)
    minWinRatePerRegime: 0.30,   // setiap regime minimal WR 30% (ada batas bawah)
  },
  // Komponen 3: Conviction Foundation — data keyakinan yang dalam
  convictionData: {
    minCoinObservations: 40,      // minimum koin diobservasi (naik dari 20)
    minNarrativeSamples: 15,      // minimum sampel narrative (naik dari 10)
    minAvgObservationsPerCoin: 5, // rata-rata 5 observasi per koin (naik dari 3)
    minConvictionClusters: 3,     // minimal 3 cluster naratif berbeda
  },
  // Komponen 4: Execution Quality — bukti bisa eksekusi dengan bersih
  executionQuality: {
    minRecordedSwaps: 40,         // minimum swap terekam
    maxAvgSlippagePct: 1.5,       // rata-rata slippage ≤ 1.5%
    maxAvgLatencyMs: 4000,        // rata-rata latency ≤ 4 detik
    minSuccessRate: 0.85,         // minimal 85% swap success rate
  },
  // Komponen 5: Simulation & Backtest — strategi harus diuji dulu
  simulation: {
    minBacktestTrades: 50,        // minimal 50 backtest trades
    minPaperTrades: 20,           // minimal 20 paper trade executions
    minBacktestWinRate: 0.40,     // backtest WR minimal 40%
    requireProfitFactor: 0.85,    // profit factor minimal 0.85
  },
  // Komponen 6: Profit Consistency — bukan cuma menang, tapi konsisten
  profitConsistency: {
    minOverallWinRate: 0.40,      // overall WR ≥ 40%
    maxConsecutiveLosses: 8,      // maksimum 8 loss beruntun
    maxDrawdownPct: -35,         // maksimum drawdown -35%
    minProfitFactor: 0.80,       // profit factor ≥ 0.80
    minSampleSizeForMetrics: 30, // metrik hanya valid jika ≥ 30 trades
    minHoldingAvgMinutes: 3,     // rata-rata hold time ≥ 3 menit (bukan scalp gambling)
  },
  // Komponen 7: Data Maturity — data harus cukup umur
  dataMaturity: {
    minDataAgeDays: 30,           // minimal 30 hari pengumpulan data
    minActiveStrategies: 1,       // harus punya minimal 1 strategi aktif
    maxNewStrategyCooldownHours: 72, // cooldown 72 jam antar strategi baru
    requireAtLeastOneEvolved: false, // harus ada minimal 1 strategi hasil evolusi
  },
};

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch { return null; }
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Validate apakah agent sudah punya cukup data untuk menciptakan strategi baru.
 * TUJUH komponen — SEMUA WAJIB. Satu gagal = creation DIBLOKIR.
 *
 * Returns { ready: boolean, components: { name, passed, detail }[], summary: string }
 */
export function validateStrategyReadiness() {
  const req = STRATEGY_CREATION_REQUIREMENTS;
  const components = [];
  const allTrades = [];

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 1: Trade Evidence — bukti nyata, bukan klaim
  // ═══════════════════════════════════════════════════════════════
  let tradePassed = false;
  let tradeDetail = "";
  try {
    const archive = readJsonSafe(path.join(PROJECT_ROOT, "closed-positions-archive.json"));
    const state = readJsonSafe(path.join(PROJECT_ROOT, "state.json"));
    const closedList = (Array.isArray(archive) ? archive : []);
    const stateClosed = Object.values(state?.positions || {}).filter(p => p.closed);
    const raw = [...closedList, ...stateClosed];

    // Dedup ketat — jangan sampai duplikat dihitung dua kali
    const seen = new Set();
    const unique = [];
    for (const t of raw) {
      const key = `${t.position_key || t.mint || ""}::${t.closed_at || t.deployed_at || ""}`;
      if (seen.has(key) || !t.position_key || !t.closed_at) continue;
      seen.add(key);
      unique.push(t);
      allTrades.push(t);
    }

    const verified = unique.filter(t => safeNum(t.initial_value_usd) > 0);
    const wins = verified.filter(t => safeNum(t.pnl_pct ?? t.pnlPercent) > 0);
    const losses = verified.filter(t => safeNum(t.pnl_pct ?? t.pnlPercent) < 0);
    const avgPnl = verified.length > 0
      ? verified.reduce((s, t) => s + safeNum(t.pnl_pct ?? t.pnlPercent), 0) / verified.length
      : 0;
    const rugCount = verified.filter(t =>
      /rug/i.test(t.exit_reason || t.reason || "") || t.rug_detected
    ).length;
    const rugRate = verified.length > 0 ? rugCount / verified.length : 1;

    const checks = [
      { label: "total closed", have: unique.length, need: req.tradeEvidence.minClosedTrades },
      { label: "verified PnL", have: verified.length, need: req.tradeEvidence.minVerifiedTrades },
      { label: "win samples", have: wins.length, need: req.tradeEvidence.minWinSamples },
      { label: "loss samples", have: losses.length, need: req.tradeEvidence.minLossSamples },
      { label: "avg PnL%", have: `${avgPnl.toFixed(1)}%`, need: `≥${req.tradeEvidence.minAvgPnlPct}%` },
      { label: "rug rate", have: `${(rugRate*100).toFixed(0)}%`, need: `≤${(req.tradeEvidence.maxRugRate*100).toFixed(0)}%` },
    ];
    const allNum = [
      unique.length >= req.tradeEvidence.minClosedTrades,
      verified.length >= req.tradeEvidence.minVerifiedTrades,
      wins.length >= req.tradeEvidence.minWinSamples,
      losses.length >= req.tradeEvidence.minLossSamples,
      avgPnl >= req.tradeEvidence.minAvgPnlPct,
      rugRate <= req.tradeEvidence.maxRugRate,
    ];
    tradePassed = allNum.every(Boolean);
    tradeDetail = checks.map(c => `${c.label}: ${c.have}/${c.need}`).join(" | ");
  } catch (e) {
    tradeDetail = `error: ${e.message}`;
  }
  components.push({ name: "1. Trade Evidence", passed: tradePassed, detail: tradeDetail });

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 2: Regime Competence — pengalaman di SEMUA pasar
  // ═══════════════════════════════════════════════════════════════
  let regimePassed = false;
  let regimeDetail = "";
  const EXPECTED_REGIMES = ["HOT", "NORMAL", "COLD", "DEAD"];
  try {
    const regimeData = readJsonSafe(path.join(PROJECT_ROOT, "regime-memory.json"));
    const regimes = regimeData?.regimes || regimeData?.observations || {};
    const entries = Object.entries(regimes).filter(([, v]) => (v.trade_count || v.trades || 0) > 0);

    const seenRegimes = new Set();
    const regimeStats = {};
    for (const [key, v] of entries) {
      const parts = key.split("|");
      const regime = parts[0];
      if (regime) {
        seenRegimes.add(regime);
        if (!regimeStats[regime]) regimeStats[regime] = { trades: 0, wins: 0 };
        regimeStats[regime].trades += (v.trade_count || v.trades || 0);
        regimeStats[regime].wins += (v.win_count || v.wins || 0);
      }
    }

    const missingRegimes = EXPECTED_REGIMES.filter(r => !seenRegimes.has(r));
    const lowTradeRegimes = EXPECTED_REGIMES.filter(r =>
      (regimeStats[r]?.trades || 0) < req.regimeCoverage.minTradesPerRegime
    );
    const lowWRRegimes = EXPECTED_REGIMES.filter(r => {
      const s = regimeStats[r];
      if (!s || s.trades < req.regimeCoverage.minTradesPerRegime) return false;
      return s.trades > 0 ? (s.wins / s.trades) < req.regimeCoverage.minWinRatePerRegime : true;
    });

    regimePassed =
      seenRegimes.size >= req.regimeCoverage.minDistinctRegimes &&
      missingRegimes.length === 0 &&
      lowTradeRegimes.length === 0 &&
      lowWRRegimes.length === 0;

    const parts = [`${seenRegimes.size}/${req.regimeCoverage.minDistinctRegimes} regimes`];
    if (missingRegimes.length > 0) parts.push(`missing: ${missingRegimes.join(",")}`);
    if (lowTradeRegimes.length > 0) parts.push(`low trades: ${lowTradeRegimes.join(",")}`);
    if (lowWRRegimes.length > 0) parts.push(`low WR: ${lowWRRegimes.join(",")}`);
    regimeDetail = parts.join(" | ");
  } catch (e) {
    regimeDetail = `error: ${e.message}`;
  }
  components.push({ name: "2. Regime Competence", passed: regimePassed, detail: regimeDetail });

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 3: Conviction Foundation — data keyakinan dalam
  // ═══════════════════════════════════════════════════════════════
  let convictionPassed = false;
  let convictionDetail = "";
  try {
    const conv = readJsonSafe(path.join(PROJECT_ROOT, "coin-conviction.json"));
    const coins = conv?.coins || {};
    const narratives = conv?.narratives || {};
    const coinEntries = Object.values(coins).filter(c => c && typeof c === "object" && !c.mintDecay);
    const totalObs = coinEntries.reduce((s, c) => s + safeNum(c.observation_count ?? c.observations), 0);
    const avgObs = coinEntries.length > 0 ? totalObs / coinEntries.length : 0;
    const narrativeCount = Object.keys(narratives).length;
    const clusters = new Set(coinEntries.map(c => c.narrative_cluster || c.cluster).filter(Boolean));

    convictionPassed =
      coinEntries.length >= req.convictionData.minCoinObservations &&
      narrativeCount >= req.convictionData.minNarrativeSamples &&
      avgObs >= req.convictionData.minAvgObservationsPerCoin &&
      clusters.size >= req.convictionData.minConvictionClusters;

    convictionDetail = [
      `coins: ${coinEntries.length}/${req.convictionData.minCoinObservations}`,
      `narratives: ${narrativeCount}/${req.convictionData.minNarrativeSamples}`,
      `avg obs/coin: ${avgObs.toFixed(1)}/${req.convictionData.minAvgObservationsPerCoin}`,
      `clusters: ${clusters.size}/${req.convictionData.minConvictionClusters}`,
    ].join(" | ");
  } catch (e) {
    convictionDetail = `error: ${e.message}`;
  }
  components.push({ name: "3. Conviction Foundation", passed: convictionPassed, detail: convictionDetail });

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 4: Execution Quality — bukti bisa eksekusi bersih
  // ═══════════════════════════════════════════════════════════════
  let execPassed = false;
  let execDetail = "";
  try {
    const exec = readJsonSafe(path.join(PROJECT_ROOT, "execution-quality.json"));
    const metrics = readJsonSafe(path.join(PROJECT_ROOT, "metrics.json"));
    const swaps = safeNum(metrics?.counters?.swaps_executed || metrics?.counters?.swaps) +
      safeNum(Object.values(exec?.providers || {}).reduce((s, p) => s + safeNum(p.swaps || p.total), 0));
    const slippageSamples = metrics?.series?.swap_slippage_ratio;
    const avgSlippage = slippageSamples?.mean ? slippageSamples.mean * 100 : null;
    const latencySamples = metrics?.series?.management_cycle_ms || metrics?.series?.screening_cycle_ms;
    const avgLatency = latencySamples?.mean || null;
    const providers = exec?.providers || {};
    const totalProviderSwaps = Object.values(providers).reduce((s, p) => s + safeNum(p.success || 0) + safeNum(p.failure || 0), 0);
    const totalSuccess = Object.values(providers).reduce((s, p) => s + safeNum(p.success), 0);
    const successRate = totalProviderSwaps > 0 ? totalSuccess / totalProviderSwaps : 0;

    execPassed =
      swaps >= req.executionQuality.minRecordedSwaps &&
      (avgSlippage === null || avgSlippage <= req.executionQuality.maxAvgSlippagePct) &&
      (avgLatency === null || avgLatency <= req.executionQuality.maxAvgLatencyMs) &&
      (totalProviderSwaps === 0 || successRate >= req.executionQuality.minSuccessRate);

    execDetail = [
      `swaps: ${swaps}/${req.executionQuality.minRecordedSwaps}`,
      `slippage: ${avgSlippage != null ? avgSlippage.toFixed(2) + "%" : "N/A"} ≤${req.executionQuality.maxAvgSlippagePct}%`,
      `latency: ${avgLatency != null ? avgLatency.toFixed(0) + "ms" : "N/A"} ≤${req.executionQuality.maxAvgLatencyMs}ms`,
      `success rate: ${totalProviderSwaps > 0 ? (successRate*100).toFixed(0) + "%" : "N/A"} ≥${(req.executionQuality.minSuccessRate*100).toFixed(0)}%`,
    ].join(" | ");
  } catch (e) {
    execDetail = `error: ${e.message}`;
  }
  components.push({ name: "4. Execution Quality", passed: execPassed, detail: execDetail });

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 5: Simulation & Backtest — strategi HARUS diuji
  // ═══════════════════════════════════════════════════════════════
  let simPassed = false;
  let simDetail = "";
  try {
    const stratReg = readJsonSafe(path.join(PROJECT_ROOT, "data", "strategy-registry.json"));
    const strategies = stratReg?.strategies || stratReg || [];
    const stratList = Array.isArray(strategies) ? strategies : Object.values(strategies);
    const withBacktest = stratList.filter(s => (s.scores?.backtest?.trades || s.backtest_trades || 0) > 0);
    const withPaper = stratList.filter(s => (s.scores?.paper?.trades || s.paper_trades || 0) > 0);
    const totalBacktestTrades = withBacktest.reduce((s, st) => s + safeNum(st.scores?.backtest?.trades || st.backtest_trades), 0);
    const totalPaperTrades = withPaper.reduce((s, st) => s + safeNum(st.scores?.paper?.trades || st.paper_trades), 0);
    const backtestWR = withBacktest.length > 0
      ? withBacktest.reduce((s, st) => s + safeNum(st.scores?.backtest?.winRate || st.backtest_winRate), 0) / withBacktest.length
      : 0;
    const profitFactor = withBacktest.length > 0
      ? withBacktest.reduce((s, st) => s + safeNum(st.scores?.backtest?.profitFactor || st.backtest_profitFactor || st.scores?.live?.profitFactor), 0) / withBacktest.length
      : 0;

    simPassed =
      totalBacktestTrades >= req.simulation.minBacktestTrades &&
      totalPaperTrades >= req.simulation.minPaperTrades &&
      backtestWR >= req.simulation.minBacktestWinRate &&
      profitFactor >= req.simulation.requireProfitFactor;

    simDetail = [
      `backtest trades: ${totalBacktestTrades}/${req.simulation.minBacktestTrades}`,
      `paper trades: ${totalPaperTrades}/${req.simulation.minPaperTrades}`,
      `backtest WR: ${(backtestWR*100).toFixed(0)}%/${(req.simulation.minBacktestWinRate*100).toFixed(0)}%`,
      `profit factor: ${profitFactor.toFixed(2)}/${req.simulation.requireProfitFactor}`,
    ].join(" | ");
  } catch (e) {
    simDetail = `error: ${e.message}`;
  }
  components.push({ name: "5. Simulation & Backtest", passed: simPassed, detail: simDetail });

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 6: Profit Consistency — konsisten, bukan lucky streak
  // ═══════════════════════════════════════════════════════════════
  let profitPassed = false;
  let profitDetail = "";
  try {
    const verified = allTrades.filter(t => safeNum(t.initial_value_usd) > 0);
    const totalVerified = verified.length;
    if (totalVerified >= req.profitConsistency.minSampleSizeForMetrics) {
      const wins = verified.filter(t => safeNum(t.pnl_pct ?? t.pnlPercent) > 0).length;
      const wr = wins / totalVerified;

      // Consecutive losses
      let maxConsec = 0;
      let currentConsec = 0;
      for (const t of verified) {
        if (safeNum(t.pnl_pct ?? t.pnlPercent) < 0) {
          currentConsec++;
          maxConsec = Math.max(maxConsec, currentConsec);
        } else {
          currentConsec = 0;
        }
      }

      // Drawdown dari cumulative PnL
      let peak = 0;
      let maxDD = 0;
      let cumulative = 0;
      for (const t of verified) {
        cumulative += safeNum(t.pnl_pct ?? t.pnlPercent);
        peak = Math.max(peak, cumulative);
        maxDD = Math.min(maxDD, cumulative - peak);
      }

      const totalWins = verified.filter(t => safeNum(t.pnl_pct ?? t.pnlPercent) > 0).reduce((s, t) => s + safeNum(t.pnl_pct ?? t.pnlPercent), 0);
      const totalLosses = verified.filter(t => safeNum(t.pnl_pct ?? t.pnlPercent) < 0).reduce((s, t) => s + Math.abs(safeNum(t.pnl_pct ?? t.pnlPercent)), 0);
      const pf = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? 999 : 0);

      // Average hold time
      const avgHold = verified.reduce((s, t) => {
        const entry = new Date(t.deployed_at || t.entry_at || 0).getTime();
        const exit = new Date(t.closed_at || t.exit_at || 0).getTime();
        return s + (exit > entry ? (exit - entry) / 60000 : 0);
      }, 0) / totalVerified;

      profitPassed =
        wr >= req.profitConsistency.minOverallWinRate &&
        maxConsec <= req.profitConsistency.maxConsecutiveLosses &&
        maxDD >= req.profitConsistency.maxDrawdownPct &&
        pf >= req.profitConsistency.minProfitFactor &&
        avgHold >= req.profitConsistency.minHoldingAvgMinutes;

      profitDetail = [
        `WR: ${(wr*100).toFixed(0)}%/${(req.profitConsistency.minOverallWinRate*100).toFixed(0)}%`,
        `max consec loss: ${maxConsec}/${req.profitConsistency.maxConsecutiveLosses}`,
        `max DD: ${maxDD.toFixed(1)}%/${req.profitConsistency.maxDrawdownPct}%`,
        `profit factor: ${pf.toFixed(2)}/${req.profitConsistency.minProfitFactor}`,
        `avg hold: ${avgHold.toFixed(0)}m/${req.profitConsistency.minHoldingAvgMinutes}m`,
      ].join(" | ");
    } else {
      profitDetail = `insufficient samples: ${totalVerified}/${req.profitConsistency.minSampleSizeForMetrics}`;
    }
  } catch (e) {
    profitDetail = `error: ${e.message}`;
  }
  components.push({ name: "6. Profit Consistency", passed: profitPassed, detail: profitDetail });

  // ═══════════════════════════════════════════════════════════════
  // KOMPONEN 7: Data Maturity — data harus cukup umur
  // ═══════════════════════════════════════════════════════════════
  let maturityPassed = false;
  let maturityDetail = "";
  try {
    const allFiles = [
      "regime-memory.json", "coin-conviction.json", "trade-attribution.json",
      "execution-quality.json", "closed-positions-archive.json",
    ];
    let oldestDate = null;
    let filesWithData = 0;
    for (const f of allFiles) {
      const fp = path.join(PROJECT_ROOT, f);
      if (!fs.existsSync(fp)) continue;
      try {
        const content = JSON.parse(fs.readFileSync(fp, "utf8"));
        // Cari timestamp tertua di dalam file
        const dates = [];
        const findDates = (obj) => {
          if (!obj || typeof obj !== "object") return;
          for (const [k, v] of Object.entries(obj)) {
            if (k === "last_seen_at" || k === "first_seen_at" || k === "deployed_at" ||
                k === "closed_at" || k === "createdAt" || k === "updatedAt" ||
                k === "lastUpdated" || k === "generatedAt") {
              if (typeof v === "string") dates.push(v);
            }
            if (typeof v === "object") findDates(v);
          }
        };
        findDates(content);
        if (dates.length > 0) {
          filesWithData++;
          const sorted = dates.sort();
          if (!oldestDate || sorted[0] < oldestDate) oldestDate = sorted[0];
        }
      } catch { /* skip corrupt file */ }
    }
    const ageDays = oldestDate
      ? (Date.now() - new Date(oldestDate).getTime()) / (24 * 60 * 60 * 1000)
      : 0;

    // Cek cooldown — kapan terakhir kali strategi dibuat?
    const stratReg = readJsonSafe(path.join(PROJECT_ROOT, "data", "strategy-registry.json"));
    const strategies = stratReg?.strategies || stratReg || [];
    const stratList = Array.isArray(strategies) ? strategies : Object.values(strategies);
    const activeCount = stratList.filter(s => s?.status === "active").length;
    const newestCreatedAt = stratList.reduce((latest, s) => {
      const d = new Date(s?.createdAt || s?.created_at || 0).getTime();
      return d > latest ? d : latest;
    }, 0);
    const hoursSinceLastCreation = newestCreatedAt > 0
      ? (Date.now() - newestCreatedAt) / (60 * 60 * 1000)
      : 999;

    maturityPassed =
      ageDays >= req.dataMaturity.minDataAgeDays &&
      activeCount >= req.dataMaturity.minActiveStrategies &&
      hoursSinceLastCreation >= req.dataMaturity.maxNewStrategyCooldownHours &&
      filesWithData >= 3;

    maturityDetail = [
      `data age: ${ageDays.toFixed(0)}d/${req.dataMaturity.minDataAgeDays}d`,
      `active strategies: ${activeCount}/${req.dataMaturity.minActiveStrategies}`,
      `cooldown: ${hoursSinceLastCreation.toFixed(0)}h/${req.dataMaturity.maxNewStrategyCooldownHours}h`,
      `files with data: ${filesWithData}/3`,
    ].join(" | ");
  } catch (e) {
    maturityDetail = `error: ${e.message}`;
  }
  components.push({ name: "7. Data Maturity", passed: maturityPassed, detail: maturityDetail });

  // ═══════════════════════════════════════════════════════════════
  // FINAL VERDICT
  // ═══════════════════════════════════════════════════════════════
  const allPassed = components.every(c => c.passed);
  const failed = components.filter(c => !c.passed);
  const failedNames = failed.map(c => c.name).join(", ");
  const blockedCount = failed.length;

  return {
    ready: allPassed,
    passed: components.filter(c => c.passed).length,
    failed: blockedCount,
    total: components.length,
    components,
    summary: allPassed
      ? "SEMUA 7 komponen lulus — agent layak menciptakan strategi baru."
      : `BLOCKED (${blockedCount}/7 gagal): ${failedNames}`,
    requirements: req,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Validate individual strategy candidate sebelum di-enqueue.
 * Ini adalah GATE TERAKHIR — meskipun readiness lolos, candidate
 * yang berbahaya atau tidak masuk akal TETAP akan ditolak.
 *
 * Returns { valid: boolean, reason: string }
 */
export function validateStrategyCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return { valid: false, reason: "Candidate is not an object" };
  }

  // ── 1. Harus punya rules ─────────────────────────────────
  const rules = candidate.rules || {};
  if (typeof rules !== "object" || Object.keys(rules).length === 0) {
    return { valid: false, reason: "No rules defined" };
  }
  if (!rules.signal) {
    return { valid: false, reason: "No signal field in rules" };
  }

  // ── 2. Stop-loss tidak boleh terlalu longgar (>-30%) ─────
  // stopLoss uses the internal positive convention (15 = 15% stop).
  // evolvedRulesToOverrides normalizes this to negative decimal (-0.15)
  // for the preset layer. Here we validate the raw magnitude.
  const slRaw = safeNum(rules.stopLossPct ?? rules.stoploss ?? rules.stopLoss ?? rules.stopPct);
  if (slRaw === 0) { /* optional — skip validation */ }
  else if (slRaw > 0 && slRaw > 50) {
    return { valid: false, reason: `Stop-loss too wide: ${slRaw}% (max 50%)` };
  } else if (slRaw < 0 && slRaw < -0.50) {
    // Decimal form: -0.50 = -50% (too wide)
    return { valid: false, reason: `Stop-loss terlalu longgar: ${(slRaw*100).toFixed(0)}% (maks 50%)` };
  }

  // ── 3. Take-profit minimal 5%, maksimal 200% ─────────────
  const tp = safeNum(rules.takeProfitPct ?? rules.takeProfit ?? rules.tpPct);
  if (tp !== 0 && (tp < 5 || tp > 200)) {
    return { valid: false, reason: `Take-profit tidak realistis: ${tp}% (harus 5-200%)` };
  }

  // ── 4. Max positions tidak boleh >20 ─────────────────────
  const maxPos = safeNum(rules.maxPositions ?? rules.max_positions);
  if (maxPos > 20) {
    return { valid: false, reason: `Max positions terlalu tinggi: ${maxPos} (maks 20)` };
  }

  // ── 5. Position size tidak boleh >50% ────────────────────
  const posSize = safeNum(rules.positionSizePct ?? rules.maxPositionPct ?? rules.position_size);
  if (posSize > 50) {
    return { valid: false, reason: `Position size terlalu besar: ${posSize}% (maks 50%)` };
  }

  // ── 6. Harus ada minimal 3 rule fields ───────────────────
  const ruleKeys = Object.keys(rules).filter(k => !["signal", "name", "type", "source"].includes(k));
  if (ruleKeys.length < 2) {
    return { valid: false, reason: `Hanya ${ruleKeys.length} rule fields — minimal 3 (signal + 2 others)` };
  }

  // ── 7. Nama strategi harus deskriptif (min 8 chars) ──────
  const name = candidate.name || "";
  if (name.length < 8) {
    return { valid: false, reason: `Nama strategi terlalu pendek: "${name}" (min 8 karakter)` };
  }

  // ── 8. Conviction score minimal 65 ────────────────────────
  const conv = safeNum(candidate.conviction ?? candidate.evidence?.scores?.composite_strength);
  if (conv < 65) {
    return { valid: false, reason: `Conviction terlalu rendah: ${conv.toFixed(0)}/65` };
  }

  // ── 9. Evidence harus ada (sources tidak boleh kosong) ───
  const evidenceSources = candidate.evidence?.sources || [];
  if (evidenceSources.length === 0) {
    return { valid: false, reason: "Tidak ada evidence sources" };
  }

  return { valid: true, reason: "Candidate valid — semua gate lulus" };
}

/**
 * Pro BUY decision — multi-signal convergence required.
 * More strict than standard screening BUY.
 */
export function proBuyDecision({ conviction, signal, kelly, workflow, rugScore, marketCondition, narrativeVelocity, volatilityPercentile, liquidity }) {
  const thresholds = _buildThresholds().buy;

  let convergingSignals = 0;
  const reasons = [];

  // Signal 1: Conviction
  const convScore = conviction?.conviction_score || 0;
  if (convScore >= thresholds.minConvictionScore) {
    convergingSignals++;
    reasons.push(`conviction=${convScore}`);
  } else {
    reasons.push(`conviction_low=${convScore}<${thresholds.minConvictionScore}`);
  }

  // Signal 2: Feature aggregate
  const aggregate = signal?.aggregate || 0;
  if (aggregate >= thresholds.minSignalAggregate) {
    convergingSignals++;
    reasons.push(`aggregate=${aggregate}`);
  } else {
    reasons.push(`aggregate_low=${aggregate}<${thresholds.minSignalAggregate}`);
  }

  // Signal 3: Kelly edge
  const kellyFrac = kelly?.effective_fraction || kelly?.kelly_fraction || 0;
  if (kellyFrac >= thresholds.minKellyEdge && !kelly?.should_skip) {
    convergingSignals++;
    reasons.push(`kelly=${kellyFrac.toFixed(3)}`);
  } else {
    reasons.push(`kelly_insufficient=${kellyFrac.toFixed(3)}`);
  }

  // Signal 4: Rug score
  if (rugScore <= thresholds.maxRugScore) {
    convergingSignals++;
    reasons.push(`rug_ok=${rugScore}`);
  } else {
    reasons.push(`rug_high=${rugScore}>${thresholds.maxRugScore}`);
  }

  // Signal 5: Workflow verdict
  if (workflow?.verdict === "active" || workflow?.verdict === "probe") {
    convergingSignals++;
    reasons.push(`workflow=${workflow.verdict}`);
  }

  // Signal 6: Volatility
  if ((volatilityPercentile || 50) <= thresholds.maxVolatilityPercentile) {
    convergingSignals++;
    reasons.push(`volatility_ok=${volatilityPercentile}`);
  }

  // Signal 7: Narrative velocity (context-dependent)
  if (marketCondition === "HOT" && narrativeVelocity) {
    const hasTrending = narrativeVelocity.trendingNarratives?.length > 0;
    if (hasTrending) { convergingSignals++; reasons.push("narrative_trending"); }
  }

  // Signal 8: Liquidity
  if ((liquidity || 0) >= thresholds.minLiquidityUSD) {
    convergingSignals++;
    reasons.push(`liquidity_ok=$${liquidity}`);
  }

  const passed = convergingSignals >= thresholds.requiredSignalsConverging;

  return {
    action: passed ? "BUY" : "SKIP",
    convergingSignals,
    requiredSignals: thresholds.requiredSignalsConverging,
    reasons,
    confidence: Math.round((convergingSignals / 8) * 100),
  };
}

/**
 * Pro SELL decision — multi-signal exit triggers.
 */
export function proSellDecision({ position, conviction, marketCondition, narrativeVelocity, regimeHistory }) {
  const thresholds = _buildThresholds().sell;
  let exitSignals = 0;
  const reasons = [];

  // Signal 1: Conviction decay
  const entryConv = position?.conviction_entry || 0;
  const currentConv = conviction?.conviction_score || 0;
  const convDelta = currentConv - entryConv;
  if (convDelta <= thresholds.convictionDecayThreshold) {
    exitSignals++;
    reasons.push(`conviction_decayed: ${convDelta} points`);
  }

  // Signal 2: Narrative death
  if (narrativeVelocity && position?.narrative_entry) {
    const entryNarrativeVel = position.narrative_entry_velocity || 0;
    const currentVel = narrativeVelocity.velocity_score || 0;
    if (currentVel - entryNarrativeVel <= thresholds.narrativeDeathThreshold) {
      exitSignals++;
      reasons.push(`narrative_dying: velocity ${currentVel - entryNarrativeVel}`);
    }
  }

  // Signal 3: Regime downgrade
  if (marketCondition === "DEAD" && thresholds.regimeDowngradeExit) {
    exitSignals++;
    reasons.push("regime_dead");
  }

  // Signal 4: Pro trailing stop
  const pnlPct = position?.pnl_pct || 0;
  const peakPnl = position?.peak_pnl_pct || 0;
  if (peakPnl >= thresholds.trailingActivationPnL && pnlPct <= peakPnl * 0.6) {
    exitSignals++;
    reasons.push(`trailing: peak=${peakPnl.toFixed(1)}% current=${pnlPct.toFixed(1)}%`);
  }

  // Signal 5: Profit sweep
  if (pnlPct >= thresholds.profitSweepPnL) {
    exitSignals++;
    reasons.push(`profit_sweep: ${pnlPct.toFixed(1)}% >= ${thresholds.profitSweepPnL}%`);
  }

  const shouldExit = exitSignals >= 2; // at least 2 signals required

  return {
    action: shouldExit ? "SELL" : "HOLD",
    exitSignals,
    reasons,
    urgency: exitSignals >= 3 ? "HIGH" : exitSignals >= 2 ? "MEDIUM" : "LOW",
  };
}

/**
 * Pro CUTLOSS — adaptive to regime and conviction.
 */
export function proCutlossDecision({ pnlPct, holdMinutes, marketCondition, conviction, entryConviction } = {}) {
  const safePnl = Number.isFinite(Number(pnlPct)) ? Number(pnlPct) : 0;
  const safeHold = Number.isFinite(Number(holdMinutes)) ? Number(holdMinutes) : 0;
  const thresholds = _buildThresholds().cutloss;

  // Fast failure detection
  if (safeHold <= thresholds.fastFailureMinutes && safePnl <= thresholds.fastFailurePnL) {
    return {
      action: "CUTLOSS",
      reason: `fast_failure: ${safePnl.toFixed(1)}% in ${safeHold.toFixed(0)}min`,
      type: "fast_failure",
    };
  }

  // Conviction collapse — cut sooner
  const convCollapse = (entryConviction || 0) - (conviction?.conviction_score || 0);
  if (convCollapse >= 25 && safePnl <= thresholds.convictionCollapsePnL) {
    return {
      action: "CUTLOSS",
      reason: `conviction_collapse: ${convCollapse.toFixed(0)}pt drop + ${safePnl.toFixed(1)}% loss`,
      type: "conviction_collapse",
    };
  }

  // Regime-adjusted standard cutloss
  const regimeCutLoss = thresholds.regimeAdjustedCutLoss[marketCondition]
    || thresholds.standardCutLossPnL;

  if (safePnl <= regimeCutLoss) {
    return {
      action: "CUTLOSS",
      reason: `regime_cutloss: ${safePnl.toFixed(1)}% <= ${regimeCutLoss}% (${marketCondition})`,
      type: "standard",
    };
  }

  return { action: "HOLD" };
}

/**
 * Pro Cast-Net decision — gate for high-conviction multi-wallet (tebar jala) entry.
 *
 * Called AFTER proBuyDecision returns BUY. If allowed, the candidate should
 * be marked for cast-net dispatch (planCastNetExecution + recordCastNetFire
 * in the executor path). If not allowed, the buy proceeds normally as a
 * single-wallet entry.
 *
 * This function consolidates the operator + signal gates so callers don't
 * need to wire 7 sub-checks themselves. All hard rules from the spec are
 * enforced here:
 *   - Cast-net config + manual toggle
 *   - Pro-orch active
 *   - Strategy whitelist
 *   - Cooldown
 *   - All 7 green-flag categories
 *   - Conviction floor + minimum memory samples
 */
export async function proCastNetDecision({
  token,
  conviction,
  totalMemorySamples = 0,
  smartMoneyMinHolders = 2,
} = {}) {
  // Auto-disabled if pro-orch is not active — sesuai spec "jika ponyou
  // sudah bisa menggunakan mode pro orhestra".
  if (!_proModeActive) {
    return {
      allowed: false,
      reasons: {},
      blockers: ["pro-orchestrator inactive"],
      cooldownRemainingMin: 0,
      plan: null,
    };
  }

  const activeStrategy = (() => {
    try { return getActiveStrategy()?.id || null; }
    catch { return null; }
  })();

  // Map the running conviction signal into the shape evaluateCastNet expects.
  // `conviction` here is the in-flight conviction object from screening — we
  // prefer its experience_score field but fall back to a fresh computation
  // if needed.
  let experienceScore = conviction?.experience_score ?? null;
  if (!experienceScore && token?.mint) {
    try { experienceScore = getExperienceScore(token); }
    catch { experienceScore = null; }
  }

  // G1: feed runtime wallet context so the gate can block when only 1 hot
  // wallet is available (cast-net is meaningless single-wallet).
  let walletContext = null;
  try {
    const all = getAllWallets() || [];
    walletContext = {
      multiWalletEnabled: Boolean(_runtimeConfig.multiWallet?.enabled),
      viableWalletCount: all.filter((w) => w?.status === "hot").length,
    };
  } catch {
    walletContext = null;
  }

  return await evaluateCastNet({
    token,
    activeStrategy,
    proOrchestratorOn: true,
    experienceScore,
    totalMemorySamples,
    trashFilter: scoreTrash,
    smartMoneyOpts: { minHolders: smartMoneyMinHolders },
    walletContext,
  });
}

// ─── Pro Mode Lifecycle ───────────────────────────────────────

export function initProOrchestrator() {
  if (_initialized) return;
  _initialized = true;

  // Pro mode activates for approved automation, or for demo-only validation.
  _validationMode = proValidationModeEnabled();
  _proModeActive = isAutomationActive() || _validationMode;

  if (_proModeActive) {
    if (_validationMode) {
      setAgentStatus(AGENT_NAME, "running", "PRO VALIDATION MODE — demo/paper only");
      log("pro_orchestrator", "PRO VALIDATION MODE — demo/paper only, live automation remains locked");
    } else {
      setAgentStatus(AGENT_NAME, "running", "PRO MODE active — elite decision engine online");
      log("pro_orchestrator", "PRO MODE ENGAGED — full data-driven decision engine active");
    }

    // Run initial deep analysis
    const intel = runProAnalysis();
    if (intel) {
      log("pro_orchestrator", `Deep analysis: ${intel.recommendations.length} recommendations generated`);
      intel.recommendations.forEach(r => log("pro_orchestrator", `  ${r.detail}`));
    }
  } else {
    setAgentStatus(AGENT_NAME, "stopped", "Awaiting automation approval");
    log("pro_orchestrator", "Pro mode locked — automation not yet approved");
  }

  // Listen for automation activation — upgrade to pro mode
  agentBus.subscribe("automation:activated", () => {
    _proModeActive = true;
    setAgentStatus(AGENT_NAME, "running", "PRO MODE activated — elite decisions online");
    log("pro_orchestrator", "PRO MODE ENGAGED — automation approved, elite engine online");

    const intel = runProAnalysis();
    if (intel) {
      agentBus.emit("pro:intelligence_ready", intel);
    }
  });

  // Listen for automation revocation — downgrade from pro mode
  agentBus.subscribe("automation:revoked", () => {
    _validationMode = proValidationModeEnabled();
    _proModeActive = _validationMode;
    if (_proModeActive) {
      setAgentStatus(AGENT_NAME, "running", "PRO VALIDATION MODE — demo/paper only");
      log("pro_orchestrator", "Automation revoked; staying in demo-only pro validation mode");
      return;
    }
    setAgentStatus(AGENT_NAME, "stopped", "Pro mode revoked — back to manual");
    log("pro_orchestrator", "Pro mode disengaged — automation revoked");
  });

  // Listen for trade outcomes → continuous learning
  // PO-6: previously this incremented `_tradesSinceLastAnalysis` but never
  // acted on it. Now actually refreshes pro-intel every N trades and emits
  // the result so the orchestrator-agent's selector consumes it.
  const ANALYSIS_REFRESH_EVERY = 10;
  agentBus.subscribe("management:llm_exit_executed", () => {
    if (!_proModeActive) return;
    _tradesSinceLastAnalysis += 1;
    updateAgentHealth(AGENT_NAME, { tradesSinceLastAnalysis: _tradesSinceLastAnalysis });
    if (_tradesSinceLastAnalysis >= ANALYSIS_REFRESH_EVERY) {
      _tradesSinceLastAnalysis = 0;
      // Invalidate the cache so runProAnalysis re-reads disk.
      clearProAnalysisCache();
      const intel = runProAnalysis();
      if (intel) {
        agentBus.emit("pro:intelligence_ready", intel);
        log("pro_orchestrator", `Auto-refreshed analysis after ${ANALYSIS_REFRESH_EVERY} trades`);
      }
    }
  });
}

export function isProModeActive() {
  return _proModeActive;
}

export function getProDashboard() {
  const intel = _proModeActive ? runProAnalysis() : null;
  return {
    agent: {
      name: AGENT_NAME,
      role: "pro-orchestrator",
      active: _proModeActive,
      validationMode: _validationMode,
    },
    thresholds: PRO_THRESHOLDS,
    intelligence: intel ? {
      regimes: Object.keys(intel.regimes).length,
      narratives: Object.keys(intel.narratives).length,
      strategies: Object.keys(intel.strategies).length,
      recommendations: intel.recommendations,
    } : null,
  };
}

export { PRO_THRESHOLDS };
export default {
  initProOrchestrator,
  runProAnalysis,
  proBuyDecision,
  proSellDecision,
  proCutlossDecision,
  proCastNetDecision,
  isProModeActive,
  getProDashboard,
  PRO_THRESHOLDS,
};
