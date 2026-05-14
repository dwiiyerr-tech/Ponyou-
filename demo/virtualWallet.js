/**
 * Virtual Wallet Engine — Demo Mode
 *
 * Tracks a simulated SOL balance and token positions in demo-state.json.
 * Returns data in the exact same shape as getWalletBalances() so the rest
 * of the agent works without modification.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_STATE_FILE = path.join(__dirname, "..", "demo-state.json");

const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── Persistence ──────────────────────────────────────────────

let _cache = null;
let _writeQueue = Promise.resolve();

function load() {
  if (_cache) return _cache;
  if (!fs.existsSync(DEMO_STATE_FILE)) return null;
  try {
    _cache = JSON.parse(fs.readFileSync(DEMO_STATE_FILE, "utf8"));
    return _cache;
  } catch {
    return null;
  }
}

function save(state) {
  _cache = state;
  state.lastUpdated = new Date().toISOString();
  _writeQueue = _writeQueue.then(async () => {
    try {
      await fs.promises.writeFile(DEMO_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      log("demo_error", `Failed to write demo-state.json: ${err.message}`);
    }
  });
  return _writeQueue;
}

// ─── Init ─────────────────────────────────────────────────────

/**
 * Initialize virtual wallet. Skips if already exists.
 */
export function initDemoWallet(initialSol = 5.0, solPriceUsd = 150.0) {
  const existing = load();
  if (existing) {
    log("demo", `Demo wallet loaded: ${existing.sol.toFixed(4)} SOL | ${existing.positions.length} positions`);
    return existing;
  }

  const state = {
    sol: initialSol,
    sol_price: solPriceUsd,
    positions: [],
    total_trades: 0,
    win_count: 0,
    loss_count: 0,
    win_rate_pct: 0,
    total_pnl_usd: 0,
    trade_history: [],
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  save(state);
  log("demo", `Demo wallet initialized: ${initialSol} SOL @ $${solPriceUsd}/SOL`);
  return state;
}

/**
 * Reset demo wallet to fresh state (useful for re-runs).
 */
export function resetDemoWallet(initialSol = 5.0, solPriceUsd = 150.0) {
  _cache = null;
  if (fs.existsSync(DEMO_STATE_FILE)) fs.unlinkSync(DEMO_STATE_FILE);
  return initDemoWallet(initialSol, solPriceUsd);
}

// ─── Balance ──────────────────────────────────────────────────

/**
 * Returns virtual balance in the exact shape of getWalletBalances().
 */
export function getDemoBalance() {
  const state = load() || initDemoWallet();
  const solUsd = state.sol * state.sol_price;

  const tokenEntries = state.positions.map(p => {
    const currentUsd = p.token_amount * (p.last_known_price_usd || p.buy_price_usd);
    return {
      mint: p.mint,
      symbol: p.symbol,
      balance: p.token_amount,
      usd: parseFloat(currentUsd.toFixed(4)),
    };
  });

  const tokensTotalUsd = tokenEntries.reduce((s, t) => s + (t.usd || 0), 0);

  return {
    wallet: "DEMO_WALLET",
    sol: parseFloat(state.sol.toFixed(6)),
    sol_price: state.sol_price,
    sol_usd: parseFloat(solUsd.toFixed(4)),
    usdc: 0,
    tokens: tokenEntries,
    total_usd: parseFloat((solUsd + tokensTotalUsd).toFixed(4)),
    _demo: true,
  };
}

// ─── Buy ──────────────────────────────────────────────────────

/**
 * Execute a simulated buy.
 * Deducts SOL, records position.
 *
 * @param {string} mint - Token mint address
 * @param {string} symbol - Token symbol
 * @param {number} amount_sol - SOL to spend
 * @param {number} price_usd - Current token price in USD (per token unit)
 * @param {number} [slippage=0.01] - Simulated slippage (1%)
 * @returns swap result object
 */
export function executeDemoBuy({ mint, symbol, amount_sol, price_usd, slippage = 0.01 }) {
  const state = load() || initDemoWallet();

  const gasReserve = 0.01;
  if (state.sol - amount_sol < gasReserve) {
    return {
      demo: true,
      error: `Demo: insufficient virtual SOL (have ${state.sol.toFixed(4)}, need ${amount_sol} + ${gasReserve} reserve)`,
    };
  }

  const effectivePrice = price_usd * (1 + slippage);
  const solUsd = amount_sol * state.sol_price;
  const tokenAmount = effectivePrice > 0 ? solUsd / effectivePrice : 0;

  const existingIdx = state.positions.findIndex(p => p.mint === mint);
  if (existingIdx >= 0) {
    const pos = state.positions[existingIdx];
    const totalSol = pos.amount_sol + amount_sol;
    const totalTokens = pos.token_amount + tokenAmount;
    const avgPrice = totalTokens > 0
      ? (pos.buy_price_usd * pos.token_amount + effectivePrice * tokenAmount) / totalTokens
      : effectivePrice;
    state.positions[existingIdx] = {
      ...pos,
      amount_sol: totalSol,
      token_amount: totalTokens,
      buy_price_usd: avgPrice,
      last_known_price_usd: price_usd,
    };
  } else {
    state.positions.push({
      mint,
      symbol: symbol || mint.slice(0, 8),
      amount_sol,
      buy_price_usd: effectivePrice,
      last_known_price_usd: price_usd,
      token_amount: tokenAmount,
      opened_at: new Date().toISOString(),
    });
  }

  state.sol = parseFloat((state.sol - amount_sol).toFixed(6));
  save(state);

  log("demo", `BUY ${symbol || mint.slice(0, 8)}: ${amount_sol} SOL @ $${effectivePrice.toExponential(4)} | Virtual SOL left: ${state.sol.toFixed(4)}`);

  return {
    demo: true,
    success: true,
    token_in: SOL_MINT,
    token_out: mint,
    amount_in: amount_sol,
    amount_out: tokenAmount,
    price_usd: effectivePrice,
    message: `DEMO BUY: ${amount_sol} SOL → ${tokenAmount.toFixed(0)} ${symbol || "tokens"}`,
  };
}

// ─── Sell ─────────────────────────────────────────────────────

/**
 * Execute a simulated sell.
 * Returns SOL (with PnL), removes position.
 *
 * @param {string} mint - Token mint address
 * @param {number|null} current_price_usd - Current price (null = use last known)
 * @param {number} [slippage=0.01] - Simulated slippage (1%)
 * @returns swap result object
 */
export function executeDemoSell({ mint, current_price_usd = null, slippage = 0.01 }) {
  const state = load() || initDemoWallet();

  const posIdx = state.positions.findIndex(p => p.mint === mint);
  if (posIdx < 0) {
    return {
      demo: true,
      error: `Demo: no open position for mint ${mint.slice(0, 12)}`,
    };
  }

  const pos = state.positions[posIdx];
  const sellPrice = (current_price_usd || pos.last_known_price_usd || pos.buy_price_usd) * (1 - slippage);
  const sellUsd = pos.token_amount * sellPrice;
  const returnedSol = state.sol_price > 0 ? sellUsd / state.sol_price : 0;

  const pnlUsd = sellUsd - (pos.amount_sol * state.sol_price);
  const pnlPct = pos.amount_sol > 0 ? (returnedSol - pos.amount_sol) / pos.amount_sol * 100 : 0;
  const isWin = returnedSol >= pos.amount_sol;

  // Update stats
  state.total_trades += 1;
  if (isWin) state.win_count += 1;
  else state.loss_count += 1;
  state.total_pnl_usd = parseFloat((state.total_pnl_usd + pnlUsd).toFixed(4));

  const totalTraded = state.total_trades;
  state.win_rate_pct = totalTraded > 0
    ? parseFloat(((state.win_count / totalTraded) * 100).toFixed(1))
    : 0;

  // Keep last 100 trades in history
  state.trade_history.push({
    mint,
    symbol: pos.symbol,
    amount_sol: pos.amount_sol,
    return_sol: parseFloat(returnedSol.toFixed(6)),
    pnl_pct: parseFloat(pnlPct.toFixed(2)),
    pnl_usd: parseFloat(pnlUsd.toFixed(4)),
    win: isWin,
    opened_at: pos.opened_at,
    closed_at: new Date().toISOString(),
    buy_price: pos.buy_price_usd,
    sell_price: sellPrice,
  });
  if (state.trade_history.length > 100) state.trade_history.splice(0, state.trade_history.length - 100);

  // Remove position, add SOL back
  state.positions.splice(posIdx, 1);
  state.sol = parseFloat((state.sol + returnedSol).toFixed(6));
  save(state);

  log("demo", `SELL ${pos.symbol}: PnL ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | ${isWin ? "WIN" : "LOSS"} | Virtual SOL: ${state.sol.toFixed(4)}`);

  return {
    demo: true,
    success: true,
    token_in: mint,
    token_out: SOL_MINT,
    amount_in: pos.token_amount,
    amount_out: returnedSol,
    pnl_pct: parseFloat(pnlPct.toFixed(2)),
    pnl_usd: parseFloat(pnlUsd.toFixed(4)),
    message: `DEMO SELL: ${pos.symbol} → ${returnedSol.toFixed(4)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
  };
}

// ─── Price Update ─────────────────────────────────────────────

/**
 * Update last known price for a position (used by management cycle).
 */
export function updateDemoPositionPrice(mint, currentPriceUsd) {
  const state = load();
  if (!state) return;
  const pos = state.positions.find(p => p.mint === mint);
  if (pos) {
    pos.last_known_price_usd = currentPriceUsd;
    save(state);
  }
}

// ─── Stats ────────────────────────────────────────────────────

/**
 * Get demo trading statistics summary.
 */
export function getDemoStats() {
  const state = load();
  if (!state) return { initialized: false };

  const winRate = state.total_trades > 0
    ? ((state.win_count / state.total_trades) * 100).toFixed(1)
    : "0.0";

  return {
    initialized: true,
    sol_balance: state.sol,
    sol_price: state.sol_price,
    total_usd: parseFloat((state.sol * state.sol_price).toFixed(2)),
    open_positions: state.positions.length,
    total_trades: state.total_trades,
    win_count: state.win_count,
    loss_count: state.loss_count,
    win_rate_pct: parseFloat(winRate),
    total_pnl_usd: state.total_pnl_usd,
    recent_trades: state.trade_history.slice(-5),
  };
}
