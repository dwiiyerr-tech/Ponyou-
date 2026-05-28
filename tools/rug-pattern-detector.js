/**
 * Rug Pattern Detector (Improvement C)
 *
 * Identify coordinated multi-wallet rug patterns by analyzing:
 *   1. Timing correlation: Do wallets sell at same time (within ±2min)?
 *   2. Amount correlation: Do they dump similar amounts (±10% of avg)?
 *   3. Sequence correlation: Is there a coordinated sequence pattern?
 *   4. Network correlation: Can we detect IP/infrastructure patterns?
 *
 * Rug signatures:
 *   - Pump pattern: many buys in 5min window, then coordinated exit
 *   - Ladder dump: sequential sells to avoid slippage (wallet1→2→3)
 *   - Flash dump: all 5+ holders dump >50% in <30sec (likely rugpull)
 *   - Staged exit: holders exit in phases (dev1, dev2, dev3 over 5min)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// rug-patterns.js (clustering) already owns rug-patterns-seed.json +
// rug-patterns-learned.json. Use a distinct filename to avoid confusion.
const PATTERN_DETECTIONS_FILE = path.join(__dirname, "..", "rug-pattern-detections.json");

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function loadPatterns() {
  if (!fs.existsSync(PATTERN_DETECTIONS_FILE)) return { detections: [] };
  try {
    return JSON.parse(fs.readFileSync(PATTERN_DETECTIONS_FILE, "utf8"));
  } catch {
    return { detections: [] };
  }
}

function savePatterns(data) {
  atomicWriteJson(PATTERN_DETECTIONS_FILE, data);
}

/**
 * Detect coordinated rug patterns from recent sell transactions.
 *
 * @param {Object} args
 * @param {string} args.tokenMint - Token mint
 * @param {Array} args.recentSells - [{address, amountUsd, timestamp, txSignature}]
 * @param {number} args.windowMinutes - Look for patterns within this window (default 5min)
 * @returns Pattern detection results
 */
