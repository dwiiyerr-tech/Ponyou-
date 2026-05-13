/**
 * Persistent Lessons & Performance Memory.
 *
 * Lessons: agent-written rules learned from trade outcomes.
 * Performance: historical trade records for win-rate analysis.
 * Rug Memory: token/dev patterns identified as scams.
 */

import fs from "fs";

const LESSONS_FILE = "./lessons.json";
const PERF_FILE    = "./performance.json";
const RUG_FILE     = "./rug-memory.json";

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
  if (combined.length === 0) return "";

  const lines = combined.map(l => {
    const pin = l.pinned ? "[PINNED] " : "";
    const tags = l.tags.length ? ` [${l.tags.join(",")}]` : "";
    const winRate = l.times_applied > 0 ? ((l.success_count / l.times_applied) * 100).toFixed(0) : "N/A";
    return `• ${pin}${l.rule}${tags} (${winRate}% WR, ${l.times_applied} uses)`;
  });
  return lines.join("\n");
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

  // Auto-deprecate ineffective lessons
  for (let lesson of data.lessons) {
    if ((lesson.times_applied || 0) > 30) {
      const winRate = lesson.success_count / lesson.times_applied;
      if (winRate < 0.4 && !lesson.tags?.includes("pinned")) {
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

  // Rug signal scoring
  const rs = rug_signals;
  if (rs.top10_concentration_pct > 70) { score += 20; reasons.push(`Top10 holds ${rs.top10_concentration_pct}%`); }
  if (rs.fresh_funded_holders >= 5)    { score += 15; reasons.push(`${rs.fresh_funded_holders} holders funded <24h`); }
  if (rs.dust_holders >= 5)            { score += 10; reasons.push(`${rs.dust_holders} top holders almost empty SOL`); }
  if (rs.freeze_authority)             { score += 15; reasons.push("Freeze authority active"); }
  if (rs.mint_authority)               { score += 15; reasons.push("Mint authority active"); }
  if (rs.is_honeypot)                  { score += 40; reasons.push("Is honeypot"); }
  if (rs.creator_pct > 20)             { score += 20; reasons.push(`Creator holds ${rs.creator_pct}%`); }

  score = Math.min(100, score);

  return {
    score,
    risk_level: score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW",
    reasons,
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
