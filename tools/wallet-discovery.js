/**
 * Smart Wallet Discovery — autonomously scan & score profitable Solana wallets.
 *
 * Pipeline:
 *   1. Seed: trending/pumped tokens via DexScreener
 *   2. Top owner extraction via Solana RPC
 *   3. Per-wallet realized PnL scoring via Helius enriched transactions
 *   4. Behavior filter (bot/MEV/LP detection)
 *   5. Save to discovered-wallets.json — optionally auto-promote to smart-wallets.json
 */

import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { discoverTokens } from "./dexscreener.js";
import { listSmartWallets, addSmartWallet } from "../smart-wallets.js";
import { heliusAcquire, heliusRelease, heliusCircuitOpen } from "./rug-signals.js";
import { getAdaptiveSmartWalletContext, evaluateSmartWalletCandidate, selectSmartWalletCandidates } from "../smart-wallet-strategy.js";
import { applyScoreDecay } from "../wallet-score-decay.js";

export { applyScoreDecay } from "../wallet-score-decay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERED_FILE = path.join(__dirname, "../discovered-wallets.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const HELIUS_BASE = "https://api.helius.xyz/v0";

let _connection = null;
function getSolanaConnection() {
  if (!_connection) {
    _connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );
  }
  return _connection;
}

// Owners that look like trading wallets but are actually LP/vault/program-owned.
// Extend as you observe more false positives.
const EXCLUDE_OWNERS = new Set([
  "11111111111111111111111111111111",                   // System program / burn
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",       // Raydium authority
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",       // Serum
  "GMGNidoBmkPP9rPL4Lb9j46Wt5Y8DTjxh1tJZHWuQePc",       // GMGN
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",        // Jupiter
  "PFYxQALADqxiNxYjjdHvkc7gv9NBohQbADcvB6PfQ4z",        // pump.fun
]);

function loadDiscovered() {
  if (!fs.existsSync(DISCOVERED_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DISCOVERED_FILE, "utf8")); } catch { return {}; }
}

function saveDiscovered(data) {
  fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(data, null, 2));
}

