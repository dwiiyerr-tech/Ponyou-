/**
 * Ticker Registry — learn symbol→mint mappings from observation history
 * and resolve user requests like "buy PEPE" to a concrete mint.
 *
 * Tickers in memecoin land are wildly ambiguous — there are hundreds of "PEPE"
 * tokens. This registry tracks every (symbol, mint) pair we've seen, ranks them
 * by liquidity + recency + verified status, and gives the user disambiguation
 * info when multiple candidates exist.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.join(__dirname, "../ticker-registry.json");

function load() {
  if (!fs.existsSync(REGISTRY_FILE)) return { tickers: {} };
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")); }
  catch { return { tickers: {} }; }
}

function save(data) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

function normSymbol(s) {
  return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

/**
 * Register or update a (symbol, mint) pair. Call this whenever we encounter
 * a token (during discovery, observation, swap, etc).
 */
export function registerTicker({ symbol, mint, mcap, liquidity, name, narrative }) {
  if (!symbol || !mint) return;
  const sym = normSymbol(symbol);
  if (!sym) return;

  const data = load();
  data.tickers[sym] = data.tickers[sym] || [];

  // Find existing entry for this mint
  const existing = data.tickers[sym].find(t => t.mint === mint);
  if (existing) {
    existing.last_seen_at = new Date().toISOString();
    if (mcap != null)      existing.mcap = mcap;
    if (liquidity != null) existing.liquidity = liquidity;
    if (name)              existing.name = name;
    if (narrative)         existing.narrative = narrative;
    existing.sightings = (existing.sightings || 0) + 1;
  } else {
    data.tickers[sym].push({
      mint,
      name: name || null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      mcap: mcap || null,
      liquidity: liquidity || null,
      narrative: narrative || null,
      sightings: 1,
    });
  }

  // Cap to top 20 per symbol — sorted by liquidity then sightings
  data.tickers[sym].sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0) || (b.sightings || 0) - (a.sightings || 0));
  if (data.tickers[sym].length > 20) {
    data.tickers[sym] = data.tickers[sym].slice(0, 20);
  }

  save(data);
}

/**
 * Resolve a symbol to candidate mints, ranked by best-match heuristic.
 * Returns disambiguation info when multiple candidates exist.
 */
export function resolveTicker({ symbol, prefer_min_liquidity = 1000 } = {}) {
  const sym = normSymbol(symbol);
  if (!sym) return { error: "empty symbol", candidates: [] };

  const data = load();
  const candidates = (data.tickers[sym] || [])
    .filter(t => (t.liquidity || 0) >= prefer_min_liquidity);

  if (candidates.length === 0) {
    return {
      symbol: sym,
      candidates: [],
      note: "No known mint for this ticker. Use discover_tokens or get_token_info to search live.",
    };
  }
  if (candidates.length === 1) {
    return {
      symbol: sym,
      resolved: candidates[0],
      candidates: [candidates[0]],
      unique: true,
    };
  }

  // Ambiguous — return all with disambiguation hints
  return {
    symbol: sym,
    resolved: null,
    candidates,
    unique: false,
    note: `${candidates.length} candidates for ticker ${sym}. Pick by mint, by liquidity ($), or by mcap.`,
  };
}

export function listTickers({ limit = 50 } = {}) {
  const data = load();
  const flat = [];
  for (const [sym, entries] of Object.entries(data.tickers || {})) {
    for (const t of entries) {
      flat.push({ symbol: sym, ...t });
    }
  }
  return flat
    .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))
    .slice(0, limit);
}

/**
 * Bulk import from token candidates surfaced during screening/discovery.
 * Use to backfill the registry from a candidates list.
 */
export function bulkRegister(tokens) {
  for (const t of tokens || []) {
    if (!t?.symbol || !t?.mint) continue;
    registerTicker({
      symbol: t.symbol,
      mint:   t.mint,
      mcap:   t.mcap,
      liquidity: t.liquidity,
      name:   t.name,
      narrative: t.narrative,
    });
  }
}
