import { listTrackedPositions } from "./state.js";
import { config } from "./config.js";

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

/**
 * Cast-Net (Tebar Jala) execution plan — high-conviction multi-wallet entry.
 *
 * Forces the split regardless of `splitThresholdSol` and uses cast-net-specific
 * jitter ranges from config. Caller (pro-orchestrator) is responsible for:
 *   1. Already verifying the cast-net gate passed (evaluateCastNet).
 *   2. Computing totalBankrollSol so we can derive the actual amount.
 *   3. Calling recordCastNetFire() AFTER this plan is dispatched.
 *
 * Returns the same shape as planWalletExecution() so executors don't need
 * a separate code path — the only differences are amount, wallet count,
 * jitter %, and delay range, all of which already flow through planning.
 *
 * @param {Object} args
 * @param {Array}  args.wallets             All wallets from wallet-manager
 * @param {string} args.tokenMint           Mint address
 * @param {number} args.totalBankrollSol    Current total SOL across all wallets
 * @returns {Object} same shape as planWalletExecution result
 */
export function planCastNetExecution({ wallets = [], tokenMint, totalBankrollSol = 0 } = {}) {
  const cfg = config.castNet || {};
  // Cast-net deploys a fraction of bankroll across N wallets simultaneously.
  // The fraction + max wallets are clamped in config.js already, but re-clamp
  // here defensively in case config was mutated at runtime.
  const maxWallets = Math.min(10, Math.max(2, Number(cfg.maxWallets || 10)));
  const bankrollPct = Math.min(50, Math.max(5, Number(cfg.maxBankrollPct || 30)));
  const amountSol = Number(totalBankrollSol) * (bankrollPct / 100);

  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    return {
      mode: "cast_net",
      split: false,
      selected_wallets: [],
      delays_ms: [],
      wallets_with_position: [],
      jitter_applied: false,
      stealth_summary: null,
      cast_net: { skipped: true, reason: `invalid bankroll: ${totalBankrollSol}` },
    };
  }

  // Force-split: pass an artificially low splitThresholdSol so any amount
  // above ~0 triggers the multi-wallet path. Combined with maxWallets=10
  // and the cast-net jitter ranges, this gives us the tebar-jala behavior.
  const plan = planWalletExecution({
    wallets,
    tokenMint,
    amountSol,
    mode: "entry",
    maxWallets,
    splitThresholdSol: 0.0001,
    jitterPct: Number(cfg.amountJitterPct ?? 20),
    delayBetweenWalletsMs: {
      min: Math.max(0, Number(cfg.timingJitterMinSec ?? 2)) * 1000,
      max: Math.max(1, Number(cfg.timingJitterMaxSec ?? 15)) * 1000,
    },
  });

  return {
    ...plan,
    mode: "cast_net",
    cast_net: {
      requested_wallets: maxWallets,
      actual_wallets: plan.selected_wallets.length,
      bankroll_pct: bankrollPct,
      total_amount_sol: round(amountSol),
    },
  };
}
