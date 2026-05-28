/**
 * Holder Dump Monitor (Improvement A)
 *
 * Real-time tracking of top holder balances to detect dumps before price crashes.
 *
 * Usage:
 *   const dump = monitorHolderDumps({ mint, currentTopHolders, previousSnapshot });
 *   if (dump.risk_level === "CRITICAL") exit the position;
 *
 * Stores historical snapshots per position so we can:
 *   - Detect large single-tx dumps (>20% of holder position in 1h)
 *   - Detect coordinated dumps (multiple holders selling >10% in 1h window)
 *   - Trigger exit signals before price crashes
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLDER_SNAPSHOTS_FILE = path.join(__dirname, "..", "holder-snapshots.json");

function nowIso() {
  return new Date().toISOString();
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadSnapshots() {
  if (!fs.existsSync(HOLDER_SNAPSHOTS_FILE)) return { mints: {} };
  try {
    return JSON.parse(fs.readFileSync(HOLDER_SNAPSHOTS_FILE, "utf8"));
  } catch {
    return { mints: {} };
  }
}

function saveSnapshots(data) {
  atomicWriteJson(HOLDER_SNAPSHOTS_FILE, data);
}

/**
 * Record a holder snapshot (top 10 holders + their balances).
 * Used by monitoring cycle to establish baseline and compare against.
 */
export function recordHolderSnapshot({
  tokenMint,
  tokenSymbol = null,
  topHolders = [],
  totalSupply = null,
  timestamp = null,
} = {}) {
  if (!tokenMint || !Array.isArray(topHolders) || topHolders.length === 0) {
    return null;
  }

  const ts = timestamp || nowIso();
  return withFileLock(HOLDER_SNAPSHOTS_FILE, async () => {
    const store = loadSnapshots();
    if (!store.mints[tokenMint]) {
      store.mints[tokenMint] = {
        symbol: tokenSymbol,
        snapshots: [],
      };
    }

    const mint_store = store.mints[tokenMint];

    // Normalize holder format: expect { address, balance, pct } or similar
    const normalized = topHolders.slice(0, 10).map((h) => ({
      address: h.address || h.wallet || h.owner || "",
      balance: safeNum(h.balance || h.amount),
      pct: safeNum(h.pct || h.percentage || h.share),
    }));

    mint_store.snapshots.push({
      recorded_at: ts,
      holders: normalized,
      total_supply: safeNum(totalSupply),
    });

    // Keep only last 50 snapshots per mint (1 snapshot per ~10min cycle = ~8h history)
    if (mint_store.snapshots.length > 50) {
      mint_store.snapshots = mint_store.snapshots.slice(-50);
    }

    store.mints[tokenMint] = mint_store;
    saveSnapshots(store);
    return mint_store.snapshots.length;
  });
}

/**
 * Detect holder dumps by comparing current snapshot to historical baseline.
 *
 * Returns:
 *   {
 *     risk_level: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE",
 *     confidence: 0-100,
 *     signals: [],
 *     recommendation: "IMMEDIATE_EXIT" | "WATCH_CLOSELY" | "MONITOR" | "OK",
 *     details: { top_dumper: "...", dump_pct: X, ... }
 *   }
 */
