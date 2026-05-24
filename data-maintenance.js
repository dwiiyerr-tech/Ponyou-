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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_VERSION = 1;

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

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
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

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
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
  const filePath = path.join(__dirname, "rug-memory.json");
  if (!fs.existsSync(filePath)) return { tokens: 0, devs: 0 };

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
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

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const analyses = data.analyses || [];
  if (analyses.length <= maxEntries) return 0;

  const removed = analyses.length - maxEntries;
  data.analyses = analyses.slice(-maxEntries);
  data._v = DATA_VERSION;

  atomicWriteJson(filePath, data);

  return removed;
}

/**
 * Run all maintenance: migration + pruning.
 * Called at startup. Safe to run repeatedly.
 */
export function runAllMaintenance() {
  runDataMigration();

  const convPruned = pruneConvictionMemory();
  const lessonsPruned = pruneDeprecatedLessons();
  const rugCapped = capRugMemoryBlacklists();
  const lossCapped = capLossAnalysis();

  return {
    migrated: DATA_FILES.filter(f => fs.existsSync(path.join(__dirname, f))).length,
    conviction_pruned: (convPruned.coins || 0) + (convPruned.narratives || 0),
    lessons_removed: lessonsPruned,
    rug_blacklist_capped: (rugCapped.tokens || 0) + (rugCapped.devs || 0),
    loss_analysis_capped: lossCapped,
  };
}