async function getTopOwners(connection, mint, limit = 15) {
  try {
    const mintPk = new PublicKey(mint);
    const { value: largest } = await connection.getTokenLargestAccounts(mintPk);
    if (!largest?.length) return [];

    const tokenAccounts = largest.slice(0, limit);
    const parsed = await connection.getMultipleParsedAccounts(
      tokenAccounts.map(a => new PublicKey(a.address))
    );

    const owners = [];
    for (let i = 0; i < parsed.value.length; i++) {
      const info = parsed.value[i];
      const owner = info?.data?.parsed?.info?.owner;
      if (!owner || EXCLUDE_OWNERS.has(owner)) continue;
      owners.push({
        owner,
        amount: tokenAccounts[i].uiAmount || 0,
      });
    }
    return owners;
  } catch (e) {
    log("discovery_warn", `getTopOwners ${mint.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

async function fetchHeliusTxns(address, apiKey, limit = 50) {
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}&type=SWAP`;
  // heliusAcquire throws immediately if circuit breaker is open (too many 429s)
  await heliusAcquire();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Helius ${res.status}`);
    return res.json();
  } finally {
    heliusRelease();
  }
}

/**
 * Parse one enriched Helius transaction into an entry/exit event with SOL flow.
 * Returns null if not a clean swap involving SOL <-> SPL token.
 */
function parseSwap(tx) {
  const feePayer = tx.feePayer;
  const nativeTransfers = tx.nativeTransfers || [];
  const tokenTransfers = tx.tokenTransfers || [];

  const solOut = nativeTransfers
    .filter(t => t.fromUserAccount === feePayer)
    .reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;
  const solIn = nativeTransfers
    .filter(t => t.toUserAccount === feePayer)
    .reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;

  const tokenIn = tokenTransfers
    .filter(t => t.toUserAccount === feePayer && t.mint !== SOL_MINT);
  const tokenOut = tokenTransfers
    .filter(t => t.fromUserAccount === feePayer && t.mint !== SOL_MINT);

  // BUY: paid SOL, received token
  if (tokenIn.length > 0 && solOut > 0.001) {
    return {
      type: "buy",
      mint: tokenIn[0].mint,
      token_amount: tokenIn[0].tokenAmount || 0,
      sol_value: solOut,
      ts: tx.timestamp,
    };
  }
  // SELL: sent token, received SOL
  if (tokenOut.length > 0 && solIn > 0.001) {
    return {
      type: "sell",
      mint: tokenOut[0].mint,
      token_amount: tokenOut[0].tokenAmount || 0,
      sol_value: solIn,
      ts: tx.timestamp,
    };
  }
  return null;
}

/**
 * Compute realized PnL by matching buy→sell pairs per token (FIFO).
 */
function analyzeWallet(txns) {
  const swaps = txns.map(parseSwap).filter(Boolean);
  if (swaps.length === 0) {
    return { skip: true, reason: "no clean swaps" };
  }
  const lastActive = swaps.reduce((max, swap) => Math.max(max, Number(swap.ts || 0)), 0);

  // Group by mint
  const byMint = new Map();
  for (const s of swaps) {
    if (!byMint.has(s.mint)) byMint.set(s.mint, []);
    byMint.get(s.mint).push(s);
  }

  let wins = 0, losses = 0;
  let realized_pnl_sol = 0;
  let total_hold_seconds = 0;
  let completed_trades = 0;

  for (const [, mintSwaps] of byMint.entries()) {
    mintSwaps.sort((a, b) => a.ts - b.ts);
    const buyQueue = []; // FIFO {sol_cost_per_token, ts}

    for (const s of mintSwaps) {
      if (s.type === "buy" && s.token_amount > 0) {
        buyQueue.push({
          cost_per_token: s.sol_value / s.token_amount,
          ts: s.ts,
          remaining: s.token_amount,
        });
      } else if (s.type === "sell" && s.token_amount > 0 && buyQueue.length > 0) {
        let remainingToMatch = s.token_amount;
        const sellPricePerToken = s.sol_value / s.token_amount;
        let matched_cost = 0;
        let matched_amount = 0;
        let earliest_buy_ts = null;

        while (remainingToMatch > 0 && buyQueue.length > 0) {
          const head = buyQueue[0];
          const take = Math.min(head.remaining, remainingToMatch);
          matched_cost += take * head.cost_per_token;
          matched_amount += take;
          earliest_buy_ts = earliest_buy_ts || head.ts;
          head.remaining -= take;
          remainingToMatch -= take;
          if (head.remaining <= 1e-9) buyQueue.shift();
        }

        if (matched_amount > 0) {
          const proceeds = matched_amount * sellPricePerToken;
          const pnl = proceeds - matched_cost;
          realized_pnl_sol += pnl;
          completed_trades += 1;
          if (pnl > 0) wins += 1; else losses += 1;
          if (earliest_buy_ts) total_hold_seconds += (s.ts - earliest_buy_ts);
        }
      }
    }
  }

  const winrate = completed_trades > 0 ? wins / completed_trades : 0;
  const avg_hold = completed_trades > 0 ? total_hold_seconds / completed_trades : 0;

  return {
    skip: false,
    total_swaps: swaps.length,
    unique_tokens: byMint.size,
    completed_trades,
    wins,
    losses,
    winrate: Number(winrate.toFixed(3)),
    realized_pnl_sol: Number(realized_pnl_sol.toFixed(4)),
    avg_hold_seconds: Math.round(avg_hold),
    last_active: lastActive > 0 ? new Date(lastActive * 1000).toISOString() : null,
  };
}

function looksLikeBot(stats) {
  if (stats.avg_hold_seconds > 0 && stats.avg_hold_seconds < 30) return "flash/MEV";
  if (stats.unique_tokens > 80) return "spam_bot";
  if (stats.total_swaps > 200 && stats.completed_trades === 0) return "no_realized_trades";
  return null;
}

/**
 * Main entry — scan trending tokens, find top holders, score them.
 */
export async function discoverSmartWallets({
  source_tokens = 5,
  holders_per_token = 12,
  min_winrate = 0.65,
  min_trades = 8,
  min_realized_pnl_sol = 0.5,
  max_avg_hold_seconds = 7200,
  auto_add = false,
} = {}) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || apiKey === "dummy-helius-key") {
    return { error: "HELIUS_API_KEY not configured", discovered: [] };
  }

  const connection = getSolanaConnection();

  // Stage 1 — seed tokens
  const trending = await discoverTokens({ limit: source_tokens * 2 });
  if (trending.error || !trending.tokens?.length) {
    return { error: "no seed tokens from DexScreener", discovered: [] };
  }
  const seeds = trending.tokens
    .filter(t => (t.liquidity || 0) > 5000)  // skip tiny pools
    .slice(0, source_tokens);

  log("discovery", `Seed tokens: ${seeds.map(t => t.symbol).join(", ")}`);

  // Stage 2 — collect candidate owners (deduped)
  const candidateMap = new Map(); // owner -> Set<source_mints>
  for (const token of seeds) {
    const owners = await getTopOwners(connection, token.mint, holders_per_token);
    for (const o of owners) {
      if (!candidateMap.has(o.owner)) candidateMap.set(o.owner, new Set());
      candidateMap.get(o.owner).add(token.symbol || token.mint.slice(0, 6));
    }
  }

  // Skip wallets already in smart-wallets.json
  const existing = new Set(listSmartWallets().map(w => w.address));
  const candidates = [...candidateMap.entries()]
    .filter(([addr]) => !existing.has(addr));

  log("discovery", `Candidates after dedup: ${candidates.length}`);
  const adaptiveContext = getAdaptiveSmartWalletContext();

  // Stage 3 — score each candidate via Helius (capped to control credits)
  const MAX_CANDIDATES_PER_SCAN = 20;
  const SCAN_CAP = Math.min(candidates.length, MAX_CANDIDATES_PER_SCAN);
  if (candidates.length > MAX_CANDIDATES_PER_SCAN) {
    log("discovery", `Capping wallet candidates ${candidates.length} -> ${MAX_CANDIDATES_PER_SCAN} to avoid Helius burst`);
  }
  const discovered = loadDiscovered();
  const results = [];

  for (let i = 0; i < SCAN_CAP; i++) {
    if (heliusCircuitOpen()) {
      log("discovery", `Helius circuit open — stopping wallet scoring early (${i}/${SCAN_CAP} done)`);
      break;
    }
    const [addr, sourcesSet] = candidates[i];
    try {
      const txns = await fetchHeliusTxns(addr, apiKey, 50);
      if (!txns?.length) continue;

      const stats = analyzeWallet(txns);
      if (stats.skip) continue;

      const botReason = looksLikeBot(stats);
      const qualifies =
        !botReason &&
        stats.completed_trades >= min_trades &&
        stats.winrate >= min_winrate &&
        stats.realized_pnl_sol >= min_realized_pnl_sol &&
        stats.avg_hold_seconds <= max_avg_hold_seconds;

      const sourceTokens = [...new Set([...(discovered[addr]?.source_tokens || []), ...sourcesSet])];

      const entry = {
        address: addr,
        first_seen_at: discovered[addr]?.first_seen_at || new Date().toISOString(),
        last_scored_at: new Date().toISOString(),
        stats,
        bot_filter: botReason,
        qualifies,
        promoted: discovered[addr]?.promoted || false,
        source_tokens: sourceTokens,
      };
      entry.selection = evaluateSmartWalletCandidate(entry, adaptiveContext);

      discovered[addr] = entry;
      results.push(entry);

      if (qualifies && entry.selection.selected && auto_add && !entry.promoted) {
        addSmartWallet({
          address: addr,
          label: `auto:wr${Math.round(stats.winrate * 100)}_pnl${stats.realized_pnl_sol.toFixed(2)}SOL_n${stats.completed_trades}`,
          source_tokens: sourceTokens,
          stats,
          selection: entry.selection,
          notes: entry.selection.reasons.join("; "),
        });
        entry.promoted = true;
        log("discovery", `Promoted ${addr.slice(0, 8)} — score ${entry.selection.score}, winrate ${stats.winrate}, ${stats.realized_pnl_sol} SOL`);
      }
    } catch (e) {
      log("discovery_warn", `score ${addr.slice(0, 8)}: ${e.message}`);
    }
  }

  saveDiscovered(discovered);

  const ranked = selectSmartWalletCandidates(results, adaptiveContext);
  const ruleQualified = ranked.filter(r => r.qualifies);
  const qualified = ranked.filter(r => r.qualifies && r.selection?.selected);
  const recommended = ranked.filter(r => r.selection?.selected);
  const summary = {
    seeds_used: seeds.length,
    candidates_collected: candidates.length,
    candidates_scored: ranked.length,
    qualified: qualified.length,
    rule_qualified: ruleQualified.length,
    recommended: recommended.length,
    promoted: auto_add ? recommended.filter(r => r.promoted).length : 0,
    saved_to: "discovered-wallets.json",
    market_condition: adaptiveContext.marketCondition,
    observation_confidence: adaptiveContext.observationSummary.confidence,
  };

  log("discovery", `Done — ${summary.recommended}/${summary.candidates_scored} recommended, ${summary.qualified} promoted-grade${auto_add ? ` (${summary.promoted} promoted)` : ""}`);

  return {
    summary,
    qualified: qualified.map(r => ({
      address: r.address,
      winrate: r.stats.winrate,
      completed_trades: r.stats.completed_trades,
      realized_pnl_sol: r.stats.realized_pnl_sol,
      avg_hold_seconds: r.stats.avg_hold_seconds,
      unique_tokens: r.stats.unique_tokens,
      source_tokens: r.source_tokens,
      promoted: r.promoted,
      selection: r.selection,
    })),
    discovered: ranked.map(r => ({
      address: r.address,
      winrate: r.stats.winrate,
      completed_trades: r.stats.completed_trades,
      realized_pnl_sol: r.stats.realized_pnl_sol,
      avg_hold_seconds: r.stats.avg_hold_seconds,
      unique_tokens: r.stats.unique_tokens,
      source_tokens: r.source_tokens,
      promoted: r.promoted,
      qualifies: r.qualifies && r.selection?.selected,
      rule_qualified: r.qualifies,
      selection: r.selection,
    })),
  };
}

export function listDiscoveredWallets({ qualified_only = false, limit = 50 } = {}) {
  const all = Object.values(loadDiscovered()).map(wallet => applyScoreDecay(wallet));
  const filtered = qualified_only ? all.filter(w => w.qualifies) : all;
  return filtered
    .sort((a, b) =>
      (b.selection?.score || b.score || 0) - (a.selection?.score || a.score || 0) ||
      (b.stats?.realized_pnl_sol || 0) - (a.stats?.realized_pnl_sol || 0)
    )
    .slice(0, limit);
}
