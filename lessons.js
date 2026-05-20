/**
 * Persistent Lessons & Performance Memory.
 *
 * Lessons: agent-written rules learned from trade outcomes.
 * Performance: historical trade records for win-rate analysis.
 * Rug Memory: token/dev patterns identified as scams.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { matchPatterns, learnPatterns } from "./tools/rug-patterns.js";
import { getHolderMemoryRules } from "./holder-memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = path.join(__dirname, "lessons.json");
const PERF_FILE    = path.join(__dirname, "performance.json");
const RUG_FILE     = path.join(__dirname, "rug-memory.json");

// ─── Lessons ──────────────────────────────────────────────────

function loadLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [] };
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); }
  catch { return { lessons: [] }; }
}

function saveLessons(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

let _lessonCounter = null;
function nextId() {
  if (_lessonCounter === null) {
    const data = loadLessons();
    _lessonCounter = data.lessons.reduce((max, l) => Math.max(max, l.id || 0), 0);
  }
  return ++_lessonCounter;
}

export function addLesson(rule, tags = [], opts = {}) {
  const data = loadLessons();
  const id = nextId();
  data.lessons.push({
    id,
    rule: String(rule).slice(0, 400),
    tags: Array.isArray(tags) ? tags : [],
    role: opts.role || null,
    pinned: !!opts.pinned,
    times_applied: 0,
    success_count: 0,      // NEW: Track wins with this lesson
    failure_count: 0,      // NEW: Track losses with this lesson
    last_used: null,       // NEW: Track last usage
    created_at: new Date().toISOString(),
  });
  saveLessons(data);
  return id;
}

export function pinLesson(id) {
  const data = loadLessons();
  const lesson = data.lessons.find(l => l.id === Number(id));
  if (!lesson) return { error: `Lesson ${id} not found` };
  lesson.pinned = true;
  saveLessons(data);
  return { pinned: true, id };
}

export function unpinLesson(id) {
  const data = loadLessons();
  const lesson = data.lessons.find(l => l.id === Number(id));
  if (!lesson) return { error: `Lesson ${id} not found` };
  lesson.pinned = false;
  saveLessons(data);
  return { pinned: false, id };
}

export function listLessons({ role, pinned, tag, limit = 20 } = {}) {
  const data = loadLessons();
  let list = data.lessons;
  if (role) list = list.filter(l => !l.role || l.role === role);
  if (pinned === true) list = list.filter(l => l.pinned);
  if (tag) list = list.filter(l => l.tags.includes(tag));
  return list.slice(-limit);
}

export function clearAllLessons() {
  const data = loadLessons();
  const n = data.lessons.length;
  data.lessons = [];
  _lessonCounter = 0;
  saveLessons(data);
  return n;
}

export function removeLessonsByKeyword(keyword) {
  const data = loadLessons();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter(l => !l.rule.toLowerCase().includes(keyword.toLowerCase()));
  saveLessons(data);
  return before - data.lessons.length;
}

export function getLessonsForPrompt({ agentType, maxItems = 12 } = {}) {
  const data = loadLessons();
  let list = data.lessons;

  // Pinned first, then role-relevant, then general
  const pinned = list.filter(l => l.pinned);
  const roleSpecific = list.filter(l => !l.pinned && l.role === agentType);
  const general = list.filter(l => !l.pinned && (!l.role || l.role === "all"));

  const combined = [...pinned, ...roleSpecific, ...general].slice(0, maxItems);
  const lines = combined.map(l => {
    const pin = l.pinned ? "[PINNED] " : "";
    const tags = l.tags.length ? ` [${l.tags.join(",")}]` : "";
    const winRate = l.times_applied > 0 ? ((l.success_count / l.times_applied) * 100).toFixed(0) : "N/A";
    return `• ${pin}${l.rule}${tags} (${winRate}% WR, ${l.times_applied} uses)`;
  });
  const structuralMemory = getHolderMemoryRules().map(rule => `• [MARKET STRUCTURE] ${rule}`);
  if (lines.length === 0 && structuralMemory.length === 0) return "";
  const merged = [...structuralMemory, ...lines].slice(0, maxItems + structuralMemory.length);
  return merged.join("\n");
}

// ─── Lesson Effectiveness Tracking ────────────────────────────

/**
 * Record lesson outcome: update success/failure counts.
 * Called when a trade closes to track if active lessons helped.
 */
