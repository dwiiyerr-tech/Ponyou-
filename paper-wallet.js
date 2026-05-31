/**
 * Paper Wallet — virtual ("fake") balance baked into DEMO / dry-run mode.
 *
 * UNIFIED MODE: demo, dry-run, and the virtual balance are ONE thing. Whenever
 * the bot runs in demo it automatically uses a virtual SOL balance (no separate
 * toggle). Set PAPER_TRADING=false only if you deliberately want demo to read a
 * real funded wallet instead.
 *
 * Why: previously demo read the *real* wallet balance. On an unfunded box that's
 * 0 SOL, so the min-SOL gate blocked screening and the bot never exercised the
 * buy → manage → exit lifecycle — the exact accounting code that is riskiest in
 * live. With the virtual balance the whole loop runs against real mainnet data
 * with simulated execution and zero risk.
 *
 * Single source of truth: the existing position state (state.js). A demo buy
 * already records a position via trackPosition() (dry_run legs count as filled),
 * and recordClose() removes it. So the virtual portfolio is *derived* from open
 * positions rather than kept as a parallel ledger that could drift:
 *
 *   virtual SOL  = startSol − Σ(amount_sol of open positions)   ("free cost-basis")
 *   wallet.tokens = open positions, valued at cost basis (so management sees them)
 *
 * HARD SAFETY: paper mode can ONLY activate in demo. isPaperMode() returns false
 * in live regardless of flags, so this can never mask a real balance.
 */

import { listTrackedPositions } from "./state.js";

const DEFAULT_START_SOL = 5;

function inDemo() {
  return process.env.DRY_RUN === "true" || process.env.EXECUTION_MODE === "demo";
}

/**
 * True when the virtual paper balance should be used.
 *
 * UNIFIED MODE: demo / dry-run *is* paper trading with a virtual balance — they
 * are one mode, not two toggles. So in demo this defaults ON (no flag needed).
 * Hard guard: always OFF in live, regardless of flags.
 *
 *   live (any flag)           → OFF   (never mask a real balance)
 *   demo, default             → ON    (virtual balance, default PAPER_START_SOL)
 *   demo, PAPER_TRADING=false → OFF   (escape hatch: demo against a real wallet)
 */
export function isPaperMode() {
  if (!inDemo()) return false; // never in live
  const flag = String(process.env.PAPER_TRADING ?? "").trim().toLowerCase();
  if (["false", "0", "off", "no"].includes(flag)) return false; // explicit opt-out
  return true; // demo ⇒ virtual balance by default
}

/** Configured starting capital in SOL (default 5). */
export function getPaperStartSol() {
  const v = Number(process.env.PAPER_START_SOL);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_START_SOL;
}

/**
 * Pure derivation of a wallet-balance snapshot from tracked positions.
 * Mirrors the shape of getWalletBalances() so every consumer works unchanged.
 *
 * @param {object} a
 * @param {string|null} a.walletAddress  filter to this wallet (null = all)
 * @param {number} a.solPrice            current SOL→USD price
 * @param {Array}  a.positions           position objects from listTrackedPositions
 * @param {number} a.startSol            virtual starting SOL
 */
export function derivePaperBalance({ walletAddress = null, solPrice = 0, positions = [], startSol = DEFAULT_START_SOL }) {
  const open = positions.filter((p) => p && !p.closed && (
    !walletAddress || p.wallet_address === walletAddress || !p.wallet_address
  ));

  let deployedSol = 0;
  const tokens = [];

  for (const p of open) {
    const amtSol = Number(p.amount_sol) || 0;
    deployedSol += amtSol;

    const snap = p.signal_snapshot || {};
    // Cost basis in USD: prefer the recorded value; fall back to amount_sol × price.
    const recordedUsd = Number(p.initial_value_usd) || 0;
    const costUsd = recordedUsd > 0 ? recordedUsd : amtSol * solPrice;

    const entryPrice = Number(p.entry_price ?? snap.entry_price ?? snap.price) || 0;
    // Token quantity: use the recorded amount if present, else derive from cost
    // basis / entry price, else a coarse positive placeholder (sim only needs a
    // non-zero amount to quote against — fund safety is unaffected in demo).
    let qty = Number(snap.token_amount) || 0;
    if (qty <= 0) qty = entryPrice > 0 ? costUsd / entryPrice : (costUsd > 0 ? costUsd : amtSol);

    tokens.push({
      mint: p.position,
      position_key: p.position_key,
      wallet_address: p.wallet_address || walletAddress || null,
      symbol: snap.symbol || p.pool_name || (p.position ? String(p.position).slice(0, 8) : "?"),
      balance: qty,
      // Keep ≥ 0.1 so the management cycle's dust filter never silently drops a
      // paper position (which would orphan it — bought but never managed/exited).
      usd: Math.max(0.1, Math.round(costUsd * 100) / 100),
    });
  }

  const sol = Math.max(0, startSol - deployedSol);
  const sol_usd = Math.round(sol * solPrice * 100) / 100;
  const tokenUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);

  return {
    wallet: walletAddress || "paper-wallet",
    sol: Math.round(sol * 1e6) / 1e6,
    sol_price: solPrice,
    sol_usd,
    usdc: 0,
    tokens,
    total_usd: Math.round((sol_usd + tokenUsd) * 100) / 100,
    paper: true,
  };
}

/**
 * Pure: a wallet's share of the virtual capital from a wallet list. Multi-wallet
 * splits the starting SOL by capital_pct so the *total* across wallets stays =
 * paperStartSol (previously every wallet got the full amount → N× inflated
 * capital). Aggregate calls (walletAddress=null) and single-wallet setups get
 * the full balance (fraction 1).
 *
 * @returns {number} fraction in (0, 1]
 */
export function capitalFractionFor(walletAddress, wallets = []) {
  if (!walletAddress) return 1; // aggregate / single-wallet call → full balance
  if (!Array.isArray(wallets) || wallets.length <= 1) return 1; // no split
  const w = wallets.find((x) => x && x.address === walletAddress);
  const pct = Number(w?.capital_pct);
  return Number.isFinite(pct) && pct > 0 ? Math.min(1, pct / 100) : 1;
}

/**
 * Resolve a wallet's capital fraction live. Dynamic import keeps this cycle-safe
 * (wallet-manager → config → … would otherwise loop back to wallet.js).
 */
async function paperCapitalFraction(walletAddress) {
  if (!walletAddress) return 1;
  try {
    const { getAllWallets } = await import("./tools/wallet-manager.js");
    const all = (typeof getAllWallets === "function" ? getAllWallets() : []) || [];
    return capitalFractionFor(walletAddress, all);
  } catch {
    return 1; // wallet-manager unavailable → don't penalise the balance
  }
}

/**
 * Build the virtual balance for the current open positions.
 * @param {string|null} walletAddress
 * @param {() => Promise<number>} getSolPrice  price fetcher (injected to avoid a wallet.js cycle)
 */
export async function getPaperBalances(walletAddress, getSolPrice) {
  let solPrice = 0;
  try { solPrice = typeof getSolPrice === "function" ? Number(await getSolPrice()) || 0 : 0; } catch { /* stale 0 ok */ }
  const positions = listTrackedPositions(null, { open_only: true });
  const fraction = await paperCapitalFraction(walletAddress);
  const startSol = getPaperStartSol() * fraction;
  return derivePaperBalance({ walletAddress, solPrice, positions, startSol });
}
