import { listTrackedPositions } from "./state.js";

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function jitter(value, pct = 10) {
  const factor = 1 + (Math.random() * 2 - 1) * (pct / 100);
  return round(value * factor);
}

function randomDelayMs(minMs, maxMs) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Plan wallet execution for a single trade.
 *
 * Stealth behaviour:
 *   - splitThresholdSol: 1 SOL (was 5) — split even for smaller entries
 *   - Random jitter ±10% per wallet amount — tx look organic
 *   - Random delay 2-15s between wallet executions — avoid correlation
 *   - DCA mode: prefer fresh wallets, avoid same-wallet repeat buys
 *   - Staged entry aware: can receive stage context for smarter splitting
 */
export function planWalletExecution({
  wallets = [],
  tokenMint,
  amountSol,
  mode = "entry",
  maxWallets = 1,
  splitThresholdSol = 1,           // was 5 — lowered for stealth
  jitterPct = 10,                   // ±10% random per wallet
  delayBetweenWalletsMs = { min: 2000, max: 15000 }, // 2-15s random delay
  stagedContext = null,             // optional: staged entry stage info
} = {}) {
  const openPositions = listTrackedPositions(tokenMint, { open_only: true });
  const walletsWithPosition = new Set(openPositions.map(p => p.wallet_address).filter(Boolean));

  const viable = wallets
    .filter(w => w && w.status !== "cold" && w.status !== "disabled")
    .map(w => ({
      ...w,
      has_position: walletsWithPosition.has(w.address),
    }));

  let preferred = viable;
  if (mode === "dca") {
    // DCA mode: prefer wallets WITHOUT existing position
    preferred = viable.filter(w => !w.has_position);
  } else if (mode === "sell") {
    // Sell mode: only wallets WITH position
    preferred = viable.filter(w => w.has_position);
  } else if (mode === "entry" && stagedContext) {
    // Staged entry: if stage 2+, prefer DIFFERENT wallet from stage 1
    // This makes multi-stage buys look like independent buyers
    const stage1Wallet = stagedContext.stage1Wallet || null;
    if (stage1Wallet && stagedContext.currentStage >= 2) {
      const fresh = viable.filter(w => w.address !== stage1Wallet);
      if (fresh.length > 0) preferred = fresh;
    }
  }

  if (preferred.length === 0 && mode !== "sell") preferred = viable;

  const shouldSplit = mode === "entry" && amountSol >= splitThresholdSol && preferred.length > 1;
  const selected = shouldSplit
    ? preferred.slice(0, Math.min(maxWallets, preferred.length))
    : preferred.slice(0, 1);

  // Random jitter per wallet — makes amounts look organic.
  // Single-wallet: skip jitter (no stealth benefit, only adds noise).
  const withJitter = selected.length <= 1
    ? selected.map(w => ({ ...w, amount_sol: round(amountSol) }))
    : selected.map(w => ({
        ...w,
        amount_sol: jitter(round(amountSol / selected.length), jitterPct),
      }));

  // Normalize so total matches original amount within 2% tolerance
  const totalJittered = withJitter.reduce((s, w) => s + w.amount_sol, 0);
  if (totalJittered > 0 && Math.abs(totalJittered - amountSol) / amountSol > 0.02) {
    const scale = amountSol / totalJittered;
    for (const w of withJitter) {
      w.amount_sol = round(w.amount_sol * scale);
    }
  }

  // Random delays between wallets
  const delays = [];
  if (shouldSplit && selected.length > 1) {
    for (let i = 1; i < selected.length; i++) {
      delays.push(randomDelayMs(delayBetweenWalletsMs.min, delayBetweenWalletsMs.max));
    }
  }

  return {
    mode,
    split: shouldSplit,
    selected_wallets: withJitter.map(w => ({
      address: w.address,
      label: w.label,
      has_position: w.has_position,
      amount_sol: w.amount_sol,
    })),
    delays_ms: delays,           // caller should sleep between executions
    wallets_with_position: [...walletsWithPosition],
    jitter_applied: shouldSplit,
    stealth_summary: shouldSplit
      ? `${selected.length} wallets, ±${jitterPct}% jitter, ${delays.reduce((s,d) => s+d, 0)}ms total delay`
      : null,
  };
}