export function recordLessonOutcome(lessonIds = [], tradePnl = 0) {
  if (!Array.isArray(lessonIds) || lessonIds.length === 0) return;

  const data = loadLessons();
  const isWin = tradePnl > 0;

  for (let lessonId of lessonIds) {
    const lesson = data.lessons.find(l => l.id === Number(lessonId));
    if (!lesson) continue;

    lesson.times_applied = (lesson.times_applied || 0) + 1;
    lesson.last_used = new Date().toISOString();

    if (isWin) {
      lesson.success_count = (lesson.success_count || 0) + 1;
    } else {
      lesson.failure_count = (lesson.failure_count || 0) + 1;
    }
  }

  // Auto-deprecate ineffective lessons. Pinned lessons (lesson.pinned === true,
  // not a tag) are protected from auto-deprecation.
  for (let lesson of data.lessons) {
    if ((lesson.times_applied || 0) > 30) {
      const winRate = lesson.success_count / lesson.times_applied;
      if (winRate < 0.4 && !lesson.pinned) {
        lesson.tags = lesson.tags || [];
        if (!lesson.tags.includes("deprecated")) {
          lesson.tags.push("deprecated");
        }
      }
    }
  }

  saveLessons(data);
}

/**
 * Get lesson analytics: win rates, usage counts, etc.
 */
export function getLessonAnalytics() {
  const data = loadLessons();
  return data.lessons.map(l => ({
    id: l.id,
    rule: l.rule,
    times_applied: l.times_applied || 0,
    success_count: l.success_count || 0,
    failure_count: l.failure_count || 0,
    win_rate: (l.times_applied || 0) > 0 ? (l.success_count || 0) / (l.times_applied || 0) : 0,
    last_used: l.last_used,
    status: l.tags?.includes("deprecated") ? "deprecated" : "active",
  })).sort((a, b) => b.win_rate - a.win_rate);
}

// ─── Performance History ───────────────────────────────────────

function loadPerf() {
  if (!fs.existsSync(PERF_FILE)) return { trades: [] };
  try { return JSON.parse(fs.readFileSync(PERF_FILE, "utf8")); }
  catch { return { trades: [] }; }
}

function savePerf(data) {
  fs.writeFileSync(PERF_FILE, JSON.stringify(data, null, 2));
}

export function recordTradeOutcome({
  mint,
  symbol,
  entry_usd,
  exit_usd,
  pnl_pct,
  hold_minutes,
  exit_reason,
  rug_detected = false,
  attribution = null,
}) {
  const perf = loadPerf();
  perf.trades.push({
    ts: new Date().toISOString(),
    mint,
    symbol,
    entry_usd,
    exit_usd,
    pnl_pct: parseFloat((pnl_pct || 0).toFixed(2)),
    hold_minutes: Math.floor(hold_minutes || 0),
    exit_reason,
    rug_detected,
    win: (pnl_pct || 0) > 0,
    attribution,
  });
  // Keep last 500 trades
  if (perf.trades.length > 500) perf.trades = perf.trades.slice(-500);
  savePerf(perf);

  // Auto-learn: if rug detected, write a lesson
  if (rug_detected && mint) {
    addLesson(
      `AVOID token like ${symbol || mint.slice(0, 8)}: was a rug. exit_reason=${exit_reason}`,
      ["rug", "auto"],
      { role: "SCREENER" }
    );
  }
  // Auto-learn: if big loss and not a rug, pattern analysis
  if (!rug_detected && (pnl_pct || 0) < -20 && hold_minutes < 10) {
    addLesson(
      `Token ${symbol || mint?.slice(0, 8)} dumped ${pnl_pct?.toFixed(0)}% in ${Math.floor(hold_minutes || 0)}min. Avoid similar fast dumps.`,
      ["loss", "fast_dump", "auto"],
      { role: "SCREENER" }
    );
  }
}

export function getPerformanceSummary() {
  const perf = loadPerf();
  const trades = perf.trades;
  if (trades.length === 0) return "No trade history yet.";

  const wins = trades.filter(t => t.win);
  const rugs = trades.filter(t => t.rug_detected);
  const recent = trades.slice(-20);
  const recentWins = recent.filter(t => t.win);
  const avgPnl = trades.reduce((s, t) => s + (t.pnl_pct || 0), 0) / trades.length;
  const avgHold = trades.reduce((s, t) => s + (t.hold_minutes || 0), 0) / trades.length;

  return [
    `Trades: ${trades.length} | Win Rate: ${wins.length}/${trades.length} (${((wins.length/trades.length)*100).toFixed(0)}%)`,
    `Recent (last 20): ${recentWins.length}/20 wins`,
    `Avg PnL: ${avgPnl.toFixed(1)}% | Avg Hold: ${Math.floor(avgHold)}min`,
    `Rugs Detected: ${rugs.length}`,
  ].join("\n");
}