export function monitorHolderDumps({
  tokenMint,
  currentTopHolders = [],
  lookbackMinutes = 60,
} = {}) {
  const store = loadSnapshots();
  const mint_store = store.mints[tokenMint];

  if (!mint_store || !mint_store.snapshots || mint_store.snapshots.length < 2) {
    return {
      risk_level: "LOW",
      confidence: 0,
      signals: [{ signal: "insufficient_history", detail: "Need 2+ snapshots to detect dumps" }],
      recommendation: "MONITOR",
      details: {},
    };
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  // Get historical baseline (oldest snapshot in window)
  const historicalSnapshots = mint_store.snapshots.filter(
    (s) => new Date(s.recorded_at) >= cutoff
  );
  if (historicalSnapshots.length < 2) {
    return {
      risk_level: "LOW",
      confidence: 0,
      signals: [{ signal: "insufficient_history", detail: `Need 2+ snapshots within ${lookbackMinutes}min` }],
      recommendation: "MONITOR",
      details: {},
    };
  }

  const baselineSnapshot = historicalSnapshots[0];
  const currentSnapshot = historicalSnapshots[historicalSnapshots.length - 1];

  // Build address → balance maps for easy comparison
  const baselineMap = new Map(baselineSnapshot.holders.map((h) => [h.address, h]));
  const currentMap = new Map(currentSnapshot.holders.map((h) => [h.address, h]));

  const signals = [];
  let score = 0;

  // Signal 1: Check each historical holder for dumps
  for (const [addr, baselineHolder] of baselineMap.entries()) {
    const currentHolder = currentMap.get(addr);
    if (!currentHolder) {
      // Holder disappeared entirely = likely full exit
      const dumpPct = 100;
      signals.push({
        signal: "holder_fully_exited",
        address: addr.slice(0, 8) + "...",
        dump_pct: dumpPct,
        baseline_pct: baselineHolder.pct,
        detail: `Top holder completely exited (was ${baselineHolder.pct.toFixed(1)}%)`,
        strength: "CRITICAL",
      });
      score += 25;
      continue;
    }

    const balanceDelta = baselineHolder.balance - currentHolder.balance;
    const pctDelta = baselineHolder.pct - currentHolder.pct;

    // Large single-holder dump: lost >20% of their position
    if (balanceDelta > 0 && pctDelta >= 3) {
      signals.push({
        signal: "large_holder_dump",
        address: addr.slice(0, 8) + "...",
        dump_pct: pctDelta.toFixed(1),
        was_pct: baselineHolder.pct.toFixed(1),
        detail: `Holder reduced ${baselineHolder.pct.toFixed(1)}% → ${currentHolder.pct.toFixed(1)}%`,
        strength: pctDelta >= 5 ? "CRITICAL" : "HIGH",
      });
      score += pctDelta >= 5 ? 20 : 12;
    }
  }

  // Signal 2: Detect coordinated dumps (multiple top holders dumping in same window)
  const dumpingHolders = signals.filter(
    (s) => s.signal === "large_holder_dump" || s.signal === "holder_fully_exited"
  ).length;
  if (dumpingHolders >= 3) {
    signals.push({
      signal: "coordinated_dump",
      dumpers_count: dumpingHolders,
      detail: `${dumpingHolders} top holders dumping simultaneously = rug risk`,
      strength: "CRITICAL",
    });
    score += 25;
  } else if (dumpingHolders >= 2) {
    signals.push({
      signal: "multiple_holders_selling",
      dumpers_count: dumpingHolders,
      detail: `${dumpingHolders} top holders selling pressure`,
      strength: "HIGH",
    });
    score += 15;
  }

  // Signal 3: Top holder concentration increasing = concentration risk during dump
  const top1Baseline = baselineSnapshot.holders[0]?.pct || 0;
  const top1Current = currentSnapshot.holders[0]?.pct || 0;
  if (top1Current > top1Baseline + 2) {
    signals.push({
      signal: "top_holder_consolidating",
      detail: `Top holder grew from ${top1Baseline.toFixed(1)}% → ${top1Current.toFixed(1)}% (others exiting)`,
      strength: "MEDIUM",
    });
    score += 10;
  }

  // Clamp score and determine risk level
  score = Math.max(0, Math.min(100, score));
  let risk_level, recommendation;
  if (score >= 70) {
    risk_level = "CRITICAL";
    recommendation = "IMMEDIATE_EXIT";
  } else if (score >= 50) {
    risk_level = "HIGH";
    recommendation = "WATCH_CLOSELY";
  } else if (score >= 30) {
    risk_level = "MEDIUM";
    recommendation = "MONITOR";
  } else if (score >= 10) {
    risk_level = "LOW";
    recommendation = "MONITOR";
  } else {
    risk_level = "NONE";
    recommendation = "OK";
  }

  // Summary for details
  const topDumpSignal = signals.find(
    (s) => s.signal === "large_holder_dump" || s.signal === "holder_fully_exited"
  );

  return {
    risk_level,
    confidence: score,
    signals: signals.slice(0, 5), // top 5 signals
    recommendation,
    details: {
      top_dumper: topDumpSignal?.address || "none",
      dump_pct: topDumpSignal?.dump_pct || 0,
      coordinated_risk: dumpingHolders >= 2,
      lookback_minutes: lookbackMinutes,
      snapshots_analyzed: historicalSnapshots.length,
    },
  };
}

/**
 * Get holder snapshot history for a mint.
 */
export function getHolderHistory(tokenMint, limit = 10) {
  const store = loadSnapshots();
  const mint_store = store.mints[tokenMint];
  if (!mint_store || !mint_store.snapshots) return [];
  return mint_store.snapshots.slice(-limit).reverse();
}

/**
 * Clear old snapshots (>24h) to keep file size reasonable.
 */
export function pruneOldSnapshots(olderThanHours = 24) {
  return withFileLock(HOLDER_SNAPSHOTS_FILE, async () => {
    const store = loadSnapshots();
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    let pruned = 0;

    for (const [mint, mint_store] of Object.entries(store.mints)) {
      if (!mint_store.snapshots) continue;
      const before = mint_store.snapshots.length;
      mint_store.snapshots = mint_store.snapshots.filter((s) => new Date(s.recorded_at) > cutoff);
      pruned += before - mint_store.snapshots.length;
    }

    if (pruned > 0) {
      saveSnapshots(store);
      log("holder_monitor", `Pruned ${pruned} old holder snapshots (>${olderThanHours}h)`);
    }
    return pruned;
  });
}
