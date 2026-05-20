function normalizeWallet(wallet = {}, index = 0) {
  const label = String(wallet.label || wallet.name || `wallet-${index + 1}`).trim();
  const key = String(wallet.key || wallet.private_key || wallet.walletKey || "").trim();
  const capitalPct = Number(wallet.capital_pct ?? wallet.capitalPct ?? 0);
  return { label, key, capital_pct: capitalPct };
}

export function validateWalletTopology({ enabled = false, wallets = [], minWalletCount = 2, capitalTolerance = 0.01 } = {}) {
  const normalizedWallets = Array.isArray(wallets)
    ? wallets.map((wallet, index) => normalizeWallet(wallet, index)).filter((wallet) => wallet.label || wallet.key)
    : [];

  const errors = [];
  const warnings = [];

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      wallet_count: normalizedWallets.length,
      total_capital_pct: normalizedWallets.reduce((sum, wallet) => sum + (Number(wallet.capital_pct) || 0), 0),
      errors,
      warnings,
      wallets: normalizedWallets,
    };
  }

  if (normalizedWallets.length < minWalletCount) {
    errors.push(`multiWallet.enabled requires at least ${minWalletCount} wallets.`);
  }

  const seenLabels = new Set();
  const seenKeys = new Set();
  for (const wallet of normalizedWallets) {
    if (!wallet.label) errors.push("Every multi-wallet entry needs a label.");
    if (!wallet.key) errors.push(`Wallet ${wallet.label || "?"} is missing a private key.`);
    if (!Number.isFinite(wallet.capital_pct) || wallet.capital_pct <= 0) {
      errors.push(`Wallet ${wallet.label || "?"} must have a positive capital_pct.`);
    }
    const labelKey = wallet.label.toLowerCase();
    if (seenLabels.has(labelKey)) errors.push(`Duplicate wallet label: ${wallet.label}`);
    if (seenKeys.has(wallet.key)) errors.push(`Duplicate wallet private key for ${wallet.label || "?"}`);
    seenLabels.add(labelKey);
    seenKeys.add(wallet.key);
  }

  const totalCapitalPct = normalizedWallets.reduce((sum, wallet) => sum + (Number(wallet.capital_pct) || 0), 0);
  if (normalizedWallets.length > 0 && Math.abs(totalCapitalPct - 100) > capitalTolerance) {
    errors.push(`capital_pct must sum to 100% (got ${totalCapitalPct.toFixed(2)}%).`);
  }

  if (normalizedWallets.length >= 2 && totalCapitalPct < 100) {
    warnings.push(`capital_pct sums to ${totalCapitalPct.toFixed(2)}%; deploy sizing will be constrained.`);
  }

  return {
    ok: errors.length === 0,
    enabled: true,
    wallet_count: normalizedWallets.length,
    total_capital_pct: totalCapitalPct,
    errors,
    warnings,
    wallets: normalizedWallets,
  };
}

export function formatWalletTopologyErrors(result) {
  const lines = [];
  if (!result) return lines;
  for (const error of result.errors || []) lines.push(error);
  return lines;
}
