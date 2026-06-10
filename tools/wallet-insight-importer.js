/**
 * Wallet Insight Importer
 *
 * Imports wallet trade history from:
 *   1. bengbeng.fun JSON export (file import)
 *   2. GMGN API (live fetch by wallet address)
 *
 * Extracts patterns from successful trades and stores them in
 * wallet_history.json so the bot can learn entry characteristics
 * (mcap range, hold time, momentum state) from proven wallets.
 *
 * CLI:  node tools/wallet-insight-importer.js <address|file.json>
 * Bot:  import { importWalletInsight, getWalletPatternScore } from './tools/wallet-insight-importer.js'
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { log } from "../logger.js";

const HISTORY_PATH = new URL("../wallet_history.json", import.meta.url).pathname;
const MAX_WALLETS   = 50;    // keep the JSON bounded
const MIN_WIN_RATE  = 0.45;  // ignore wallets with win rate below this
const MIN_TRADES    = 5;     // ignore wallets with too few trades to trust

// ─── Storage ─────────────────────────────────────────────────────

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { wallets: [], updated_at: null };
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return { wallets: [], updated_at: null };
  }
}

function saveHistory(db) {
  db.updated_at = new Date().toISOString();
  writeFileSync(HISTORY_PATH, JSON.stringify(db, null, 2));
}

// ─── Parsers ─────────────────────────────────────────────────────

/**
 * Parse bengbeng.fun JSON export.
 * Handles the typical shape: { address, win_rate, tokens: [...] }
 * Also handles flat array of trade rows.
 */
function parseBengbeng(raw, source = "bengbeng.fun") {
  const d = typeof raw === "string" ? JSON.parse(raw) : raw;

  // Shape A: { address, win_rate, tokens:[{mint, pnl_usd, entry_mcap, exit_mcap, hold_hours}] }
  // Shape B: { wallet, performance:{win_rate}, winning_trades:[...] }
  // Shape C: flat array of trades

  const address =
    d.address || d.wallet || d.wallet_address || "unknown";

  const winRate =
    d.win_rate ?? d.performance?.win_rate ?? d.stats?.win_rate ?? null;

  const totalTrades =
    d.total_trades ?? d.performance?.total_trades ?? d.stats?.total_trades ?? null;

  const rawTrades =
    d.tokens || d.trades || d.winning_trades || d.trade_history ||
    (Array.isArray(d) ? d : []);

  const trades = rawTrades.map(t => ({
    mint:         t.mint || t.address || t.token_address || null,
    symbol:       t.symbol || t.ticker || "?",
    pnl_usd:      Number(t.pnl_usd ?? t.profit_usd ?? t.realized_pnl ?? 0),
    entry_mcap:   Number(t.entry_mcap ?? t.market_cap_entry ?? t.buy_mcap ?? 0),
    peak_mcap:    Number(t.peak_mcap ?? t.max_mcap ?? t.ath_mcap ?? 0),
    exit_mcap:    Number(t.exit_mcap ?? t.market_cap_exit ?? t.sell_mcap ?? 0),
    hold_hours:   Number(t.hold_hours ?? t.hold_time_hours ?? ((t.hold_minutes ?? 0) / 60) ?? 0),
    win:          t.win ?? t.is_win ?? (Number(t.pnl_usd ?? t.profit_usd ?? 0) > 0),
    entry_time:   t.entry_time ?? t.buy_time ?? t.timestamp ?? null,
  })).filter(t => t.mint);

  return { address, source, win_rate: winRate, total_trades: totalTrades, trades };
}

/**
 * Fetch wallet data from GMGN API and normalise into the same shape.
 */
