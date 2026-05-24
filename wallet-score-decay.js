const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimeMs(value) {
  if (value == null) return null;
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundScore(value) {
  return Number(value.toFixed(2));
}

function lastActiveMs(wallet = {}) {
  return parseTimeMs(
    wallet.last_active
    ?? wallet.stats?.last_active
    ?? wallet.stats?.last_trade_at
    ?? wallet.last_trade_at
  );
}

export function applyScoreDecay(wallet, nowMs = Date.now()) {
  if (!wallet || typeof wallet !== "object") return wallet;
  const activeAt = lastActiveMs(wallet);
  if (!Number.isFinite(activeAt)) return { ...wallet };

  const ageDays = Math.max(0, (Number(nowMs) - activeAt) / DAY_MS);
  const multiplier = ageDays < 7
    ? 1
    : ageDays < 30
      ? 0.8
      : ageDays < 90
        ? 0.5
        : 0.2;

  const out = {
    ...wallet,
    score_decay_multiplier: multiplier,
    score_last_active_days: Number(ageDays.toFixed(1)),
  };

  if (Number.isFinite(Number(wallet.score))) {
    out.score = roundScore(Number(wallet.score) * multiplier);
  }
  if (wallet.selection && typeof wallet.selection === "object") {
    out.selection = { ...wallet.selection };
    if (Number.isFinite(Number(wallet.selection.score))) {
      out.selection.score = roundScore(Number(wallet.selection.score) * multiplier);
    }
  }
  return out;
}

/**
 * Prune stale wallets from discovered-wallets.json.
 * - Removes wallets not active in >30 days
 * - Caps at MAX_WALLETS (keeps highest-score wallets)
 * - Persists decayed scores back to disk
 *
 * @param {Object} walletsData - loaded discovered-wallets.json content
 * @param {Object} [opts]
 * @param {number} [opts.maxAgeDays=30] - remove wallets older than this
 * @param {number} [opts.maxWallets=200] - hard cap
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {{ pruned: Object, removed: number, kept: number }}
 */
export function pruneDiscoveredWallets(walletsData = {}, opts = {}) {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const maxWallets = opts.maxWallets ?? 200;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - maxAgeDays * DAY_MS;

  const entries = Object.entries(walletsData || {});
  const kept = [];
  let removed = 0;

  for (const [addr, wallet] of entries) {
    const activeAt = lastActiveMs(wallet);
    if (activeAt && activeAt < cutoff) {
      removed++;
      continue;
    }
    // Persist decayed score
    const decayed = applyScoreDecay(wallet, nowMs);
    kept.push([addr, decayed]);
  }

  // Sort by score descending, cap at maxWallets
  kept.sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
  if (kept.length > maxWallets) {
    removed += kept.length - maxWallets;
    kept.length = maxWallets;
  }

  const pruned = {};
  for (const [addr, wallet] of kept) {
    pruned[addr] = wallet;
  }

  return { pruned, removed, kept: kept.length };
}
