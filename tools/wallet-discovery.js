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

import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { log } from "../logger.js";
import { discoverTokens } from "./dexscreener.js";
import { listSmartWallets, addSmartWallet } from "../smart-wallets.js";
import { heliusAcquire, heliusRelease, heliusCircuitOpen, helius429Hit, heliusSuccess } from "./rug-signals.js";
import { getSharedConnection } from "./solana-rpc.js";
import { getAdaptiveSmartWalletContext, evaluateSmartWalletCandidate, selectSmartWalletCandidates } from "../smart-wallet-strategy.js";
import { applyScoreDecay } from "../wallet-score-decay.js";
import { getSmartMoneyWallets, getKolWallets, getWalletStats, isGmgnEnabled } from "./gmgn.js";
import { config } from "../config.js";
import { passesSmartMoneyFilter } from "../smart-money-filter.js";

export { applyScoreDecay } from "../wallet-score-decay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERED_FILE = path.join(__dirname, "../discovered-wallets.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const HELIUS_BASE = "https://api.helius.xyz/v0";

// Top-owner extraction routes through the shared, rate-limited RPC connection
// so discovery scans can't burst the Helius endpoint into 429s. See
// tools/solana-rpc.js.
function getSolanaConnection() {
  return getSharedConnection();
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

const MAX_DISCOVERED_WALLETS = 500; // cap to prevent unbounded file growth

function saveDiscovered(data) {
  // Prune to MAX_DISCOVERED_WALLETS, keeping highest-quality entries
  const entries = Object.entries(data);
  if (entries.length > MAX_DISCOVERED_WALLETS) {
    entries.sort((a, b) => (b[1]?.selection?.score || 0) - (a[1]?.selection?.score || 0));
    const kept = entries.slice(0, MAX_DISCOVERED_WALLETS);
    data = Object.fromEntries(kept);
  }
  atomicWriteJson(DISCOVERED_FILE, data);
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
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 429) {
      helius429Hit();
      throw new Error("Helius 429");
    }
    if (!res.ok) throw new Error(`Helius ${res.status}`);
    heliusSuccess();
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
  let total_win_sol = 0;
  let total_loss_sol = 0; // stored as positive magnitude
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
          if (pnl > 0) { wins += 1; total_win_sol += pnl; }
          else { losses += 1; total_loss_sol += Math.abs(pnl); }
          if (earliest_buy_ts) total_hold_seconds += (s.ts - earliest_buy_ts);
        }
      }
    }
  }

  const winrate = completed_trades > 0 ? wins / completed_trades : 0;
  const avg_hold = completed_trades > 0 ? total_hold_seconds / completed_trades : 0;
  const profit_factor = total_loss_sol > 0
    ? Number((total_win_sol / total_loss_sol).toFixed(3))
    : (total_win_sol > 0 ? null : null); // null = not enough data

  return {
    skip: false,
    total_swaps: swaps.length,
    unique_tokens: byMint.size,
    completed_trades,
    wins,
    losses,
    winrate: Number(winrate.toFixed(3)),
    realized_pnl_sol: Number(realized_pnl_sol.toFixed(4)),
    total_win_sol: Number(total_win_sol.toFixed(4)),
    total_loss_sol: Number(total_loss_sol.toFixed(4)),
    profit_factor,
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
// P3-5: cap how many wallets auto_add can promote per run.
// Attacker-manufactured trending tokens can plant wallets in smart-money
// list; allowing unlimited auto-add in one call creates a copy-trade loop.
const MAX_AUTO_ADD_PER_RUN = 3;
// Minimum completed trades before a wallet qualifies for auto-add.
// Snapshot-only wallets (single trade) pass the WR gate but aren't trustworthy.
const MIN_AUTO_ADD_TRADES = 10;

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
  const heliusOK = apiKey && apiKey !== "dummy-helius-key";
  const gmgnOK = isGmgnEnabled() && config.gmgn?.discovery !== false;

  if (!heliusOK && !gmgnOK) {
    return { error: "No scoring provider configured (set GMGN_API_KEY or HELIUS_API_KEY)", discovered: [] };
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

  // Stage 3 — score each candidate.
  // GMGN primary (no Helius quota cost) → Helius fallback when GMGN unavailable.
  const MAX_CANDIDATES_PER_SCAN = 20;
  const SCAN_CAP = Math.min(candidates.length, MAX_CANDIDATES_PER_SCAN);
  if (candidates.length > MAX_CANDIDATES_PER_SCAN) {
    log("discovery", `Capping wallet candidates ${candidates.length} -> ${MAX_CANDIDATES_PER_SCAN}`);
  }
  const discovered = loadDiscovered();
  const results = [];

  const useGmgn = gmgnOK;
  const scoringSource = useGmgn ? (heliusOK ? "gmgn (Helius fallback)" : "gmgn") : "helius";
  log("discovery", `Scoring source: ${scoringSource}`);

  for (let i = 0; i < SCAN_CAP; i++) {
    if (!useGmgn && heliusCircuitOpen()) {
      log("discovery", `Helius circuit open — stopping wallet scoring early (${i}/${SCAN_CAP} done)`);
      break;
    }
    const [addr, sourcesSet] = candidates[i];
    try {
      let stats;

      // When the avg-hold figure is unknown (GMGN stats don't expose it) we must
      // NOT fabricate a passing value — that would silently promote bot/MEV
      // wallets the hold-time filter exists to reject. Track presence explicitly.
      let holdKnown = true;

      let gmgnUnavailable = false;
      if (useGmgn) {
        // GMGN is primary. A null result means the provider was unavailable;
        // an empty array is a valid response and must not spend Helius quota.
        const raw = await getWalletStats(addr, "30d");
        if (raw === null) {
          gmgnUnavailable = true;
        } else {
          const w = Array.isArray(raw) ? raw[0] : raw;
          if (!w) continue;
          holdKnown = false;
          stats = {
            winrate: w.winRate != null ? Number(w.winRate) : 0,
            realized_pnl_sol: null,
            realized_pnl_usd: Number(w.realizedPnlUsd ?? 0),
            completed_trades: Number(w.tradeCount ?? 0),
            total_swaps: Number(w.tradeCount ?? 0),
            avg_hold_seconds: null,
            unique_tokens: Number(w.uniqueTokens ?? 0),
            skip: false,
            _source: "gmgn",
          };
          if (stats.completed_trades < 1) continue;
        }
      }

      if (!useGmgn || gmgnUnavailable) {
        if (!heliusOK) continue;
        if (heliusCircuitOpen()) {
          log("discovery", "Helius circuit open - skipping fallback for " + addr.slice(0, 8));
          continue;
        }
        if (gmgnUnavailable) {
          log("discovery", "GMGN unavailable for " + addr.slice(0, 8) + " - using Helius fallback");
        }
        const txns = await fetchHeliusTxns(addr, apiKey, 50);
        if (!txns?.length) continue;
        stats = analyzeWallet(txns);
        if (stats.skip) continue;
        holdKnown = true;
      }

      const botReason = looksLikeBot(stats);
      // GMGN reports PnL in USD — compare against a USD equivalent (~$75 ≈ 0.5 SOL).
      // Helius path stores real SOL in realized_pnl_sol and uses min_realized_pnl_sol.
      const MIN_GMGN_PNL_USD = 75;
      const pnlQualifies = stats._source === "gmgn"
        ? (stats.realized_pnl_usd ?? 0) >= MIN_GMGN_PNL_USD
        : (stats.realized_pnl_sol ?? 0) >= min_realized_pnl_sol;
      const baseQualifies =
        !botReason &&
        stats.completed_trades >= min_trades &&
        stats.winrate >= min_winrate &&
        pnlQualifies &&
        // Only enforce the hold-time ceiling when we actually have the figure.
        (!holdKnown || stats.avg_hold_seconds <= max_avg_hold_seconds);

      // Smart money quality filter (4-criteria gate, enabled via config).
      let smfResult = null;
      let qualifies = baseQualifies;
      if (baseQualifies && config.smartMoneyFilter?.enabled) {
        smfResult = passesSmartMoneyFilter(stats, config.smartMoneyFilter);
        if (!smfResult.passes) {
          log("discovery", `${addr.slice(0, 8)} rejected by quality filter: ${smfResult.failures.join(", ")}`);
          qualifies = false;
        }
      }

      const sourceTokens = [...new Set([...(discovered[addr]?.source_tokens || []), ...sourcesSet])];

      const entry = {
        address: addr,
        first_seen_at: discovered[addr]?.first_seen_at || new Date().toISOString(),
        last_scored_at: new Date().toISOString(),
        stats,
        bot_filter: botReason,
        qualifies,
        smf: smfResult ? { score: smfResult.score, failures: smfResult.failures, metrics: smfResult.metrics } : null,
        promoted: discovered[addr]?.promoted || false,
        source_tokens: sourceTokens,
      };
      entry.selection = evaluateSmartWalletCandidate(entry, adaptiveContext);

      discovered[addr] = entry;
      results.push(entry);

      // P3-5: auto_add is capped at MAX_AUTO_ADD_PER_RUN and requires a minimum
      // track record. Without this, a single scan of attacker-manufactured
      // trending tokens could flood the smart-money list in one call.
      const autoAddCount = results.filter(r => r.promoted).length;
      const meetsTrackRecord = (stats.completed_trades || 0) >= MIN_AUTO_ADD_TRADES;
      if (qualifies && entry.selection.selected && auto_add && !entry.promoted
          && autoAddCount < MAX_AUTO_ADD_PER_RUN && meetsTrackRecord) {
        await addSmartWallet({
          address: addr,
          label: `auto:wr${Math.round(stats.winrate * 100)}_pnl${stats._source === "gmgn" ? `${(stats.realized_pnl_usd ?? 0).toFixed(2)}USD` : `${(stats.realized_pnl_sol ?? 0).toFixed(2)}SOL`}_n${stats.completed_trades}`,
          source_tokens: sourceTokens,
          stats,
          selection: entry.selection,
          notes: entry.selection.reasons.join("; "),
        });
        entry.promoted = true;
        log("discovery", `Promoted ${addr.slice(0, 8)} — score ${entry.selection.score}, winrate ${stats.winrate}, pnl ${stats._source === "gmgn" ? `${stats.realized_pnl_usd ?? 0}USD` : `${stats.realized_pnl_sol ?? 0}SOL`}`);
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

/**
 * Sync GMGN smart money + KOL wallets into smart-wallets.json.
 * Merges GMGN-curated list (already scored by GMGN) with existing wallets.
 * Only adds wallets that meet minimum thresholds and aren't already tracked.
 *
 * @param {{ minWinRate?, minPnl?, maxNew? }} opts
 * @returns {{ added, skipped, total }}
 */
export async function syncGmgnWallets({ minWinRate = 0.60, minPnl = 0, maxNew = 30 } = {}) {
  if (!isGmgnEnabled() || config.gmgn?.discovery === false) {
    return { added: 0, skipped: 0, total: 0, reason: "gmgn_disabled" };
  }

  // Use allSettled to prevent one API failure from crashing discovery
  const results = await Promise.allSettled([
    getSmartMoneyWallets(100),
    getKolWallets(50),
  ]);
  const smartMoney = results[0].status === "fulfilled" ? results[0].value : [];
  const kols = results[1].status === "fulfilled" ? results[1].value : [];

  // smartmoney/kol are ACTIVITY FEEDS (no win rate); dedupe to distinct, untracked
  // wallets, then enrich each via wallet_stats (the real 0–1 win rate + USD PnL)
  // and filter on the enriched numbers — NOT on the feed (which has none).
  const existing = new Set(listSmartWallets().map(w => w.address));
  const candidates = [
    ...(Array.isArray(smartMoney) ? smartMoney : []),
    ...(Array.isArray(kols) ? kols : []),
  ].filter(w => w.address && !existing.has(w.address));

  if (candidates.length === 0) return { added: 0, skipped: 0, total: 0 };

  let added = 0;
  let scanned = 0;
  for (const w of candidates) {
    if (added >= maxNew) break;
    scanned++;
    try {
      const stats = await getWalletStats(w.address, "30d");
      const s = Array.isArray(stats) ? stats[0] : stats;
      const winRate = s?.winRate ?? 0;
      const pnlUsd = s?.realizedPnlUsd ?? 0;
      // minPnl is interpreted in USD (GMGN's PnL unit).
      if (winRate < minWinRate || pnlUsd < minPnl) continue;

      await addSmartWallet({
        address: w.address,
        label: w.label || `gmgn_${w.type}`,
        source_tokens: [],
        stats: {
          winrate: winRate,
          realized_pnl_usd: pnlUsd,
          completed_trades: s?.tradeCount ?? 0,
          total_swaps: s?.tradeCount ?? 0,
          last_active: s?.lastActive ?? null,
        },
        selection: {
          selected: true,
          score: Math.round(winRate * 100),
          win_rate: winRate,
          follow_mode: "shadow",
          source: `gmgn_${w.type}`,
        },
        notes: `Auto-synced from GMGN ${w.type} feed`,
      });
      added++;
    } catch (e) {
      log("gmgn_sync_warn", `Failed to add wallet ${w.address.slice(0, 8)}: ${e.message}`);
    }
  }

  const skipped = scanned - added;
  log("gmgn_sync", `Synced GMGN wallets: +${added} added, ${skipped} skipped (${candidates.length} candidates)`);
  return { added, skipped, total: candidates.length };
}
