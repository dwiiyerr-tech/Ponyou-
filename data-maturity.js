/**
 * data-maturity.js
 *
 * Single source of truth for "how long has this agent been collecting data?".
 * The Strategy Evolution producer must NOT emit candidates until the agent
 * has accumulated enough live history — otherwise composer/gate decisions
 * are made from undersampled memory and any winrate is meaningless.
 *
 * Read-only against memory stores. Returns the oldest observation timestamp
 * across all surveyed memories, plus a derived ageDays figure.
 *
 * Sources surveyed (each optional — if a store is missing/empty, it is
 * skipped without throwing):
 *   - regime-memory.json          (slot.last_seen_at AND first-seen via earliest entry)
 *   - coin-conviction.json        (coin.last_seen_at + narrative.last_seen_at)
 *   - smart-wallet-history.json   (wallets[*].snapshots[0].ts)
 *   - execution-quality.json      (routes[*].last_seen_at)
 *
 * The "data age" is approximated by the EARLIEST timestamp we can find. If
 * absolutely nothing has been recorded yet we report ageDays=0 and
 * `mature=false` regardless of threshold.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PATHS = {
  regime:           path.join(__dirname, "regime-memory.json"),
  conviction:       path.join(__dirname, "coin-conviction.json"),
  smartWallet:      path.join(__dirname, "smart-wallet-history.json"),
  executionQuality: path.join(__dirname, "execution-quality.json"),
};

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function earliestFromObject(map = {}, getter) {
  let earliest = null;
  for (const value of Object.values(map || {})) {
    const ts = parseTimestamp(getter(value));
    if (ts != null && (earliest == null || ts < earliest)) earliest = ts;
  }
  return earliest;
}

function earliestRegime(store) {
  if (!store || !store.regimes) return null;
  // Regime entries have `last_seen_at`; in a freshly-running agent the
  // earliest last_seen_at across all entries is a reasonable proxy for
  // when data collection started.
  return earliestFromObject(store.regimes, entry => entry?.last_seen_at);
}

function earliestConviction(store) {
  if (!store) return null;
  const coinTs = earliestFromObject(store.coins, entry => entry?.last_seen_at);
  const narrativeTs = earliestFromObject(store.narratives, entry => entry?.last_seen_at);
  const candidates = [coinTs, narrativeTs].filter(ts => ts != null);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function earliestSmartWallet(store) {
  if (!store || !store.wallets) return null;
  let earliest = null;
  for (const wallet of Object.values(store.wallets || {})) {
    if (!Array.isArray(wallet?.snapshots) || wallet.snapshots.length === 0) continue;
    const ts = parseTimestamp(wallet.snapshots[0]?.ts);
    if (ts != null && (earliest == null || ts < earliest)) earliest = ts;
  }
  return earliest;
}

function earliestExecutionQuality(store) {
  if (!store || !store.routes) return null;
  return earliestFromObject(store.routes, entry => entry?.last_seen_at);
}

/**
 * Public API: snapshot the current data-age across memory stores.
 *
 * Returns:
 *   {
 *     ageDays:        Number,            // days since earliest observation, 0 if none
 *     oldestSeenAt:   ISO string | null, // the earliest timestamp itself
 *     sources:        string[],          // which stores contributed
 *     mature:         (minDays) => bool, // helper to check against a threshold
 *   }
 */
export function getDataMaturity({ paths = DEFAULT_PATHS, nowMs = Date.now() } = {}) {
  const stores = {
    regime:           safeReadJson(paths.regime),
    conviction:       safeReadJson(paths.conviction),
    smartWallet:      safeReadJson(paths.smartWallet),
    executionQuality: safeReadJson(paths.executionQuality),
  };

  const earliests = {
    regime:           earliestRegime(stores.regime),
    conviction:       earliestConviction(stores.conviction),
    smartWallet:      earliestSmartWallet(stores.smartWallet),
    executionQuality: earliestExecutionQuality(stores.executionQuality),
  };

  const sources = [];
  let oldest = null;
  for (const [name, ts] of Object.entries(earliests)) {
    if (ts == null) continue;
    sources.push(name);
    if (oldest == null || ts < oldest) oldest = ts;
  }

  const ageDays = oldest != null && oldest <= nowMs
    ? Math.max(0, (nowMs - oldest) / DAY_MS)
    : 0;

  return {
    ageDays: Number(ageDays.toFixed(2)),
    oldestSeenAt: oldest != null ? new Date(oldest).toISOString() : null,
    sources,
    perSource: earliests,
    mature(minDays = 30) {
      const threshold = Number(minDays);
      if (!Number.isFinite(threshold) || threshold <= 0) return true;
      return oldest != null && ageDays >= threshold;
    },
  };
}

export { DAY_MS as DATA_MATURITY_DAY_MS };
