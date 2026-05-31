/**
 * Historical OHLCV loader for the backtest engine.
 *
 * Produces a `[{ ts, price }]` price sequence (the shape simulateTrade/backtest
 * consume) from real on-chain candles, with a disk cache so backtests are
 * reproducible offline and don't re-hit rate-limited APIs.
 *
 * Source order: GMGN getTokenKline (own rate-gate + circuit breaker, only when a
 * key is set) → GeckoTerminal getTokenKlines (verified shape: candles[{time,
 * close}]). Everything degrades gracefully: on any failure the loader returns an
 * empty sequence with an `error` rather than throwing, so a backtest run never
 * crashes the harness.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { getTokenKlines } from "../tools/dexscreener.js";
import { getTokenKline as gmgnKline, isGmgnEnabled } from "../tools/gmgn.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Env-overridable so tests cache into a throwaway dir, never the repo.
const CACHE_DIR = process.env.PONYOU_BACKTEST_DATA_DIR || __dirname;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // candles are historical — 1 day is fine

function cachePath(mint, resolution) {
  const safe = String(mint).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CACHE_DIR, `ohlcv-${safe}-${resolution}.json`);
}

/**
 * Normalize assorted candle shapes into ascending [{ ts(ms), price }].
 * Handles GeckoTerminal ({time(sec), close}), array-of-arrays ([ts,o,h,l,c,v]),
 * and generic objects ({t|timestamp, c|close|price}).
 */
export function normalizeCandles(raw) {
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(raw?.candles)) list = raw.candles;
  else if (Array.isArray(raw?.list)) list = raw.list;
  else if (Array.isArray(raw?.data)) list = raw.data;
  if (!list) return [];

  const out = [];
  for (const c of list) {
    let ts, price;
    if (Array.isArray(c)) {            // [ts, o, h, l, c, v]
      ts = Number(c[0]); price = Number(c[4] ?? c[1]);
    } else if (c && typeof c === "object") {
      ts = Number(c.time ?? c.t ?? c.timestamp ?? c.ts);
      price = Number(c.close ?? c.c ?? c.price ?? c.o ?? c.open);
    }
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
    // Seconds → ms (anything < ~year 2001 in ms is really seconds).
    if (ts < 1e11) ts *= 1000;
    out.push({ ts, price });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function readCache(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.sequence)) return null;
    if (Date.now() - (data.fetched_at || 0) > CACHE_TTL_MS) return { ...data, stale: true };
    return data;
  } catch { return null; }
}

/**
 * Load a price sequence for a mint. Cache-first; fetch on miss.
 * @returns {Promise<{ mint, resolution, sequence, source, cached, error? }>}
 */
export async function loadPriceSequence(mint, { resolution = "5m", limit = 200, useCache = true } = {}) {
  const file = cachePath(mint, resolution);
  if (useCache) {
    const hit = readCache(file);
    if (hit && !hit.stale && hit.sequence.length) {
      return { mint, resolution, sequence: hit.sequence, source: hit.source, cached: true };
    }
  }

  let sequence = [];
  let source = null;

  // 1. GMGN (only if a key is set; own rate-gate + circuit breaker).
  if (isGmgnEnabled()) {
    try {
      const raw = await gmgnKline(mint, resolution);
      sequence = normalizeCandles(raw);
      if (sequence.length) source = "gmgn";
    } catch { /* fall through */ }
  }

  // 2. GeckoTerminal fallback (verified shape).
  if (!sequence.length) {
    try {
      const raw = await getTokenKlines({ mint, resolution, limit });
      sequence = normalizeCandles(raw);
      if (sequence.length) source = "geckoterminal";
    } catch { /* fall through */ }
  }

  if (!sequence.length) {
    // Last resort: serve a stale cache rather than nothing.
    const stale = readCache(file);
    if (stale?.sequence?.length) return { mint, resolution, sequence: stale.sequence, source: stale.source, cached: true, stale: true };
    return { mint, resolution, sequence: [], source: null, cached: false, error: "no candles from any source" };
  }

  try { atomicWriteJson(file, { mint, resolution, source, fetched_at: Date.now(), sequence }); } catch { /* cache best-effort */ }
  return { mint, resolution, sequence, source, cached: false };
}

/** Load several mints into an array of backtest `trades` ({ priceSequence }). */
export async function loadTrades(mints = [], opts = {}) {
  const trades = [];
  for (const mint of mints) {
    const r = await loadPriceSequence(mint, opts);
    if (r.sequence.length >= 2) {
      trades.push({ mint, priceSequence: r.sequence, marketCondition: opts.marketCondition ?? "NORMAL" });
    }
  }
  return trades;
}
