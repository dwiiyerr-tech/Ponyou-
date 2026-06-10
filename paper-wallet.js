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
      chain: p.chain || "sol",
      entry_price: entryPrice,
      cost_usd: Math.round(costUsd * 100) / 100,
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
 * Pure: mark open paper tokens to market from a mint→live-price map.
 *
 * Cost-basis valuation made paper PnL ≡ 0 forever (token.usd never moved, so
 * SL/TP/trailing could not fire and positions wedged the book at the position
 * limit). Re-pricing uses the entry-price RATIO (cost × live/entry) instead of
 * qty × price, because qty can be a coarse placeholder for legacy positions.
 *
 *   live quote + entry price  → usd = max(0.1, cost × live/entry), priceUsd set
 *   live quote, no entry      → priceUsd set (drop detector), usd stays cost
 *   no quote                  → price_unavailable=true (stale-exit signal),
 *                               usd stays cost
 *
 * The ≥ 0.1 floor stays: a rugged-to-zero token shows ~-99% PnL (exit fires)
 * instead of vanishing under the dust filter as an orphan.
 */
export function applyMarkToMarket(tokens = [], quotes = {}) {
  for (const t of tokens) {
    if (!t || (t.chain && t.chain !== "sol")) continue; // quotes are sol-chain only
    const live = Number(quotes[t.mint]) || 0;
    if (live > 0) {
      t.priceUsd = live;
      const entry = Number(t.entry_price) || 0;
      const cost = Number(t.cost_usd) || 0;
      if (entry > 0 && cost > 0) {
        t.usd = Math.max(0.1, Math.round(cost * (live / entry) * 100) / 100);
      }
    } else {
      t.price_unavailable = true;
    }
  }
  return tokens;
}

/**
 * Pure: should this paper position be force-exited as stale/unquotable?
 *
 * A paper token that DexScreener can no longer quote (delisted / rugged off
 * the index) never moves off cost basis, so no PnL gate will ever close it —
 * it sits in the book forever and blocks new entries. After a grace window
 * (default 6h, config.risk.paperStaleExitMinutes) treat it as dead.
 * Live positions are never force-exited here (paper_trade guard).
 */
export function shouldForceExitStalePaper({ tracked, token, ageMinutes, staleExitMinutes = 360 } = {}) {
  if (tracked?.paper_trade !== true) return false;
  if (token?.price_unavailable !== true) return false;
  return Number(ageMinutes) > Number(staleExitMinutes);
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
 * @param {(mint: string) => Promise<number>} [getQuote]  live token price fetcher
 *        (injected the same way; omitted → cost-basis valuation as before)
 */
export async function getPaperBalances(walletAddress, getSolPrice, getQuote) {
  let solPrice = 0;
  try { solPrice = typeof getSolPrice === "function" ? Number(await getSolPrice()) || 0 : 0; } catch { /* stale 0 ok */ }
  const positions = listTrackedPositions(null, { open_only: true });
  const fraction = await paperCapitalFraction(walletAddress);
  const startSol = getPaperStartSol() * fraction;
  const balance = derivePaperBalance({ walletAddress, solPrice, positions, startSol });

  if (typeof getQuote === "function" && balance.tokens.length > 0) {
    const quotes = {};
    await Promise.all(balance.tokens.map(async (t) => {
      if (t.chain && t.chain !== "sol") return;
      try { quotes[t.mint] = Number(await getQuote(t.mint)) || 0; } catch { quotes[t.mint] = 0; }
    }));
    applyMarkToMarket(balance.tokens, quotes);
    const tokenUsd = balance.tokens.reduce((s, t) => s + (t.usd || 0), 0);
    balance.total_usd = Math.round((balance.sol_usd + tokenUsd) * 100) / 100;
  }
  return balance;
}