export function getPerformanceHistory({ limit = 20 } = {}) {
  const perf = loadPerf();
  return perf.trades.slice(-limit);
}

export function clearPerformance() {
  const perf = loadPerf();
  const n = perf.trades.length;
  savePerf({ trades: [] });
  return n;
}

// ─── Rug Memory ────────────────────────────────────────────────

function loadRugMemory() {
  if (!fs.existsSync(RUG_FILE)) return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [] };
  try { return JSON.parse(fs.readFileSync(RUG_FILE, "utf8")); }
  catch { return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [] }; }
}

function saveRugMemory(data) {
  fs.writeFileSync(RUG_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record a rug/scam token for future training.
 */
export function recordRug({ mint, symbol, creator, launchpad, rug_signals, pattern_notes }) {
  const mem = loadRugMemory();

  // Blacklist the token
  if (mint && !mem.blacklisted_tokens.includes(mint)) {
    mem.blacklisted_tokens.push(mint);
  }
  // Blacklist the creator/dev
  if (creator && !mem.blacklisted_devs.includes(creator)) {
    mem.blacklisted_devs.push(creator);
    // Also add a lesson
    addLesson(
      `DEV ${creator.slice(0, 12)} created rug token ${symbol || mint?.slice(0, 8)}. Block this dev.`,
      ["rug", "dev", "auto"],
      { role: "SCREENER" }
    );
  }

  // Store pattern
  mem.patterns.push({
    ts: new Date().toISOString(),
    mint,
    symbol,
    creator,
    launchpad,
    rug_signals: rug_signals || {},
    notes: pattern_notes || "",
  });

  if (mem.patterns.length > 200) mem.patterns = mem.patterns.slice(-200);
  saveRugMemory(mem);

  // Auto-cluster: every new rug recompiles learned patterns.
  // Cheap (≤200 entries, single pass) and keeps the rule set fresh.
  try {
    const before = _learnedPatternCount();
    const result = learnPatterns();
    const after = result?.learned ?? before;
    if (after > before) {
      addLesson(
        `Rug pattern engine learned ${after - before} new fingerprint(s) (total: ${after}).`,
        ["rug", "pattern", "auto"],
        { role: "SCREENER" }
      );
    }
  } catch (e) {
    // Pattern learning failure must never block rug recording.
  }
}

function _learnedPatternCount() {
  try {
    const f = path.join(__dirname, "rug-patterns-learned.json");
    if (!fs.existsSync(f)) return 0;
    return (JSON.parse(fs.readFileSync(f, "utf8")).patterns || []).length;
  } catch { return 0; }
}

/**
 * Score a token against known rug patterns (0=safe, 100=certain rug).
 * Higher score = more suspicious.
 */
export function scoreRugRisk({ mint, creator, launchpad, rug_signals = {} }) {
  const mem = loadRugMemory();
  let score = 0;
  const reasons = [];

  // Hard blocks
  if (mint && mem.blacklisted_tokens.includes(mint)) {
    return { score: 100, reasons: ["Token is blacklisted (known rug)"] };
  }
  if (creator && mem.blacklisted_devs.includes(creator)) {
    score += 70;
    reasons.push(`Dev ${creator.slice(0, 12)} has rug history`);
  }

  // Check launchpad patterns
  const rugLaunchpads = mem.patterns
    .filter(p => p.launchpad)
    .reduce((acc, p) => { acc[p.launchpad] = (acc[p.launchpad] || 0) + 1; return acc; }, {});
  if (launchpad && rugLaunchpads[launchpad] >= 3) {
    score += 20;
    reasons.push(`Launchpad ${launchpad} had ${rugLaunchpads[launchpad]} rugs`);
  }

  // ─── Layer 1: Token-2022 hard blocks ──────────────────────
  const rs = rug_signals;
  if (rs._collector_error) {
    return { score: 100, reasons: [`Security collector failed: ${rs._collector_error}`] };
  }
  if (rs._helius_expected && rs._helius_degraded) {
    return { score: 100, reasons: [`Helius enrichment unavailable: ${rs._helius_reason || "critical rug telemetry missing"}`] };
  }
  if (rs.non_transferable) {
    return { score: 100, reasons: ["Token is non-transferable (soulbound) — cannot sell"] };
  }
  if (rs.transfer_hook) {
    return { score: 100, reasons: [`Transfer hook program ${rs.transfer_hook.slice(0, 12)} — almost certainly honeypot`] };
  }
  if (rs.permanent_delegate) {
    return { score: 100, reasons: [`Permanent delegate ${rs.permanent_delegate.slice(0, 12)} can confiscate holdings`] };
  }
  if (rs.transfer_fee_bps >= 1000) {
    return { score: 100, reasons: [`Transfer fee ${rs.transfer_fee_bps / 100}% — extraction tax`] };
  }
  if (rs.default_frozen) {
    score += 70; reasons.push("Default account state = frozen (sell needs unfreeze)");
  }
  if (rs.transfer_fee_bps >= 500 && rs.transfer_fee_bps < 1000) {
    score += 50; reasons.push(`Transfer fee ${rs.transfer_fee_bps / 100}%`);
  }

  // ─── Standard rug signals ────────────────────────────────
  if (rs.top10_concentration_pct > 70) {
    if (rs.context_allows_concentration) {
      score += 8; reasons.push(`Top10 holds ${rs.top10_concentration_pct}% but context is strong enough that this is caution, not auto-rug`);
    } else {
      score += 20; reasons.push(`Top10 holds ${rs.top10_concentration_pct}%`);
    }
  }
  if (rs.fresh_funded_holders >= 5)    { score += 15; reasons.push(`${rs.fresh_funded_holders} holders funded <24h`); }
  if (rs.dust_holders >= 5)            { score += 10; reasons.push(`${rs.dust_holders} top holders almost empty SOL`); }
  if (rs.freeze_authority)             { score += 15; reasons.push("Freeze authority active"); }
  if (rs.mint_authority)               { score += 15; reasons.push("Mint authority active"); }
  if (rs.is_honeypot)                  { score += 40; reasons.push("Is honeypot"); }
  if (rs.creator_pct > 20)             { score += 20; reasons.push(`Creator holds ${rs.creator_pct}%`); }
  if (rs.max_holder_pct > 10 && !rs.context_allows_concentration) {
    score += 10; reasons.push(`Single holder controls ${rs.max_holder_pct}% in weak context`);
  }

  // ─── Layer 2: Helius behavioural signals ─────────────────
  if (rs.bundled) {
    score += 25; reasons.push(`Bundled launch: ${rs.bundled_score || 0} holders funded by same wallet within launch window`);
  }
  if (rs.supply_concentrated) {
    score += 20; reasons.push(`Top20 holders control ${rs.top20_pct || 0}% supply`);
  }
  if (rs.bundle_buyers_pct > 30)       { score += 25; reasons.push(`${rs.bundle_buyers_pct}% bought in launch window — bundle snipers`); }
  if (rs.same_funder_holders >= 3)     { score += 20; reasons.push(`${rs.same_funder_holders} top holders share funder ${rs.common_funder?.slice(0, 8)} — sybil cluster`); }
  if (rs.lp_locked === false)          { score += 15; reasons.push("LP not locked"); }
  if (rs.wash_score >= 30)             { score += 10; reasons.push(`Wash trade pattern (ratio ${rs.buy_sell_ratio})`); }
  if (rs.hidden_wallet_control_score >= 70) {
    score += 22; reasons.push(`Hidden wallet control score ${rs.hidden_wallet_control_score}/100 — concentration may be disguised across wallets`);
  } else if (rs.hidden_wallet_control_score >= 40) {
    score += 12; reasons.push(`Hidden wallet control score ${rs.hidden_wallet_control_score}/100`);
  }
  if (rs.holder_structure_risk === "HIGH") {
    score += 15; reasons.push(rs.holder_context_note || "Holder structure looks coordinated");
  } else if (rs.holder_structure_risk === "MEDIUM") {
    score += 8; reasons.push(rs.holder_context_note || "Holder structure needs caution");
  }

  // ─── Layer 3: Pattern fingerprint matches ────────────────
  const patternMatches = matchPatterns(rs);
  const matchedPatternIds = [];
  for (const pat of patternMatches) {
    const appliedWeight = Number.isFinite(pat.effective_weight) ? pat.effective_weight : (pat.weight || 0);
    score += appliedWeight;
    matchedPatternIds.push(pat.pattern_id);
    const confidenceText = Number.isFinite(pat.confidence_score)
      ? Number(pat.confidence_score).toFixed(2)
      : "n/a";
    const provenance = pat.provenance?.sample_count != null
      ? ` [samples:${pat.provenance.sample_count}, conf:${confidenceText}]`
      : "";
    const softness = pat.soft_only ? "soft" : "hard";
    reasons.push(`Pattern match (${softness}): ${pat.pattern_id} (+${appliedWeight})${provenance}${pat.note ? " — " + pat.note : ""}`);
  }

  score = Math.min(100, score);

  return {
    score,
    risk_level: score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW",
    reasons,
    matched_patterns: matchedPatternIds,
  };
}

export function getRugMemorySummary() {
  const mem = loadRugMemory();
  return {
    blacklisted_tokens: mem.blacklisted_tokens.length,
    blacklisted_devs: mem.blacklisted_devs.length,
    known_patterns: mem.patterns.length,
    recent_rugs: mem.patterns.slice(-5).map(p => ({
      symbol: p.symbol,
      ts: p.ts,
    })),
  };
}

export function isDevBlocked(creator) {
  if (!creator) return false;
  const mem = loadRugMemory();
  return mem.blacklisted_devs.includes(creator);
}

export function isTokenBlacklisted(mint) {
  if (!mint) return false;
  const mem = loadRugMemory();
  return mem.blacklisted_tokens.includes(mint);
}

// ─── Darwin Signal Weighting ──────────────────────────────────

const DARWIN_FILE = path.join(__dirname, "darwin-weights.json");

function loadDarwinWeights() {
  if (!fs.existsSync(DARWIN_FILE)) {
    return {
      signals: {
        buy_vol: { weight: 1.0, success_count: 0, failure_count: 0 },
        hot_level: { weight: 1.0, success_count: 0, failure_count: 0 },
        swaps: { weight: 1.0, success_count: 0, failure_count: 0 },
        volume: { weight: 1.0, success_count: 0, failure_count: 0 },
        holders: { weight: 1.0, success_count: 0, failure_count: 0 },
      },
      last_updated: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(fs.readFileSync(DARWIN_FILE, "utf8"));
  } catch {
    return {
      signals: {
        buy_vol:  { weight: 1.0, success_count: 0, failure_count: 0 },
        hot_level:{ weight: 1.0, success_count: 0, failure_count: 0 },
        swaps:    { weight: 1.0, success_count: 0, failure_count: 0 },
        volume:   { weight: 1.0, success_count: 0, failure_count: 0 },
        holders:  { weight: 1.0, success_count: 0, failure_count: 0 },
      },
      last_updated: new Date().toISOString(),
    };
  }
}

function saveDarwinWeights(data) {
  data.last_updated = new Date().toISOString();
  fs.writeFileSync(DARWIN_FILE, JSON.stringify(data, null, 2));
}

/**
 * Update signal weights based on trade outcome.
 * Called when a trade closes: boost winning signals, decay losing signals.
 */
export function updateDarwinWeights(signalsTriggered = [], tradePnl = 0, config = {}) {
  const { boostFactor = 1.05, decayFactor = 0.95, weightFloor = 0.3, weightCeiling = 2.5 } = config;
  const data = loadDarwinWeights();
  const isWin = tradePnl > 0;

  for (let signal of signalsTriggered) {
    if (!data.signals[signal]) continue;

    if (isWin) {
      data.signals[signal].success_count++;
      data.signals[signal].weight *= boostFactor;
    } else {
      data.signals[signal].failure_count++;
      data.signals[signal].weight *= decayFactor;
    }

    // Clamp to floor/ceiling
    data.signals[signal].weight = Math.max(
      weightFloor,
      Math.min(weightCeiling, data.signals[signal].weight)
    );
  }

  saveDarwinWeights(data);
}

/**
 * Get current Darwin signal weights for token ranking.
 */
export function getDarwinWeights() {
  const data = loadDarwinWeights();
  return data.signals;
}

/**
 * Get Darwin signal analytics: win rates, weights, etc.
 */
export function getDarwinAnalytics() {
  const data = loadDarwinWeights();
  return Object.entries(data.signals).map(([signal, stats]) => ({
    signal,
    weight: stats.weight,
    success_count: stats.success_count,
    failure_count: stats.failure_count,
    total_uses: stats.success_count + stats.failure_count,
    win_rate: (stats.success_count + stats.failure_count) > 0
      ? (stats.success_count / (stats.success_count + stats.failure_count))
      : 0,
  })).sort((a, b) => b.weight - a.weight);
}
