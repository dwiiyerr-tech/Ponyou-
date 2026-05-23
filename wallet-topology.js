const ENV_REF_PATTERN = /^WALLET_KEY_(?:10|[1-9])$/;

function normalizeWallet(wallet = {}, index = 0) {
  const label = String(wallet.label || wallet.name || `wallet-${index + 1}`).trim();
  const key = String(wallet.key || wallet.private_key || wallet.walletKey || "").trim();
  const envRef = String(wallet.env_ref || wallet.envRef || "").trim();
  const capitalPct = Number(wallet.capital_pct ?? wallet.capitalPct ?? 0);
  return { label, key, env_ref: envRef, capital_pct: capitalPct };
}

function secretFingerprint(wallet) {
  if (wallet.env_ref) return `env:${wallet.env_ref}`;
  if (wallet.key) return `key:${wallet.key}`;
  return "";
}

export function validateWalletTopology({
  enabled = false,
  wallets = [],
  minWalletCount = 2,
  maxWalletCount = 10,
  capitalTolerance = 0.01,
} = {}) {
  const normalizedWallets = Array.isArray(wallets)
    ? wallets.map((wallet, index) => normalizeWallet(wallet, index)).filter((wallet) => wallet.label || wallet.key || wallet.env_ref)
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
  if (normalizedWallets.length > maxWalletCount) {
    errors.push(`multiWallet supports at most ${maxWalletCount} wallets (got ${normalizedWallets.length}).`);
  }

  const seenLabels = new Set();
  const seenSecrets = new Set();
  for (const wallet of normalizedWallets) {
    if (!wallet.label) errors.push("Every multi-wallet entry needs a label.");
    if (!wallet.key && !wallet.env_ref) {
      errors.push(`Wallet ${wallet.label || "?"} is missing both key and env_ref.`);
    }
    if (wallet.env_ref && !ENV_REF_PATTERN.test(wallet.env_ref)) {
      errors.push(`Wallet ${wallet.label || "?"}: env_ref must match WALLET_KEY_1..10 (got "${wallet.env_ref}").`);
    }
    if (!Number.isFinite(wallet.capital_pct) || wallet.capital_pct <= 0) {
      errors.push(`Wallet ${wallet.label || "?"} must have a positive capital_pct.`);
    }
    const labelKey = wallet.label.toLowerCase();
    if (seenLabels.has(labelKey)) errors.push(`Duplicate wallet label: ${wallet.label}`);
    const secret = secretFingerprint(wallet);
    if (secret && seenSecrets.has(secret)) {
      errors.push(`Duplicate wallet secret for ${wallet.label || "?"} (${wallet.env_ref ? "env_ref" : "key"} reused).`);
    }
    seenLabels.add(labelKey);
    if (secret) seenSecrets.add(secret);
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

export { ENV_REF_PATTERN };