export function detectRugPattern({
  tokenMint,
  tokenSymbol = null,
  recentSells = [],
  windowMinutes = 5,
} = {}) {
  if (!tokenMint || recentSells.length < 2) {
    return {
      pattern_detected: false,
      pattern_type: "UNKNOWN",
      confidence: 0,
      rug_risk: "LOW",
      signals: [],
      details: { sells_analyzed: recentSells.length },
    };
  }

  // Drop sells with invalid timestamps before sorting so NaN doesn't poison
  // the timing math below (a single invalid timestamp would make timeSpan NaN
  // and silently disable the timing-cluster + ladder signals).
  const validSells = recentSells.filter((s) => {
    const t = new Date(s?.timestamp).getTime();
    return Number.isFinite(t) && t > 0;
  });
  if (validSells.length < 2) {
    return {
      pattern_detected: false,
      pattern_type: "UNKNOWN",
      confidence: 0,
      rug_risk: "LOW",
      signals: [],
      details: { sells_analyzed: validSells.length, dropped: recentSells.length - validSells.length },
    };
  }

  // Sort by timestamp
  const sortedSells = [...validSells].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const signals = [];
  let score = 0;

  // 1. Timing Correlation: Do sells cluster within small window?
  const timeWindow = windowMinutes * 60 * 1000;
  const firstTime = new Date(sortedSells[0].timestamp).getTime();
  const lastTime = new Date(sortedSells[sortedSells.length - 1].timestamp).getTime();
  const timeSpan = lastTime - firstTime;

  if (timeSpan <= timeWindow && sortedSells.length >= 3) {
    signals.push({
      signal: "tight_timing_cluster",
      detail: `${sortedSells.length} sells in ${(timeSpan / 1000).toFixed(0)}sec`,
      strength: timeSpan < 30000 ? "CRITICAL" : "HIGH",
    });
    score += timeSpan < 30000 ? 30 : 20;
  }

  // 2. Amount Correlation: Are amounts similar (indicating coordinated wallets)?
  // Skip the check entirely when avgAmount is 0 — otherwise CV is 0 and we'd
  // incorrectly fire "uniform_dump_amounts" on a list of zero-value sells.
  const amounts = sortedSells.map((s) => safeNum(s.amountUsd || s.amount));
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  let coefficientOfVariation = 1; // sentinel: "high variation" = no signal
  if (avgAmount > 0) {
    const amountDeviation = Math.sqrt(
      amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length
    );
    coefficientOfVariation = amountDeviation / avgAmount;

    if (coefficientOfVariation < 0.15) {
      // CV < 15% = very consistent amounts
      signals.push({
        signal: "uniform_dump_amounts",
        detail: `All sells within ±${(coefficientOfVariation * 100).toFixed(0)}% of avg`,
        strength: "HIGH",
      });
      score += 20;
    } else if (coefficientOfVariation < 0.3) {
      // CV < 30% = moderately consistent
      signals.push({
        signal: "similar_dump_amounts",
        detail: `Amounts vary ~${(coefficientOfVariation * 100).toFixed(0)}%`,
        strength: "MEDIUM",
      });
      score += 10;
    }
  }

  // 3. Sequence Pattern: Check for ladder (sequential) or staged exits
  const timingDeltas = [];
  for (let i = 1; i < sortedSells.length; i++) {
    const delta = new Date(sortedSells[i].timestamp).getTime() -
                  new Date(sortedSells[i - 1].timestamp).getTime();
    timingDeltas.push(delta);
  }

  // Ladder pattern: consistent intervals between sells (e.g., 5sec, 5sec, 5sec)
  const avgDelta = timingDeltas.reduce((a, b) => a + b, 0) / timingDeltas.length;
  const deltaDeviation = Math.sqrt(
    timingDeltas.reduce((sum, d) => sum + Math.pow(d - avgDelta, 2), 0) / timingDeltas.length
  );
  const deltaCv = avgDelta > 0 ? deltaDeviation / avgDelta : 999;

  if (deltaCv < 0.5 && avgDelta < 10000) {
    // Intervals are consistent and short = likely coordinated
    signals.push({
      signal: "ladder_pattern",
      detail: `Sells every ${(avgDelta / 1000).toFixed(1)}sec (±${(deltaCv * 100).toFixed(0)}%) = orchestrated`,
      strength: "HIGH",
    });
    score += 20;
  }

  // 4. Flash dump: many holders sell >=50% of avg amount in very short time.
  // Requires a non-zero avgAmount — otherwise "a >= 0" matches every sell and
  // flash_dump triggers on noise.
  const largeExits = avgAmount > 0
    ? amounts.filter((a) => a >= avgAmount * 0.5).length
    : 0;
  if (largeExits >= 3 && timeSpan < 30000) {
    signals.push({
      signal: "flash_dump",
      detail: `${largeExits} large exits in ${(timeSpan / 1000).toFixed(0)}sec = likely rugpull`,
      strength: "CRITICAL",
    });
    score += 35;
  }

  // 5. Diversity check: Are these wallets likely coordinated or independent?
  // Exclude empty / missing addresses so an unknown-wallet batch doesn't get
  // mis-flagged as "same wallet sold multiple times".
  const nonEmptyAddrs = sortedSells.map((s) => s?.address).filter(Boolean);
  const uniqueAddresses = new Set(nonEmptyAddrs).size;
  if (nonEmptyAddrs.length >= 2 && uniqueAddresses !== nonEmptyAddrs.length) {
    // Duplicate addresses = same wallet selling multiple times
    signals.push({
      signal: "duplicate_wallet_sells",
      detail: `${nonEmptyAddrs.length} sells from only ${uniqueAddresses} unique wallets`,
      strength: "MEDIUM",
    });
    score += 15;
  }

  // Determine pattern type
  let pattern_type = "UNKNOWN";
  if (signals.some((s) => s.signal === "flash_dump")) {
    pattern_type = "FLASH_DUMP";
  } else if (signals.some((s) => s.signal === "ladder_pattern")) {
    pattern_type = "LADDER_EXIT";
  } else if (signals.some((s) => s.signal === "tight_timing_cluster")) {
    pattern_type = "COORDINATED_EXIT";
  } else if (signals.some((s) => s.signal === "uniform_dump_amounts")) {
    pattern_type = "SYNCHRONIZED_DUMP";
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  let rug_risk, recommendation;
  if (score >= 70) {
    rug_risk = "CRITICAL";
    recommendation = "IMMEDIATE_EXIT";
  } else if (score >= 50) {
    rug_risk = "HIGH";
    recommendation = "WATCH_CAREFULLY";
  } else if (score >= 30) {
    rug_risk = "MEDIUM";
    recommendation = "MONITOR";
  } else {
    rug_risk = "LOW";
    recommendation = "OK";
  }

  // Persist detection — only log high-confidence patterns. Serialize the
  // read-modify-write under file lock so concurrent positions don't race.
  // Fire-and-forget: caller doesn't depend on persistence to read result.
  if (score >= 30) {
    withFileLock(PATTERN_DETECTIONS_FILE, async () => {
      const store = loadPatterns();
      store.detections.push({
        mint: tokenMint,
        symbol: tokenSymbol,
        pattern_type,
        confidence: score,
        rug_risk,
        signals: signals.slice(0, 3),
        sells_count: sortedSells.length,
        time_window_sec: (timeSpan / 1000).toFixed(0),
        detected_at: nowIso(),
      });
      if (store.detections.length > 200) {
        store.detections = store.detections.slice(-200);
      }
      savePatterns(store);
    }).catch((err) => log("rug_pattern_warn", `persist failed: ${err.message}`));
  }

  return {
    pattern_detected: score >= 30,
    pattern_type,
    confidence: score,
    rug_risk,
    recommendation,
    signals: signals.slice(0, 5),
    details: {
      sells_analyzed: sortedSells.length,
      unique_wallets: uniqueAddresses,
      time_span_sec: (timeSpan / 1000).toFixed(0),
      avg_sell_amount: avgAmount.toFixed(2),
      amount_consistency_cv: (coefficientOfVariation * 100).toFixed(1),
      timing_consistency_cv: (deltaCv * 100).toFixed(1),
    },
  };
}

/**
 * Get recent rug pattern detections.
 */
export function getRecentRugPatterns(limit = 10) {
  const store = loadPatterns();
  return store.detections.slice(-limit).reverse();
}

/**
 * Check if a mint has a known rug pattern.
 */
export function hasKnownRugPattern(tokenMint) {
  const store = loadPatterns();
  return store.detections.some(
    (d) => d.mint === tokenMint && d.confidence >= 70
  );
}

/**
 * Get rug pattern statistics for reporting.
 */
export function getRugPatternStats() {
  const store = loadPatterns();
  const detections = store.detections;

  if (detections.length === 0) {
    return {
      total_patterns: 0,
      by_type: {},
      by_risk: {},
      last_detection: null,
    };
  }

  const byType = {};
  const byRisk = {};

  for (const d of detections) {
    byType[d.pattern_type] = (byType[d.pattern_type] || 0) + 1;
    byRisk[d.rug_risk] = (byRisk[d.rug_risk] || 0) + 1;
  }

  return {
    total_patterns: detections.length,
    by_type: byType,
    by_risk: byRisk,
    last_detection: detections[detections.length - 1]?.detected_at || null,
    high_risk_count: (byRisk.CRITICAL || 0) + (byRisk.HIGH || 0),
  };
}