async function fetchFromGmgn(walletAddress) {
  const { getWalletActivity, getWalletStats, normalizeWalletActivity } = await import("./gmgn.js");

  const [activity, stats] = await Promise.all([
    getWalletActivity(walletAddress, 50).catch(() => null),
    getWalletStats(walletAddress, "30d").catch(() => null),
  ]);

  const statRow = Array.isArray(stats) ? stats[0] : stats;
  const trades  = normalizeWalletActivity(activity) || [];

  const winRate      = statRow?.winRate ?? null;
  const totalTrades  = statRow?.tradeCount ?? trades.length;

  const normalized = trades.map(t => ({
    mint:       t.token_address || t.token_mint || t.mint || null,
    symbol:     t.symbol || "?",
    pnl_usd:    Number(t.pnl_usd ?? t.realized_pnl ?? 0),
    entry_mcap: 0,    // GMGN activity feed doesn't carry mcap at trade time
    peak_mcap:  0,
    exit_mcap:  0,
    hold_hours: 0,
    win:        Number(t.pnl_usd ?? 0) > 0,
    entry_time: t.timestamp ?? null,
  })).filter(t => t.mint);

  return {
    address:      walletAddress,
    source:       "gmgn",
    win_rate:     winRate,
    total_trades: totalTrades,
    trades:       normalized,
  };
}

// ─── Pattern Extraction ──────────────────────────────────────────

function extractPatterns(parsed) {
  const wins = parsed.trades.filter(t => t.win && t.pnl_usd > 0);
  if (wins.length === 0) return null;

  const entryMcaps    = wins.map(t => t.entry_mcap).filter(v => v > 0);
  const holdHours     = wins.map(t => t.hold_hours).filter(v => v > 0);
  const gainMultiples = wins.map(t =>
    t.entry_mcap > 0 && t.exit_mcap > 0 ? t.exit_mcap / t.entry_mcap : 0
  ).filter(v => v > 0);
  const entryHours = wins.map(t =>
    t.entry_time ? new Date(t.entry_time * 1000).getUTCHours() : -1
  ).filter(v => v >= 0);

  const p = (arr, pct) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * pct)];
  };
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  // Hour frequency map → find peak hours
  const hourFreq = {};
  for (const h of entryHours) hourFreq[h] = (hourFreq[h] || 0) + 1;
  const preferredHours = Object.entries(hourFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => Number(h));

  return {
    win_count:         wins.length,
    entry_mcap_p25:    p(entryMcaps, 0.25),
    entry_mcap_p75:    p(entryMcaps, 0.75),
    entry_mcap_median: p(entryMcaps, 0.5),
    avg_hold_hours:    avg(holdHours),
    avg_gain_multiple: avg(gainMultiples),
    preferred_hours_utc: preferredHours,
    best_tokens: wins
      .sort((a, b) => b.pnl_usd - a.pnl_usd)
      .slice(0, 10)
      .map(t => ({ mint: t.mint, symbol: t.symbol, pnl_usd: t.pnl_usd, gain_x: gainMultiples.length ? (t.exit_mcap / Math.max(t.entry_mcap, 1)) : null })),
  };
}

// ─── Scoring ─────────────────────────────────────────────────────

/**
 * Score a candidate token against learned wallet patterns.
 * Returns { score: 0-100, reasons: string[] }.
 * score > 60 = strong match, > 40 = moderate match.
 */
export function getWalletPatternScore(token) {
  const db = loadHistory();
  if (!db.wallets.length) return { score: 0, reasons: ["no_wallet_patterns_loaded"] };

  const mcap    = Number(token.mcap || token.market_cap || token.usd_market_cap || 0);
  const nowHour = new Date().getUTCHours();

  let totalScore = 0;
  let walletCount = 0;
  const reasons = [];

  for (const wallet of db.wallets) {
    const p = wallet.patterns;
    if (!p) continue;
    walletCount++;

    let ws = 0;
    // Mcap range match
    if (p.entry_mcap_p25 && p.entry_mcap_p75 && mcap > 0) {
      const lo = p.entry_mcap_p25 * 0.5;
      const hi = p.entry_mcap_p75 * 2;
      if (mcap >= lo && mcap <= hi) ws += 40;
      else if (mcap >= lo * 0.3 && mcap <= hi * 3) ws += 15;
    }
    // Preferred hour match
    if (p.preferred_hours_utc?.length) {
      if (p.preferred_hours_utc.includes(nowHour)) ws += 25;
      else if (p.preferred_hours_utc.some(h => Math.abs(h - nowHour) <= 1)) ws += 10;
    }
    // High win rate wallet → bonus confidence
    if ((wallet.win_rate || 0) >= 0.65) ws += 20;
    else if ((wallet.win_rate || 0) >= 0.55) ws += 10;

    totalScore += Math.min(ws, 85);
  }

  if (!walletCount) return { score: 0, reasons: ["no_valid_patterns"] };

  const score = Math.round(totalScore / walletCount);
  if (score >= 60) reasons.push(`wallet_pattern_strong_match(mcap=$${(mcap/1000).toFixed(0)}K)`);
  else if (score >= 40) reasons.push(`wallet_pattern_moderate_match`);

  return { score, reasons };
}

