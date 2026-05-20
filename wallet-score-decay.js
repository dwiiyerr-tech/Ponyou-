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
