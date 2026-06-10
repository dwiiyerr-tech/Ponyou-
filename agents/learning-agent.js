/**
 * Learning Agent — Continuous learning from all hunter sub-agents.
 *
 * Responsibilities:
 *   1. Track which hunter source (pumpfun/trending/volume/social/discord/etc)
 *      found each token, and correlate with trade outcomes.
 *   2. On rug/loss → record name patterns, trigger pattern recompile.
 *   3. Patch trash-layer KNOWN_SCAM_PATTERNS at runtime with new learned rules.
 *   4. Maintain per-source win/rug stats → adjust hunter minScore thresholds.
 *   5. Emit periodic health reports on hunter performance.
 *
 * Bus events consumed:
 *   management:llm_exit_executed  — trade closed (has rug/loss/win flag)
 *   management:llm_buy            — trade opened (has _hunt_source from hunters)
 *   learning:force_compile        — manual trigger to recompile patterns now
 *
 * Bus events emitted:
 *   learning:patterns_updated     — trash-layer should reload name patterns
 *   learning:hunter_weights       — hunter source performance ranking
 *   learning:rug_recorded         — a new rug was processed
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { log } from "../logger.js";
import { recordRug } from "../lessons.js";
import { learnPatterns } from "../tools/rug-patterns.js";
import { recordRuggedName, compileLearnedNamePatterns } from "../tools/name-pattern-learner.js";
import { startShadowWatchlist, getShadowStats } from "../tools/shadow-watchlist.js";
import { recordLossPattern } from "../conviction-memory.js";
import { atomicWriteJson } from "../atomic-write.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERFORMANCE_FILE   = path.join(__dirname, "../hunter-performance.json");
const STRATEGY_PERF_FILE = path.join(__dirname, "../strategy-performance.json");
// T3-1: persist _openTrades so source attribution survives process restart.
const OPEN_TRADES_FILE   = path.join(__dirname, "../open-trades-learning.json");
const AGENT_NAME = "learning";

// Recompile name patterns after this many new rugs accumulated
const COMPILE_EVERY_N_RUGS = 3;

let _initialized = false;
let _rugsSinceLastCompile = 0;
// T3-12: unsubscribe refs for safe re-init cleanup.
let _unsubscribers = [];

// In-memory map: mint → { source, social_source, entry_ts }
// Populated when a BUY happens, consumed when EXIT happens.
// T3-1: also persisted to OPEN_TRADES_FILE so restart doesn't lose attribution.
const _openTrades = new Map();

function _loadOpenTrades() {
  try {
    if (!fs.existsSync(OPEN_TRADES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(OPEN_TRADES_FILE, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [mint, entry] of Object.entries(raw)) {
        _openTrades.set(mint, entry);
      }
    }
  } catch { /* non-critical: fall through with empty map */ }
}

function _saveOpenTrades() {
  const obj = Object.fromEntries(_openTrades);
  try {
    // atomicWriteJson is sync — .catch() on its (undefined) return value threw
    // a TypeError that killed every buy/exit listener before any learning ran.
    atomicWriteJson(OPEN_TRADES_FILE, obj);
  } catch (e) {
    // B1: log instead of swallowing — silent failure loses source attribution
    // permanently on next restart. Operator can investigate disk/permission.
    log("learning_error", `_saveOpenTrades failed: ${e.message}`);
  }
}

// ─── Strategy performance persistence ─────────────────────────────────────

function loadStratPerf() {
  if (!fs.existsSync(STRATEGY_PERF_FILE)) return { strategies: {}, last_updated: null };
  try { return JSON.parse(fs.readFileSync(STRATEGY_PERF_FILE, "utf8")); }
  catch { return { strategies: {}, last_updated: null }; }
}

function saveStratPerf(data) {
  data.last_updated = new Date().toISOString();
  atomicWriteJson(STRATEGY_PERF_FILE, data);
}

export function getStrategyPerformance() {
  const perf = loadStratPerf();
  return Object.entries(perf.strategies)
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (b.win_rate || 0) - (a.win_rate || 0) || (b.avg_pnl_pct || 0) - (a.avg_pnl_pct || 0));
}

// ─── Persistence ────────────────────────────────────────────────────────────

function loadPerf() {
  if (!fs.existsSync(PERFORMANCE_FILE)) return { sources: {}, last_updated: null };
  try { return JSON.parse(fs.readFileSync(PERFORMANCE_FILE, "utf8")); }
  catch { return { sources: {}, last_updated: null }; }
}

function savePerf(data) {
  data.last_updated = new Date().toISOString();
  atomicWriteJson(PERFORMANCE_FILE, data);
}

// ─── Source stats helpers ───────────────────────────────────────────────────