// ─── Main import function ─────────────────────────────────────────

/**
 * Import wallet insight from a file path or wallet address.
 * @param {string} input — JSON file path OR Solana wallet address (base58)
 * @returns {{ address, patterns, win_rate, added: boolean, reason: string }}
 */
export async function importWalletInsight(input) {
  let parsed;

  // Detect: file path vs wallet address
  const isFile = input.endsWith(".json") || existsSync(input);
  if (isFile) {
    const raw = readFileSync(input, "utf8");
    parsed = parseBengbeng(raw, "bengbeng.fun");
    log("wallet_import", `Parsing bengbeng.fun file: ${input} → ${parsed.trades.length} trades`);
  } else {
    // Treat as wallet address — fetch from GMGN
    log("wallet_import", `Fetching wallet ${input.slice(0, 8)}... from GMGN`);
    parsed = await fetchFromGmgn(input);
    log("wallet_import", `GMGN fetch: ${parsed.trades.length} trades, win_rate=${parsed.win_rate}`);
  }

  // Quality gate
  const wr = parsed.win_rate ?? (parsed.trades.filter(t => t.win).length / Math.max(parsed.trades.length, 1));
  if (wr < MIN_WIN_RATE) {
    return { address: parsed.address, added: false, reason: `win_rate_too_low: ${(wr * 100).toFixed(0)}% < ${(MIN_WIN_RATE * 100)}%` };
  }
  if ((parsed.total_trades ?? parsed.trades.length) < MIN_TRADES) {
    return { address: parsed.address, added: false, reason: `too_few_trades: ${parsed.total_trades ?? parsed.trades.length} < ${MIN_TRADES}` };
  }

  const patterns = extractPatterns(parsed);
  if (!patterns) {
    return { address: parsed.address, added: false, reason: "no_winning_trades_to_learn_from" };
  }

  // Upsert into history
  const db = loadHistory();
  const existing = db.wallets.findIndex(w => w.address === parsed.address);
  const entry = {
    address:      parsed.address,
    source:       parsed.source,
    imported_at:  new Date().toISOString(),
    win_rate:     wr,
    total_trades: parsed.total_trades ?? parsed.trades.length,
    patterns,
  };

  if (existing >= 0) {
    db.wallets[existing] = entry;
  } else {
    db.wallets.unshift(entry);
    if (db.wallets.length > MAX_WALLETS) db.wallets = db.wallets.slice(0, MAX_WALLETS);
  }

  saveHistory(db);

  log("wallet_import", `Saved: ${parsed.address.slice(0, 8)} | win_rate=${(wr * 100).toFixed(0)}% | entry_mcap_median=$${patterns.entry_mcap_median?.toFixed(0) ?? "?"} | avg_gain=${patterns.avg_gain_multiple?.toFixed(1) ?? "?"}x`);

  return { address: parsed.address, patterns, win_rate: wr, added: true, reason: "ok" };
}

// ─── CLI ──────────────────────────────────────────────────────────

if (process.argv[1]?.includes("wallet-insight-importer")) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node tools/wallet-insight-importer.js <wallet_address | bengbeng.json>");
    process.exit(1);
  }
  importWalletInsight(input)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e.message); process.exit(1); });
}
