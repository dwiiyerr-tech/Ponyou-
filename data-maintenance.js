/**
 * Data Maintenance — migration, pruning, and cleanup for all JSON state files.
 *
 * Called at startup (before cron jobs) to ensure data integrity.
 * Each data file gets a `_v` version marker for future schema migrations.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_VERSION = 1;

/**
 * Safe JSON reader — returns null instead of throwing on corrupt/missing files.
 * Maintenance functions should skip (not crash) when a file is unreadable.
 */
function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    log("data_maintenance", `safeReadJson: cannot parse ${path.basename(filePath)} — ${e.message}. Skipping.`);
    return null;
  }
}

const DATA_FILES = [
  "observed-tokens.json",
  "ticker-registry.json",
  "rug-memory.json",
  "coin-conviction.json",
  "regime-memory.json",
  "lessons.json",
  "loss-analysis.json",
  "narrative-heat.json",
  "narrative-velocity.json",
  "execution-quality.json",
  "trade-attribution.json",
  "discovered-wallets.json",
  "closed-positions-archive.json",
  "metrics.json",
  "profit-patterns.json",
  "loss-patterns.json",
];

// ─── Migration ────────────────────────────────────────────────────

function ensureVersion(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (data._v === DATA_VERSION) return;
    // Future: add migration logic for _v < DATA_VERSION here
    data._v = DATA_VERSION;
    atomicWriteJson(filePath, data);
  } catch {
    // File exists but is corrupt — don't touch, let loader handle
  }
}

export function runDataMigration() {
  for (const file of DATA_FILES) {
    const filePath = path.join(__dirname, file);
    ensureVersion(filePath);
  }
}

// ─── Pruning ──────────────────────────────────────────────────────

/**
 * Prune conviction entries with zero observations and near-zero scores.
 * Keeps entries with observation_count > 0 or cumulative_outcome_delta >= 1.
 */
export function pruneConvictionMemory() {
  const filePath = path.join(__dirname, "coin-conviction.json");
  if (!fs.existsSync(filePath)) return { coins: 0, narratives: 0 };

  const data = safeReadJson(filePath);
  if (!data) return { coins: 0, narratives: 0 };
  let coinRemoved = 0, narrativeRemoved = 0;

  if (data.coins) {
    for (const [mint, coin] of Object.entries(data.coins)) {
      const obs = coin.observation_count || 0;
      const delta = Math.abs(coin.cumulative_outcome_delta || 0);
      if (obs === 0 && delta < 1) {
        delete data.coins[mint];
        coinRemoved++;
      }
    }
  }

  if (data.narratives) {
    for (const [name, narr] of Object.entries(data.narratives)) {
      const obs = narr.observation_count || 0;
      const delta = Math.abs(narr.cumulative_outcome_delta || 0);
      if (obs === 0 && delta < 1) {
        delete data.narratives[name];
        narrativeRemoved++;
      }
    }
  }

  data._v = DATA_VERSION;
  atomicWriteJson(filePath, data);

  return { coins: coinRemoved, narratives: narrativeRemoved };
}

/**
 * Prune deprecated lessons older than maxAgeDays.
 */
export function pruneDeprecatedLessons({ maxAgeDays = 90 } = {}) {
  const filePath = path.join(__dirname, "lessons.json");
  if (!fs.existsSync(filePath)) return 0;

  const data = safeReadJson(filePath);
  if (!data) return 0;
  const lessons = data.lessons || [];
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const kept = lessons.filter(l => {
    if (!l.deprecated) return true;
    const created = new Date(l.created_at || 0).getTime();
    return created > cutoff;
  });

  const removed = lessons.length - kept.length;
  data.lessons = kept;
  data._v = DATA_VERSION;

  atomicWriteJson(filePath, data);

  return removed;
}

/**
 * Cap rug-memory blacklist arrays.
 */
export function capRugMemoryBlacklists({ maxTokens = 500, maxDevs = 200 } = {}) {
  const filePath = process.env.PONYOU_RUG_MEMORY_FILE || path.join(__dirname, "rug-memory.json");
  if (!fs.existsSync(filePath)) return { tokens: 0, devs: 0 };

  const data = safeReadJson(filePath);
  if (!data) return { tokens: 0, devs: 0 };
  let tokensRemoved = 0, devsRemoved = 0;

  if (Array.isArray(data.blacklisted_tokens) && data.blacklisted_tokens.length > maxTokens) {
    tokensRemoved = data.blacklisted_tokens.length - maxTokens;
    data.blacklisted_tokens = data.blacklisted_tokens.slice(-maxTokens);
  }
  if (Array.isArray(data.blacklisted_devs) && data.blacklisted_devs.length > maxDevs) {
    devsRemoved = data.blacklisted_devs.length - maxDevs;
    data.blacklisted_devs = data.blacklisted_devs.slice(-maxDevs);
  }

  data._v = DATA_VERSION;
  atomicWriteJson(filePath, data);

  return { tokens: tokensRemoved, devs: devsRemoved };
}

