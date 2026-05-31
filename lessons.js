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
import { atomicWriteJson } from "./atomic-write.js";
import { matchPatterns, learnPatterns } from "./tools/rug-patterns.js";
import { getHolderMemoryRules } from "./holder-memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = process.env.PONYOU_LESSONS_FILE    || path.join(__dirname, "lessons.json");
const PERF_FILE    = process.env.PONYOU_PERF_FILE       || path.join(__dirname, "performance.json");
const RUG_FILE     = process.env.PONYOU_RUG_MEMORY_FILE || path.join(__dirname, "rug-memory.json");

// ─── Lessons ──────────────────────────────────────────────────

function loadLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [] };
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); }
  catch { return { lessons: [] }; }
}

function saveLessons(data) {
  atomicWriteJson(LESSONS_FILE, data);
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
  atomicWriteJson(PERF_FILE, data);
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
  entry_sol = null,
  exit_sol = null,
  swap_fee_sol = null,
  actual_realized_pct = null,
}) {
  const perf = loadPerf();

  // ─── PnL reconciliation ──────────────────────────────────────
  // Cross-check recorded pnl_pct against (exit_usd - entry_usd) / entry_usd.
  // Log warning if discrepancy > 5% — this signals feed/timing skew.
  let reconciled_pnl_pct = parseFloat((pnl_pct || 0).toFixed(2));
  if (entry_usd > 0 && Number.isFinite(exit_usd) && exit_usd > 0) {
    const derivedPnl = ((exit_usd - entry_usd) / entry_usd) * 100;
    const drift = Math.abs(reconciled_pnl_pct - derivedPnl);
    if (drift > 5) {
      console.warn(`[pnl_reconciliation] DRIFT ${drift.toFixed(1)}%: recorded=${reconciled_pnl_pct.toFixed(1)}% derived=${derivedPnl.toFixed(1)}% for ${symbol || mint?.slice(0, 8)}`);
      // Persist reconciliation warnings for diagnostics
      if (!perf._reconciliation_warnings) perf._reconciliation_warnings = [];
      perf._reconciliation_warnings.push({
        ts: new Date().toISOString(),
        mint,
        symbol,
        recorded_pnl: reconciled_pnl_pct,
        derived_pnl: parseFloat(derivedPnl.toFixed(2)),
        drift_pct: parseFloat(drift.toFixed(2)),
      });
      if (perf._reconciliation_warnings.length > 50) perf._reconciliation_warnings = perf._reconciliation_warnings.slice(-50);
    }
  }

  // ─── SOL-in / SOL-out tracking ───────────────────────────────
  let sol_pnl_pct = null;
  if (entry_sol > 0 && exit_sol != null && Number.isFinite(exit_sol)) {
    sol_pnl_pct = parseFloat((((exit_sol - entry_sol) / entry_sol) * 100).toFixed(2));
  }

  perf.trades.push({
    ts: new Date().toISOString(),
    mint,
    symbol,
    entry_usd,
    exit_usd,
    pnl_pct: reconciled_pnl_pct,
    sol_pnl_pct,
    entry_sol: entry_sol != null ? parseFloat(entry_sol.toFixed(6)) : null,
    exit_sol: exit_sol != null ? parseFloat(exit_sol.toFixed(6)) : null,
    swap_fee_sol: swap_fee_sol != null ? parseFloat(swap_fee_sol.toFixed(6)) : null,
    actual_realized_pct: actual_realized_pct != null ? parseFloat(actual_realized_pct.toFixed(2)) : null,
    hold_minutes: Math.floor(hold_minutes || 0),
    exit_reason,
    rug_detected,
    win: (reconciled_pnl_pct || 0) > 0,
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
  const totalUsdPnl = trades.reduce((s, t) => s + ((t.entry_usd || 0) * (t.pnl_pct || 0) / 100), 0);
  const reconciliationWarnings = perf._reconciliation_warnings?.length || 0;

  return [
    `Trades: ${trades.length} | Win Rate: ${wins.length}/${trades.length} (${((wins.length/trades.length)*100).toFixed(0)}%)`,
    `Recent (last 20): ${recentWins.length}/20 wins`,
    `Avg PnL: ${avgPnl.toFixed(1)}% | Avg Hold: ${Math.floor(avgHold)}min | Cumul. PnL: ${totalUsdPnl >= 0 ? '+' : ''}$${totalUsdPnl.toFixed(2)}`,
    `Rugs Detected: ${rugs.length}` + (reconciliationWarnings > 0 ? ` | PnL Drift Warnings: ${reconciliationWarnings}` : ''),
  ].join("\n");
}

export function getPerformanceHistory({ limit = 20 } = {}) {
  const perf = loadPerf();
  return perf.trades.slice(-limit);
}

export function getReconciliationWarnings() {
  const perf = loadPerf();
  return perf._reconciliation_warnings || [];
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
  atomicWriteJson(RUG_FILE, data);
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
  // LS-6: only add the "Block this dev" lesson when the dev is FIRST
  // blacklisted. The previous code only added a lesson on first blacklist
  // already (it's inside the `!mem.blacklisted_devs.includes(creator)`
  // branch), but the same dev could land in our system with a different
  // capitalization or trailing whitespace from an upstream source — leading
  // to duplicate "block this dev" lessons. Normalize the comparison.
  const normalizedCreator = creator ? String(creator).trim() : null;
  const devAlreadyKnown = normalizedCreator
    ? mem.blacklisted_devs.some(d => String(d).trim() === normalizedCreator)
    : false;
  if (normalizedCreator && !devAlreadyKnown) {
    mem.blacklisted_devs.push(normalizedCreator);
    // Also add a lesson — only the FIRST time we see this dev
    addLesson(
      `DEV ${normalizedCreator.slice(0, 12)} created rug token ${symbol || mint?.slice(0, 8)}. Block this dev.`,
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
    const f = process.env.PONYOU_RUG_PATTERNS_FILE || path.join(__dirname, "rug-patterns-learned.json");
    if (!fs.existsSync(f)) return 0;
    return (JSON.parse(fs.readFileSync(f, "utf8")).patterns || []).length;
  } catch { return 0; }
}

/**
 * Score a token against known rug patterns (0=safe, 100=certain rug).
 * Higher score = more suspicious.
 */
export function scoreRugRisk({ mint, creator, launchpad, rug_signals = {}, mcap = null }) {
  const mem = loadRugMemory();
  let score = 0;
  const reasons = [];

  // ─── Market cap tier awareness ────────────────────────────
  // Rug patterns differ by FDV. A signal that's normal at $10K
  // is highly suspicious at $10M. Apply per-tier multipliers.
  const mcapVal = Number(mcap || 0);
  const tier = mcapVal >= 50_000_000 ? "HIGH_CAP"
    : mcapVal >= 5_000_000  ? "MID_CAP"
    : mcapVal >= 100_000    ? "MICRO_CAP"
    : "NEW_PAIR";

  // Per-tier signal weight multipliers (>1.0 = more suspicious at this tier)
  const tierMultipliers = {
    NEW_PAIR: {
      bundle_buy: 0.7,       // expected on new pairs — less suspicious
      supply_conc: 0.8,       // normal for fresh launches
      same_funder: 0.8,       // common at micro scale
      creator_heavy: 1.0,     // neutral — dev bag matters at any tier
      lp_unlocked: 1.3,       // VERY dangerous on new pairs
      transfer_hook: 1.2,     // honeypot is honeypot
      wash_trade: 0.6,        // low volume makes this less reliable
      hidden_control: 0.7,    // less relevant at micro scale
    },
    MICRO_CAP: {
      bundle_buy: 1.0,        // baseline
      supply_conc: 1.0,
      same_funder: 1.0,
      creator_heavy: 1.0,
      lp_unlocked: 1.1,
      transfer_hook: 1.0,
      wash_trade: 0.8,
      hidden_control: 1.0,
    },
    MID_CAP: {
      bundle_buy: 1.3,        // more suspicious — organic demand expected
      supply_conc: 1.2,       // concentration at $5M+ is concerning
      same_funder: 1.4,       // coordinated wallets at mid cap = cabal
      creator_heavy: 1.1,
      lp_unlocked: 0.9,       // deeper liquidity, less instant-rug risk
      transfer_hook: 1.0,
      wash_trade: 1.3,        // wash trading to simulate volume
      hidden_control: 1.4,    // hidden coordination is key mid-cap risk
    },
    HIGH_CAP: {
      bundle_buy: 1.5,        // bundle at $50M+ = almost certainly insider
      supply_conc: 1.5,       // concentrated supply at high cap = whale trap
      same_funder: 1.6,       // coordinated wallets at high cap = institutional rug
      creator_heavy: 1.2,
      lp_unlocked: 0.7,       // high cap has deeper LP, less rug risk
      transfer_hook: 0.8,     // rare at high cap
      wash_trade: 1.5,        // engineered volume for exit liquidity
      hidden_control: 1.8,    // the #1 high-cap rug pattern
    },
  };

  const multipliers = tierMultipliers[tier] || tierMultipliers.MICRO_CAP;

  // Hard blocks
  if (mint && mem.blacklisted_tokens.includes(mint)) {
    return { score: 100, risk_level: "HIGH", reasons: ["Token is blacklisted (known rug)"], matched_patterns: [] };
  }
  if (creator && mem.blacklisted_devs.includes(creator)) {
    score += 70;
    reasons.push(`Dev ${creator.slice(0, 12)} has rug history`);
  }

  // ─── Launchpad reputation ──────────────────────────────────
  // Launchpads with high historical rug rates get a baseline penalty.
  // This is DexScreener-level data (free) — no Helius cost.
  if (launchpad) {
    const HIGH_RISK_LAUNCHPADS = new Set(["pump.fun"]);
    const launchpadLower = launchpad.toLowerCase();
    if (HIGH_RISK_LAUNCHPADS.has(launchpadLower)) {
      score += 10;
      reasons.push(`Launchpad ${launchpad} has elevated rug history — baseline caution applied`);
    }
    const rugLaunchpads = mem.patterns
      .filter(p => p.launchpad)
      .reduce((acc, p) => { acc[p.launchpad] = (acc[p.launchpad] || 0) + 1; return acc; }, {});
    if (launchpad && rugLaunchpads[launchpad] >= 3) {
      score += 20;
      reasons.push(`Launchpad ${launchpad} had ${rugLaunchpads[launchpad]} rugs`);
    }
  }

  // ─── Wire trash-filter flags into scoring ─────────────────
  if (rug_signals._trash_flags?.length > 0) {
    for (const flag of rug_signals._trash_flags) {
      switch (flag) {
        case "very_young":          score += 10; reasons.push("Token <2min old — insufficient data"); break;
        case "already_pumping":     score += 18; reasons.push("Already pumped >500% — extremely high risk of late entry"); break;
        case "dumping_hard":        score += 15; reasons.push("Dumping >60% in 5min"); break;
        case "suspicious_avg_trade_size": score += 10; reasons.push("Suspicious avg trade size"); break;
        case "dust_trading":        score += 10; reasons.push("Dust-level avg trade — no real volume"); break;
        case "long_symbol":         score += 3;  reasons.push("Unusually long ticker symbol"); break;
        case "fresh_copycat":       score += 20; reasons.push("Symbol matches recently rugged token"); break;
        case "suspicious_buy_pattern": score += 18; reasons.push("Suspicious buy pattern — likely self-trading"); break;
        case "heavy_selling":       score += 12; reasons.push("Heavy selling pressure at discovery"); break;
        case "mcap_zero_or_nan":    score += 12; reasons.push("Market cap data unavailable — unknown valuation"); break;
        default:
          if (flag.startsWith("high_risk_launchpad:")) {
            const lp = flag.split(":")[1];
            score += 8;
            reasons.push(`High-risk launchpad: ${lp}`);
          }
          break;
      }
    }
  }

  // ─── Layer 1: Token-2022 hard blocks ──────────────────────
  const rs = rug_signals;
  if (rs._collector_error) {
    return { score: 100, risk_level: "HIGH", reasons: [`Security collector failed: ${rs._collector_error}`], matched_patterns: [] };
  }
  if (rs._helius_expected && rs._helius_degraded) {
    return { score: 100, risk_level: "HIGH", reasons: [`Helius enrichment unavailable: ${rs._helius_reason || "critical rug telemetry missing"}`], matched_patterns: [] };
  }
  if (rs.non_transferable) {
    return { score: 100, risk_level: "HIGH", reasons: ["Token is non-transferable (soulbound) — cannot sell"], matched_patterns: [] };
  }
  if (rs.transfer_hook) {
    return { score: 100, risk_level: "HIGH", reasons: [`Transfer hook program ${rs.transfer_hook.slice(0, 12)} — almost certainly honeypot`], matched_patterns: [] };
  }
  if (rs.permanent_delegate) {
    return { score: 100, risk_level: "HIGH", reasons: [`Permanent delegate ${rs.permanent_delegate.slice(0, 12)} can confiscate holdings`], matched_patterns: [] };
  }
  if (rs.transfer_fee_bps >= 1000) {
    return { score: 100, risk_level: "HIGH", reasons: [`Transfer fee ${rs.transfer_fee_bps / 100}% — extraction tax`], matched_patterns: [] };
  }
  if (rs.default_frozen) {
    score += 70; reasons.push("Default account state = frozen (sell needs unfreeze)");
  }
  if (rs.transfer_fee_bps >= 500 && rs.transfer_fee_bps < 1000) {
    score += 50; reasons.push(`Transfer fee ${rs.transfer_fee_bps / 100}%`);
  }

  // ─── Standard rug signals ────────────────────────────────
  // Apply per-tier multipliers: what's normal at $10K is suspicious at $10M
  const M = (key, baseScore) => Math.round(baseScore * (multipliers[key] ?? 1.0));
  const Mnote = (key) => multipliers[key] !== 1.0 ? ` [${tier} ×${multipliers[key].toFixed(1)}]` : "";

  if (rs.top10_concentration_pct > 70) {
    if (rs.context_allows_concentration) {
      score += M("supply_conc", 8); reasons.push(`Top10 holds ${rs.top10_concentration_pct}% but context is strong enough that this is caution, not auto-rug`);
    } else {
      score += M("supply_conc", 20); reasons.push(`Top10 holds ${rs.top10_concentration_pct}%${Mnote("supply_conc")}`);
    }
  }
  if (rs.fresh_funded_holders >= 5)    { score += 15; reasons.push(`${rs.fresh_funded_holders} holders funded <24h`); }
  if (rs.dust_holders >= 5)            { score += 10; reasons.push(`${rs.dust_holders} top holders almost empty SOL`); }
  if (rs.freeze_authority)             { score += 15; reasons.push("Freeze authority active"); }
  if (rs.mint_authority)               { score += 15; reasons.push("Mint authority active"); }
  if (rs.is_honeypot)                  { score += 40; reasons.push("Is honeypot"); }
  if (rs.creator_pct > 20)             { score += M("creator_heavy", 20); reasons.push(`Creator holds ${rs.creator_pct}%${Mnote("creator_heavy")}`); }
  if (rs.max_holder_pct > 10 && !rs.context_allows_concentration) {
    score += 10; reasons.push(`Single holder controls ${rs.max_holder_pct}% in weak context`);
  }

  // ─── Layer 2: Helius behavioural signals ─────────────────
  if (rs.bundled) {
    score += M("bundle_buy", 25); reasons.push(`Bundled launch: ${rs.bundled_score || 0} holders funded by same wallet within launch window${Mnote("bundle_buy")}`);
  }
  if (rs.supply_concentrated) {
    score += M("supply_conc", 20); reasons.push(`Top20 holders control ${rs.top20_pct || 0}% supply${Mnote("supply_conc")}`);
  }
  if (rs.bundle_buyers_pct > 30)       { score += M("bundle_buy", 25); reasons.push(`${rs.bundle_buyers_pct}% bought in launch window — bundle snipers${Mnote("bundle_buy")}`); }
  if (rs.same_funder_holders >= 3)     { score += M("same_funder", 20); reasons.push(`${rs.same_funder_holders} top holders share funder ${rs.common_funder?.slice(0, 8)} — sybil cluster${Mnote("same_funder")}`); }
  if (rs.lp_locked === false)          { score += M("lp_unlocked", 15); reasons.push(`LP not locked${Mnote("lp_unlocked")}`); }
  if (rs.wash_score >= 30)             { score += M("wash_trade", 10); reasons.push(`Wash trade pattern (ratio ${rs.buy_sell_ratio})${Mnote("wash_trade")}`); }
  if (rs.hidden_wallet_control_score >= 70) {
    score += M("hidden_control", 22); reasons.push(`Hidden wallet control score ${rs.hidden_wallet_control_score}/100 — concentration may be disguised across wallets${Mnote("hidden_control")}`);
  } else if (rs.hidden_wallet_control_score >= 40) {
    score += M("hidden_control", 12); reasons.push(`Hidden wallet control score ${rs.hidden_wallet_control_score}/100${Mnote("hidden_control")}`);
  }
  if (rs.holder_structure_risk === "HIGH") {
    score += 15; reasons.push(rs.holder_context_note || "Holder structure looks coordinated");
  } else if (rs.holder_structure_risk === "MEDIUM") {
    score += 8; reasons.push(rs.holder_context_note || "Holder structure needs caution");
  }

  // ─── Layer 2c: GMGN security audit ───────────────────────
  // Rich rug fields from GMGN /token/security (honeypot, sellability, renounce
  // status, trade tax). Additive only — GMGN security is never a sole hard-block
  // (its booleans can be stale/null), so we score rather than return 100.
  const gs = rs.gmgn_security;
  if (gs) {
    if (gs.honeypot)             { score += 40; reasons.push("GMGN: honeypot flagged"); }
    if (gs.cannot_sell)          { score += 35; reasons.push("GMGN: token cannot be sold"); }
    if (gs.blacklist)            { score += 30; reasons.push("GMGN: blacklist function present"); }
    if (gs.mint_not_renounced)   { score += M("hidden_control", 15); reasons.push(`GMGN: mint authority not renounced${Mnote("hidden_control")}`); }
    if (gs.freeze_not_renounced) { score += M("hidden_control", 15); reasons.push(`GMGN: freeze authority not renounced${Mnote("hidden_control")}`); }
    const tax = Math.max(gs.sell_tax ?? 0, gs.buy_tax ?? 0);
    if (tax >= 0.5)              { score += 40; reasons.push(`GMGN: ${(tax * 100).toFixed(0)}% trade tax — extraction`); }
    else if (tax >= 0.10)        { score += 20; reasons.push(`GMGN: ${(tax * 100).toFixed(0)}% trade tax`); }
    if (gs.hide_risk)            { score += 10; reasons.push("GMGN: hidden-risk flag set"); }
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

export function getRugMemory() {
  return loadRugMemory();
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

const DARWIN_FILE = process.env.PONYOU_DARWIN_FILE || path.join(__dirname, "darwin-weights.json");

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
  atomicWriteJson(DARWIN_FILE, data);
}

/**
 * Update signal weights based on trade outcome.
 * Called when a trade closes: boost winning signals, decay losing signals.
 */
// LS-4: track unknown-signal occurrences so the operator sees once per
// process that a signal name we just received isn't in the Darwin registry.
// Without this, typo'd or newly-introduced signal names were silently
// dropped from the weighting loop and the operator had no clue.
const _unknownDarwinSignalsSeen = new Set();

export function updateDarwinWeights(signalsTriggered = [], tradePnl = 0, config = {}) {
  const { boostFactor = 1.05, decayFactor = 0.95, weightFloor = 0.3, weightCeiling = 2.5 } = config;
  const data = loadDarwinWeights();
  const isWin = tradePnl > 0;

  for (let signal of signalsTriggered) {
    if (!data.signals[signal]) {
      if (signal && !_unknownDarwinSignalsSeen.has(signal)) {
        _unknownDarwinSignalsSeen.add(signal);
        console.warn(`[darwin] unknown signal "${signal}" — not in registry; add it to darwin-weights.json or check for a typo`);
      }
      continue;
    }

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