function bumpSource(sourceKey, outcome) {
  if (!sourceKey) return;
  const perf = loadPerf();
  if (!perf.sources[sourceKey]) {
    perf.sources[sourceKey] = { found: 0, won: 0, lost: 0, rugged: 0, rug_rate: 0, win_rate: 0 };
  }
  const s = perf.sources[sourceKey];
  s.found++;
  if (outcome === "win")   s.won++;
  if (outcome === "loss")  s.lost++;
  if (outcome === "rug")   s.rugged++;

  const closed = s.won + s.lost + s.rugged;
  s.rug_rate  = closed > 0 ? parseFloat((s.rugged / closed).toFixed(3)) : 0;
  s.win_rate  = closed > 0 ? parseFloat((s.won / closed).toFixed(3)) : 0;

  savePerf(perf);
  return perf.sources;
}

function getSourceRanking() {
  const perf = loadPerf();
  return Object.entries(perf.sources)
    .map(([key, s]) => ({ source: key, ...s }))
    .sort((a, b) => a.rug_rate - b.rug_rate || b.win_rate - a.win_rate);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initLearningAgent() {
  // Guard first so re-init never wipes listeners without re-registering them.
  if (_initialized) return;
  _initialized = true;

  setAgentStatus(AGENT_NAME, "running", "Learning agent — continuous pattern learning from all hunters");

  // T3-1: reload persisted open trades from previous session.
  _loadOpenTrades();

  // ── Track open trades so we can attribute exits to their source ──
  _unsubscribers.push(agentBus.subscribe("management:llm_buy", (payload) => {
    const mint = payload?.token || payload?.mint;
    if (!mint) return;
    _openTrades.set(mint, {
      source: payload?._hunt_source || "unknown",
      social_source: payload?._social_source || null,
      symbol: payload?.symbol || null,
      name: payload?.name || null,
      entry_ts: Date.now(),
    });
    _saveOpenTrades();
    log("learning", `Tracking open trade: ${payload?.symbol || mint.slice(0, 8)} source=${payload?._hunt_source || "unknown"}`);
  }));

  // ── Process exit: learn from outcome ──
  _unsubscribers.push(agentBus.subscribe("management:llm_exit_executed", async (payload) => {
    const mint = payload?.mint;
    if (!mint) return;

    const trade = _openTrades.get(mint) || {};
    _openTrades.delete(mint);
    _saveOpenTrades();

    // LA-1: classify rug from multiple signals because the LLM exit path
    // always reports reason="LLM Manager Decision" — using only that string
    // missed every rug closed via LLM. Trigger on any of:
    //   - explicit rug_detected flag
    //   - reason contains "rug" (case-insensitive) for deterministic exits
    //   - reason contains "rug" via "LLM Manager Decision" + payload tag
    //   - severe loss (≤ -80%) — empirically a wipeout, treat as rug
    const reasonStr = String(payload?.reason || "").toLowerCase();
    const pnlPct  = payload?.pnl_pct ?? payload?.pnl ?? 0;
    const isExplicitRug = !!payload?.rug_detected;
    const reasonHasRug  = /rug|honeypot|drained/.test(reasonStr);
    const isWipeout     = Number.isFinite(pnlPct) && pnlPct <= -80;
    const isRug = isExplicitRug || reasonHasRug || isWipeout;
    const isLoss  = !isRug && pnlPct < -15;
    const isWin   = !isRug && pnlPct > 0;

    const outcome = isRug ? "rug" : isLoss ? "loss" : isWin ? "win" : "neutral";
    const source  = trade.source || payload?._hunt_source || "unknown";
    const symbol  = trade.symbol || payload?.symbol || "";
    const name    = trade.name   || payload?.name   || "";

    // 1. Update hunter source performance stats
    const allSources = bumpSource(source, outcome);
    if (trade.social_source) bumpSource(`social:${trade.social_source}`, outcome);

    // 2. If rug — record name patterns + trigger rug pattern learning
    if (isRug) {
      const nameFeatures = recordRuggedName(symbol, name);
      log("learning", `RUG recorded: ${symbol} source=${source} name_features=[${nameFeatures.join(",")}]`);

      try {
        recordRug({
          mint,
          symbol,
          creator: payload?.creator || null,
          launchpad: payload?.launchpad || null,
          rug_signals: payload?.rug_signals || {},
          pattern_notes: `hunt_source=${source}`,
        });
      } catch (e) {
        log("learning_error", `recordRug failed: ${e.message}`);
      }

      _rugsSinceLastCompile++;
      if (_rugsSinceLastCompile >= COMPILE_EVERY_N_RUGS) {
        _rugsSinceLastCompile = 0;
        await _recompileAndPatch();
      }

      agentBus.emit("learning:rug_recorded", { mint, symbol, source, name_features: nameFeatures });
    }

    // 3. If big loss — still worth learning name patterns (not rug but dump)
    if (isLoss) {
      recordRuggedName(symbol, name);
      log("learning", `LOSS recorded: ${symbol} pnl=${pnlPct?.toFixed(1)}% source=${source}`);
    }

    // 4. Emit updated hunter rankings
    const ranking = getSourceRanking();
    agentBus.emit("learning:hunter_weights", { ranking, updated_at: new Date().toISOString() });

    updateAgentHealth(AGENT_NAME, {
      last_exit_processed: new Date().toISOString(),
      last_outcome: outcome,
      last_symbol: symbol,
      last_source: source,
      source_ranking: ranking.slice(0, 5),
    });
  }));

  // ── Manual force-compile trigger ──
  _unsubscribers.push(agentBus.subscribe("learning:force_compile", async () => {
    log("learning", "Force compile triggered");
    await _recompileAndPatch();
  }));

  // ── Strategy performance feedback loop ──
  // Receives management:strategy_outcome when a position closes so we can
  // track per-preset win/loss/rug rates and surface degrading strategies.
  _unsubscribers.push(agentBus.subscribe("management:strategy_outcome", (payload) => {
    const stratId = payload?.strategy_id;
    if (!stratId) return;
    const perf = loadStratPerf();
    if (!perf.strategies[stratId]) {
      perf.strategies[stratId] = {
        traded: 0, won: 0, lost: 0, rugged: 0,
        win_rate: 0, rug_rate: 0, avg_pnl_pct: 0, pnl_sum: 0,
        last_trade_at: null,
      };
    }
    const s = perf.strategies[stratId];
    s.traded++;
    if (payload.is_rug)       s.rugged++;
    else if (payload.is_win)  s.won++;
    else                      s.lost++;
    s.pnl_sum    = (s.pnl_sum || 0) + Number(payload.pnl_pct || 0);
    s.avg_pnl_pct = parseFloat((s.pnl_sum / Math.max(1, s.traded)).toFixed(2));
    const closed = s.won + s.lost + s.rugged;
    s.win_rate   = closed > 0 ? parseFloat((s.won    / closed).toFixed(3)) : 0;
    s.rug_rate   = closed > 0 ? parseFloat((s.rugged / closed).toFixed(3)) : 0;
    s.last_trade_at = new Date().toISOString();
    saveStratPerf(perf);
    log("learning", `strategy:${stratId} pnl=${Number(payload.pnl_pct || 0).toFixed(1)}% → WR=${(s.win_rate * 100).toFixed(0)}% rug=${(s.rug_rate * 100).toFixed(0)}% (${s.traded} trades)`);
    agentBus.emit("learning:strategy_performance", {
      strategies: perf.strategies,
      updated_at: new Date().toISOString(),
    });
  }));

  // ── Trash-layer block feedback — free learning from prevented trades ──
  _unsubscribers.push(agentBus.subscribe("learning:trash_blocked", (payload) => {
    const { symbol = "", name = "", type = "unknown" } = payload;
    if (!symbol && !name) return;
    const source = payload._hunt_source || "unknown";

    // Bug #2 fix: only count rug-quality blocks toward source stats.
    // "prescreen" blocks (dust mcap, zero liquidity, blacklisted stablecoin)
    // are data-quality filters — they reflect the state of the token, not
    // the hunt source's ability to find good tokens. Counting them as "rug"
    // inflated rug_rate to 1.0 for all sources after a single scan cycle.
    // Only scam_name, honeypot, and rugcheck blocks reflect source quality.
    const RUG_QUALITY_TYPES = new Set(["scam_name", "honeypot", "rugcheck"]);
    if (RUG_QUALITY_TYPES.has(type)) {
      bumpSource(source, "rug");
    }
    log("learning", `TRASH BLOCK free learn: ${symbol} type=${type} source=${source}`);
  }));

  // ── Periodic health report every 30 minutes ──
  const _reportTimer = setInterval(() => {
    const ranking = getSourceRanking();
    if (ranking.length > 0) {
      log("learning", `Hunter performance: ${ranking.map(s => `${s.source} rug=${(s.rug_rate * 100).toFixed(0)}% win=${(s.win_rate * 100).toFixed(0)}%`).join(" | ")}`);
      agentBus.emit("learning:hunter_weights", { ranking, updated_at: new Date().toISOString() });
    }
    // Also log strategy performance
    const stratRanking = getStrategyPerformance();
    if (stratRanking.length > 0) {
      log("learning", `Strategy performance: ${stratRanking.map(s => `${s.id} WR=${(s.win_rate * 100).toFixed(0)}% avg=${s.avg_pnl_pct}%`).join(" | ")}`);
    }
  }, 30 * 60 * 1000);
  _unsubscribers.push(() => clearInterval(_reportTimer));

  // ── Shadow watchlist rugs → free learning without buying ──
  _unsubscribers.push(agentBus.subscribe("shadow:rug_detected", async (payload) => {
    const symbol = payload?.symbol || "";
    const name   = payload?.name   || "";
    const source = payload?.hunt_source || "unknown";

    log("learning", `SHADOW RUG (no buy): ${symbol} type=${payload?.rug_type} source=${source}`);

    // Record name/symbol patterns from this rug — no trade needed
    const nameFeatures = recordRuggedName(symbol, name);

    // Record rug signals if available (rug_score gives a hint)
    try {
      recordRug({
        mint:          payload?.mint,
        symbol,
        creator:       null,
        launchpad:     null,
        rug_signals:   {},
        pattern_notes: `shadow_rug type=${payload?.rug_type} source=${source}`,
      });
    } catch (e) {
      log("learning_error", `shadow recordRug failed: ${e.message}`);
    }

    // Update source performance stats
    bumpSource(source, "rug");
    if (payload?.social_source) bumpSource(`social:${payload.social_source}`, "rug");

    // Record loss fingerprint — shadow rugs are free data, should feed loss DB
    try {
      recordLossPattern({
        mint:        payload?.mint,
        symbol,
        pnl_pct:     -100, // shadow rug = total loss from entry price perspective
        hold_minutes: 0,
        exit_reason: `shadow_rug:${payload?.rug_type || "unknown"}`,
        token: {
          rug_score:       payload?.rug_score || 80,
          signal:          { signal_score: payload?.signal_score || 0 },
          market_condition: "UNKNOWN",
        },
      });
    } catch (e) {
      log("learning_error", `shadow loss fingerprint failed: ${e.message}`);
    }

    _rugsSinceLastCompile++;
    if (_rugsSinceLastCompile >= COMPILE_EVERY_N_RUGS) {
      _rugsSinceLastCompile = 0;
      await _recompileAndPatch();
    }

    agentBus.emit("learning:rug_recorded", {
      mint: payload?.mint, symbol, source,
      shadow: true,
      name_features: nameFeatures,
    });

    updateAgentHealth(AGENT_NAME, {
      last_shadow_rug: new Date().toISOString(),
      last_shadow_symbol: symbol,
      shadow_stats: getShadowStats(),
    });
  }));

  // ── Shadow watchlist missed winners → the upside half of free learning ──
  // A skipped token that mooned means the source surfaced a real winner; credit
  // it so source ranking reflects find-quality, not just rug-avoidance. The
  // signal-weight (darwin) feedback happens inside shadow-watchlist itself.
  _unsubscribers.push(agentBus.subscribe("shadow:winner_missed", (payload) => {
    const symbol = payload?.symbol || "";
    const source = payload?.hunt_source || "unknown";
    log("learning", `SHADOW WINNER MISSED: ${symbol} peaked +${payload?.peak_gain_pct}% source=${source}`);
    bumpSource(source, "win");
    if (payload?.social_source) bumpSource(`social:${payload.social_source}`, "win");
    updateAgentHealth(AGENT_NAME, {
      last_missed_winner: new Date().toISOString(),
      last_missed_symbol: symbol,
      last_missed_peak_pct: payload?.peak_gain_pct ?? null,
    });
  }));

  // Start shadow watchlist price monitor
  startShadowWatchlist();
  _unsubscribers.push(() => stopShadowWatchlist());

  log("learning", "Learning agent initialized — watching all trade exits + shadow watchlist");
}

// ─── Recompile + patch trash layer ──────────────────────────────────────────

async function _recompileAndPatch() {
  try {
    // Recompile rug signal patterns (existing system)
    learnPatterns();

    // Recompile name/symbol patterns (new system)
    const newRules = compileLearnedNamePatterns();
    log("learning", `Name pattern recompile: ${newRules.length} rules compiled`);

    // Signal trash-layer to reload its runtime patterns
    agentBus.emit("learning:patterns_updated", {
      name_rules: newRules,
      timestamp: Date.now(),
    });
  } catch (e) {
    log("learning_error", `Recompile failed: ${e.message}`);
  }
}

// ─── Exports for dashboard / operator ───────────────────────────────────────

export function getLearningStats() {
  const perf = loadPerf();
  const ranking = getSourceRanking();
  return {
    open_trades_tracked: _openTrades.size,
    rugs_since_last_compile: _rugsSinceLastCompile,
    compile_threshold: COMPILE_EVERY_N_RUGS,
    hunter_ranking: ranking,
    last_updated: perf.last_updated,
  };
}