/**
 * Cap loss analysis entries.
 */
export function capLossAnalysis({ maxEntries = 50 } = {}) {
  const filePath = path.join(__dirname, "loss-analysis.json");
  if (!fs.existsSync(filePath)) return 0;

  const data = safeReadJson(filePath);
  if (!data) return 0;
  const analyses = data.analyses || [];
  if (analyses.length <= maxEntries) return 0;

  const removed = analyses.length - maxEntries;
  data.analyses = analyses.slice(-maxEntries);
  data._v = DATA_VERSION;

  atomicWriteJson(filePath, data);

  return removed;
}

/**
 * Cap discovered-wallets.json — keep newest N wallets by last_scored_at.
 */
export function capDiscoveredWallets({ maxWallets = 300 } = {}) {
  const filePath = path.join(__dirname, "discovered-wallets.json");
  if (!fs.existsSync(filePath)) return 0;

  const data = safeReadJson(filePath);
  if (!data) return 0;
  const entries = Object.entries(data);
  if (entries.length <= maxWallets) return 0;

  entries.sort((a, b) => {
    const ta = new Date(a[1]?.last_scored_at || a[1]?.first_seen_at || 0).getTime();
    const tb = new Date(b[1]?.last_scored_at || b[1]?.first_seen_at || 0).getTime();
    return tb - ta;
  });

  const removed = entries.length - maxWallets;
  const kept = Object.fromEntries(entries.slice(0, maxWallets));
  kept._v = DATA_VERSION;
  atomicWriteJson(filePath, kept);
  return removed;
}

/**
 * Prune ticker-registry.json — remove token entries older than maxAgeDays.
 * If a ticker has no remaining entries, the ticker key is removed entirely.
 */
export function pruneTickerRegistry({ maxAgeDays = 30 } = {}) {
  const filePath = path.join(__dirname, "ticker-registry.json");
  if (!fs.existsSync(filePath)) return { tickers: 0, entries: 0 };

  const data = safeReadJson(filePath);
  if (!data) return { tickers: 0, entries: 0 };
  const tickers = data.tickers || {};
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let tickersRemoved = 0, entriesRemoved = 0;

  for (const [ticker, tokens] of Object.entries(tickers)) {
    if (!Array.isArray(tokens)) continue;
    const kept = tokens.filter(t => {
      const ts = new Date(t.last_seen_at || t.first_seen_at || 0).getTime();
      return ts > cutoff;
    });
    const dropped = tokens.length - kept.length;
    if (dropped > 0) {
      entriesRemoved += dropped;
      if (kept.length === 0) {
        delete tickers[ticker];
        tickersRemoved++;
      } else {
        tickers[ticker] = kept;
      }
    }
  }

  data.tickers = tickers;
  data._v = DATA_VERSION;
  atomicWriteJson(filePath, data);
  return { tickers: tickersRemoved, entries: entriesRemoved };
}

/**
 * Delete log files (*.log, *.jsonl) in the logs/ directory older than maxAgeDays.
 */
export function pruneOldLogs({ maxAgeDays = 14 } = {}) {
  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const file of fs.readdirSync(logsDir)) {
    if (!file.endsWith(".log") && !file.endsWith(".jsonl")) continue;
    const filePath = path.join(logsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      // skip locked or already-deleted files
    }
  }
  return removed;
}

/**
 * Run all maintenance: migration + pruning.
 * Called at startup. Safe to run repeatedly.
 */
export function runAllMaintenance() {
  runDataMigration();

  const convPruned    = pruneConvictionMemory();
  const lessonsPruned = pruneDeprecatedLessons();
  const rugCapped     = capRugMemoryBlacklists();
  const lossCapped    = capLossAnalysis();
  const tickersPruned = pruneTickerRegistry();
  const logsCleaned   = pruneOldLogs();

  return {
    migrated:              DATA_FILES.filter(f => fs.existsSync(path.join(__dirname, f))).length,
    conviction_pruned:     (convPruned.coins || 0) + (convPruned.narratives || 0),
    lessons_removed:       lessonsPruned,
    rug_blacklist_capped:  (rugCapped.tokens || 0) + (rugCapped.devs || 0),
    loss_analysis_capped:  lossCapped,
    tickers_pruned:        (tickersPruned.tickers || 0) + (tickersPruned.entries || 0),
    logs_deleted:          logsCleaned,
  };
}
