/**
 * GMGN OpenAPI adapter — https://openapi.gmgn.ai
 *
 * Auth (read-only): X-APIKEY header + timestamp + client_id query params.
 * Timestamp must be within ±5s of server time; client_id UUID rejects replays within 7s.
 *
 * Rate limits: not documented, but observed ~30 req/min on free tier.
 * This module applies a 300ms inter-request gap and per-endpoint TTL caching
 * so callers can call freely without burning quota.
 *
 * All functions degrade gracefully — any error returns null/[]/{}
 * so the rest of the pipeline never breaks on GMGN unavailability.
 *
 * Wiring status (as of this module's introduction):
 *   WIRED  — getTopHolders, getWalletActivity, getWalletStats, getTokenSignals,
 *            getTrendingTokens, getTrenches, getSmartMoneyWallets, getKolWallets
 *            (rug-signals, holder enrichment, hunter, wallet discovery/copy-trade).
 *   RESERVED (defined, not yet consumed) — getTokenInfo, getTokenSecurity,
 *            getTokenPoolInfo, getTopTraders, getTokenKline, getCreatedTokens.
 *            These are an intentional adapter surface for the GMGN activation
 *            work. getTokenSecurity in particular feeds rug scoring, so per
 *            CLAUDE.md it must be wired through the experiment/collab gate
 *            (risk-rule change ⇒ experiment_id) — NOT bolted on ad hoc here.
 */

import crypto from "crypto";
import { log } from "../logger.js";
import { recordCounter } from "../metrics.js";

const BASE = "https://openapi.gmgn.ai";
const DEFAULT_CHAIN = "sol";
// Chains GMGN's OpenAPI supports. Unknown chains fall back to DEFAULT_CHAIN.
export const GMGN_CHAINS = ["sol", "base", "bsc", "eth"];

/** Normalize/guard a chain code — rejects unknown values to the default. */
export function normalizeChain(c) {
  const lc = String(c || "").toLowerCase();
  return GMGN_CHAINS.includes(lc) ? lc : DEFAULT_CHAIN;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function authQuery() {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  };
}

function getApiKey() {
  return process.env.GMGN_API_KEY || "";
}

function isEnabled() {
  const k = getApiKey();
  return Boolean(k && k.length > 8 && k !== "dummy-gmgn-key");
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

// Serialized rate-limit gate. A naive read-then-write of a timestamp races
// under concurrent callers (the screening loop fires many mints in parallel):
// they all read the same _lastCall, all compute a tiny gap, and all fire at
// once → 429. GMGN escalates bans on repeated 429s (5s → up to 5min), so we
// must hard-serialize spacing through a single promise chain.
const MIN_INTERVAL_MS = 300;
let _gate = Promise.resolve();
let _lastCall = 0;

function acquireSlot() {
  const prev = _gate;
  let release;
  _gate = new Promise((r) => { release = r; });
  return prev.then(async () => {
    const gap = MIN_INTERVAL_MS - (Date.now() - _lastCall);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    _lastCall = Date.now();
    return release;
  });
}

// Circuit breaker: GMGN bans escalate on repeated 429s, so on a rate-limit we
// stop hitting the API entirely for a cooldown rather than retrying.
let _circuitUntil = 0;
const CIRCUIT_COOLDOWN_MS = 60_000;

export function gmgnCircuitOpen() {
  return Date.now() < _circuitUntil;
}

async function gmgnFetch(method, path, query = {}, body = null, retries = 2, chain = DEFAULT_CHAIN) {
  if (!isEnabled()) return null;
  if (gmgnCircuitOpen()) {
    recordCounter("gmgn_circuit_skip");
    return null;
  }

  const aq = authQuery();
  const params = new URLSearchParams({ chain: normalizeChain(chain), ...query, ...aq });
  const url = `${BASE}${path}?${params}`;
  const headers = { "X-APIKEY": getApiKey(), "Content-Type": "application/json" };

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    // Network/5xx backoff between attempts (NOT for 429 — that opens the circuit).
    if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));

    const release = await acquireSlot();
    try {
      const opts = { method, headers, signal: AbortSignal.timeout(8000) };
      if (body !== null) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);

      if (res.status === 429) {
        // Do NOT retry — GMGN can extend the ban on repeated requests. Open the
        // circuit and bail so every other in-flight path also stands down.
        recordCounter("gmgn_rate_limit");
        _circuitUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
        log("gmgn_warn", `429 rate-limited — circuit open ${CIRCUIT_COOLDOWN_MS / 1000}s`);
        return null;
      }
      if (!res.ok) {
        if (i < retries) continue;
        return null;
      }
      const json = await res.json();
      recordCounter("gmgn_ok");
      return json?.data ?? json;
    } catch (e) {
      lastErr = e;
      if (i >= retries) break;
    } finally {
      release();
    }
  }
  log("gmgn_warn", `${method} ${path}: ${lastErr?.message}`);
  return null;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const _cache = new Map();

function cached(key, ttlMs) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.v;
  return undefined;
}

function putCache(key, v) {
  _cache.set(key, { ts: Date.now(), v });
  if (_cache.size > 2000) {
    const sorted = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of sorted.slice(0, 200)) _cache.delete(k);
  }
}

async function withCache(key, ttlMs, fn) {
  const hit = cached(key, ttlMs);
  if (hit !== undefined) return hit;
  const v = await fn();
  if (v !== null && v !== undefined) putCache(key, v);
  return v;
}

// ─── Token endpoints ──────────────────────────────────────────────────────────

/** Full token analytics: price, mcap, vol, security, holder breakdown. 5min TTL. */
export async function getTokenInfo(mint, chain = DEFAULT_CHAIN) {
  return withCache(`${chain}:token_info:${mint}`, 5 * 60_000, () =>
    gmgnFetch("GET", "/v1/token/info", { address: mint }, null, 2, chain)
  );
}

/**
 * Security check: honeypot, rug score, renounced, lock status.
 * Returns null if GMGN unavailable — caller must not hard-block on this.
 * 10min TTL.
 */
export async function getTokenSecurity(mint, chain = DEFAULT_CHAIN) {
  return withCache(`${chain}:token_sec:${mint}`, 10 * 60_000, () =>
    gmgnFetch("GET", "/v1/token/security", { address: mint }, null, 2, chain)
  );
}

/** Pool / liquidity details. 5min TTL. */
export async function getTokenPoolInfo(mint, chain = DEFAULT_CHAIN) {
  return withCache(`${chain}:pool_info:${mint}`, 5 * 60_000, () =>
    gmgnFetch("GET", "/v1/token/pool_info", { address: mint }, null, 2, chain)
  );
}

// ─── Market endpoints ─────────────────────────────────────────────────────────

/**
 * Top holders with GMGN classifications: smart_money, kol, rat, bundler, sniper, whale.
 * 8min TTL (matches holder-data-enricher cadence).
 *
 * @param {string} mint
 * @param {number} [limit=20]
 */
export async function getTopHolders(mint, limit = 20, chain = DEFAULT_CHAIN) {
  return withCache(`${chain}:top_holders:${mint}`, 8 * 60_000, () =>
    gmgnFetch("GET", "/v1/market/token_top_holders", { address: mint, limit }, null, 2, chain)
  );
}

/**
 * Top traders for a token (profitable wallets that traded it).
 * 10min TTL.
 */
export async function getTopTraders(mint, limit = 20, chain = DEFAULT_CHAIN) {
  return withCache(`${chain}:top_traders:${mint}`, 10 * 60_000, () =>
    gmgnFetch("GET", "/v1/market/token_top_traders", { address: mint, limit }, null, 2, chain)
  );
}

/**
 * OHLCV klines from GMGN. Resolution: 1m | 5m | 15m | 1h | 4h | 1d.
 * Falls back to GeckoTerminal if unavailable.
 * 3min TTL for fresh candles.
 */
export async function getTokenKline(mint, resolution = "5m", from = null, to = null, chain = DEFAULT_CHAIN) {
  const cacheKey = `${chain}:kline:${mint}:${resolution}:${from}:${to}`;
  return withCache(cacheKey, 3 * 60_000, () => {
    const q = { address: mint, resolution };
    if (from != null) q.from = from;
    if (to != null) q.to = to;
    return gmgnFetch("GET", "/v1/market/token_kline", q, null, 2, chain);
  });
}

/**
 * Trending tokens ranked by activity (GET /v1/market/rank).
 * interval: 1m | 5m | 1h | 6h | 24h
 * Returns a normalized array. The rank response uses GMGN's own field names
 * (`marketcap`, `change1h`, `volume`, `swaps`, `holder_count`) — not snake_case —
 * so we normalize here for a stable caller shape. 2min TTL.
 */
export async function getTrendingTokens(interval = "1h", limit = 50, chain = DEFAULT_CHAIN) {
  return withCache(`${chain}:trending:${interval}:${limit}`, 2 * 60_000, async () => {
    const raw = await gmgnFetch("GET", "/v1/market/rank", { interval, limit }, null, 2, chain);
    // VERIFIED 2026-05-31: /v1/market/rank double-wraps its envelope, so after
    // gmgnFetch peels one `data` layer the list still sits at `raw.data.rank`
    // (not `raw.rank`). Check both depths.
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw?.rank) ? raw.rank
      : Array.isArray(raw?.data?.rank) ? raw.data.rank
      : Array.isArray(raw?.tokens) ? raw.tokens
      : Array.isArray(raw?.data?.tokens) ? raw.data.tokens : null;
    if (!list) return null;
    return list.map(normalizeTrendingToken);
  });
}

// Per-chain launchpad platforms + quote address types required by the trenches
// body (mirrors gmgn-cli's buildTrenchesBody — the endpoint rejects a body that
// doesn't carry these per-category sections). The SOL values are VERIFIED; the
// EVM launchpad strings/quote-type ints are NOT yet confirmed, so those chains
// are left out of the map and getTrenches skips them gracefully (returns []).
// Trending (/v1/market/rank) is chain-generic and is the primary EVM discovery
// surface until the EVM trenches platform values are researched.
const TRENCHES_PLATFORMS = {
  sol: [
    "Pump.fun", "pump_mayhem", "pump_agent", "letsbonk", "bonkers", "bags",
    "memoo", "liquid", "moonshot_app", "heaven", "believe", "boop",
    "ray_launchpad", "meteora_virtual_curve",
  ],
};
const TRENCHES_QUOTE_ADDRESS_TYPES = {
  sol: [4, 5, 3, 1, 13, 0],
};

/**
 * New token discovery ("trenches") — POST /v1/trenches.
 * types: "new_creation" | "near_completion" | "completed"
 * Request body is keyed per-category, response likewise — both mirror the
 * official client. Returns a flat array, each item tagged with `_trench_type`.
 * Chains without a known launchpad map (EVM, pending research) return [] rather
 * than sending a guessed body that the API would reject with HTTP 400.
 * 2min TTL.
 */
export async function getTrenches(types = ["new_creation", "near_completion", "completed"], limit = 50, chain = DEFAULT_CHAIN) {
  const c = normalizeChain(chain);
  const platforms = TRENCHES_PLATFORMS[c];
  const quoteTypes = TRENCHES_QUOTE_ADDRESS_TYPES[c];
  if (!platforms || !quoteTypes) return []; // no known launchpad map for this chain
  const cacheKey = `${c}:trenches:${types.join(",")}:${limit}`;
  return withCache(cacheKey, 2 * 60_000, async () => {
    const section = {
      filters: ["offchain", "onchain"],
      launchpad_platform: platforms,
      quote_address_type: quoteTypes,
      launchpad_platform_v2: true,
      limit: Math.min(limit, 80),
    };
    const body = { version: "v2" };
    for (const t of types) body[t] = { ...section };

    const raw = await gmgnFetch("POST", "/v1/trenches", {}, body, 2, c);
    if (!raw) return null;
    if (Array.isArray(raw)) {
      return raw.map((it) => ({ ...it, _trench_type: it.type || "unknown" }));
    }

    // VERIFIED 2026-05-31: the response taxonomy is SERVER-driven and does NOT
    // echo the requested keys — requesting new_creation/near_completion/completed
    // returns buckets `new_creation`, `completed`, `pump` (near_completion maps
    // to `pump`). So parse whatever bucket keys come back, tagged with the real
    // key, instead of iterating the requested `types` (which dropped buckets).
    const out = [];
    for (const [key, bucket] of Object.entries(raw)) {
      if (key === "version") continue;
      const items = Array.isArray(bucket) ? bucket
        : Array.isArray(bucket?.tokens) ? bucket.tokens
        : Array.isArray(bucket?.list) ? bucket.list : null;
      if (!items) continue;
      for (const it of items) out.push({ ...it, _trench_type: key });
    }
    return out;
  });
}

// VERIFIED 2026-05-31 against the live API + gmgn-cli: `groups` is an array of
// GROUP OBJECTS `{ signal_type:[…], …filters }`, NOT bare ints. signal_type
// values 14/15/16 are rejected; 1–13,17,18 are supported. The old
// `groups:[1,2,3]` returned HTTP 400 ("invalid json body") → the signal feed
// was silently dead. Default to all supported types.
const SIGNAL_TYPES_SUPPORTED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18];

/**
 * Smart-money / large-buy / KOL token signals (POST /v1/market/token_signal).
 * Returns a flat array of signal rows (token_address, signal_type, market_cap,
 * signal_times, …) or null. 3min TTL.
 *
 * @param {number[]} [signalTypes] subset of 1–13,17,18 (14/15/16 unsupported)
 * @param {object}   [filters]     optional group filters (mc_min, mc_max, …)
 */
export async function getTokenSignals(signalTypes = SIGNAL_TYPES_SUPPORTED, filters = {}, chain = DEFAULT_CHAIN) {
  const c = normalizeChain(chain);
  const types = (Array.isArray(signalTypes) ? signalTypes : [signalTypes])
    .map(Number)
    .filter((t) => Number.isFinite(t) && ![14, 15, 16].includes(t));
  const group = { signal_type: types.length ? types : SIGNAL_TYPES_SUPPORTED, ...filters };
  const cacheKey = `${c}:signals:${group.signal_type.join(",")}:${JSON.stringify(filters)}`;
  return withCache(cacheKey, 3 * 60_000, async () => {
    const raw = await gmgnFetch("POST", "/v1/market/token_signal", {}, { chain: c, groups: [group] }, 2, c);
    return asFeed(raw);
  });
}

// ─── User/wallet endpoints ────────────────────────────────────────────────────

/**
 * GMGN's smart-money stream — VERIFIED 2026-05-31 to be a per-trade ACTIVITY
 * FEED (rows = {maker, side, base_token, maker_info{tags}}), NOT a wallet-stats
 * list. We aggregate it into distinct wallets (keyed by `maker`) with their
 * feed-derived tags + activity count. Win rate / PnL are UNKNOWN from a feed —
 * callers must enrich via getWalletStats() before filtering on them.
 * 30min TTL (membership doesn't change minute to minute).
 *
 * @param {number} [limit=50]
 * @returns {Array<{address, label, tags, activityCount, winRate:null, realizedPnlUsd:null, tradeCount:null, source}>}
 */
export async function getSmartMoneyWallets(limit = 50) {
  return withCache(`smartmoney:${limit}`, 30 * 60_000, async () => {
    const feed = asFeed(await gmgnFetch("GET", "/v1/user/smartmoney", { limit }));
    if (!feed) return null;
    return aggregateFeedWallets(feed, "smart_money");
  });
}

/**
 * GMGN's KOL (Key Opinion Leader) stream — same per-trade activity-feed shape
 * as smartmoney; aggregated to distinct wallets. 30min TTL.
 *
 * @param {number} [limit=50]
 * @returns {Array<{address, label, tags, activityCount, winRate:null, realizedPnlUsd:null, tradeCount:null, source}>}
 */
export async function getKolWallets(limit = 50) {
  return withCache(`kol:${limit}`, 30 * 60_000, async () => {
    const feed = asFeed(await gmgnFetch("GET", "/v1/user/kol", { limit }));
    if (!feed) return null;
    return aggregateFeedWallets(feed, "kol");
  });
}

/**
 * Wallet performance stats (PnL, win rate, trade count) — normalized.
 * period: 7d | 30d | all. wallet_address can be a single string or array.
 * Always returns an ARRAY of normalized stat objects (or null on failure) so
 * callers have a stable shape. 15min TTL.
 *
 * @returns {Promise<Array<{address, winRate, realizedPnlUsd, pnlRatio, tradeCount, nativeBalanceSol, tags, lastActive, source}>>|null}
 */
export async function getWalletStats(walletAddress, period = "7d") {
  const addrs = Array.isArray(walletAddress) ? walletAddress : [walletAddress];
  const cacheKey = `wallet_stats:${addrs.join(",")}:${period}`;
  return withCache(cacheKey, 15 * 60_000, async () => {
    const raw = await gmgnFetch("GET", "/v1/user/wallet_stats", { wallet_address: addrs, period });
    if (raw == null) return null;
    const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.list) ? raw.list : [raw]);
    return rows.map(normalizeWalletStats).filter((r) => r.address);
  });
}

/**
 * Wallet trade activity — recent buy/sell history.
 * 10min TTL.
 */
export async function getWalletActivity(walletAddress, limit = 20) {
  return withCache(`wallet_act:${walletAddress}:${limit}`, 10 * 60_000, () =>
    gmgnFetch("GET", "/v1/user/wallet_activity", { wallet_address: walletAddress, limit })
  );
}

/**
 * Tokens created by a dev wallet (rug-check helper).
 * 15min TTL.
 */
export async function getCreatedTokens(devWallet, limit = 20) {
  return withCache(`created:${devWallet}:${limit}`, 15 * 60_000, () =>
    gmgnFetch("GET", "/v1/user/created_tokens", { wallet_address: devWallet, limit })
  );
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

/** Unwrap a GMGN list/feed response into a plain array, or null. */
function asFeed(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.list)) return raw.list;
  if (Array.isArray(raw?.data)) return raw.data;
  return null;
}

/**
 * Collapse a smart-money / KOL ACTIVITY FEED into distinct wallets keyed by
 * `maker`. The feed carries no win-rate/PnL — those fields are left null and
 * must be filled by getWalletStats(). Tags come from `maker_info.tags`.
 */
function aggregateFeedWallets(feed, type) {
  const byMaker = new Map();
  for (const row of feed) {
    const addr = row.maker || row.wallet_address || row.address || "";
    if (!addr) continue;
    const info = row.maker_info || row.common || {};
    let w = byMaker.get(addr);
    if (!w) {
      w = {
        address: addr,
        label: info.name || info.twitter_username || info.twitter || "",
        tags: Array.isArray(info.tags) ? info.tags : [],
        activityCount: 0,
        lastSide: null,
        lastToken: null,
        lastSeen: 0,
        // Unknown from a feed — caller enriches via getWalletStats().
        winRate: null,
        realizedPnlUsd: null,
        tradeCount: null,
        type,
        source: `gmgn_${type}`,
      };
      byMaker.set(addr, w);
    }
    w.activityCount += 1;
    const ts = Number(row.timestamp ?? 0);
    if (ts >= w.lastSeen) {
      w.lastSeen = ts;
      w.lastSide = row.side || w.lastSide;
      w.lastToken = row.base_address || row.base_token?.symbol || w.lastToken;
    }
  }
  return [...byMaker.values()].sort((a, b) => b.activityCount - a.activityCount);
}

/**
 * Normalize a GMGN /v1/user/wallet_stats row (VERIFIED 2026-05-31). Real shape:
 *   win_rate lives at `pnl_stat.winrate` (a 0–1 FRACTION), NOT top-level;
 *   `realized_profit` is in USD (NOT SOL); no `trade_count` → it's buy+sell;
 *   `native_balance` is SOL; identity in `common.{name,tags}`.
 */
function normalizeWalletStats(r) {
  if (!r || typeof r !== "object") return { address: "" };
  const buy = Number(r.buy ?? 0);
  const sell = Number(r.sell ?? 0);
  const common = r.common || {};
  return {
    address: r.wallet_address || r.address || "",
    winRate: Number(r.pnl_stat?.winrate ?? r.win_rate ?? r.winrate ?? 0), // 0–1
    realizedPnlUsd: Number(r.realized_profit ?? r.total_profit ?? 0),       // USD, not SOL
    pnlRatio: Number(r.realized_profit_pnl ?? 0),                           // return ratio
    tradeCount: (buy + sell) || Number(r.trade_count ?? r.total_trades ?? 0),
    uniqueTokens: Number(r.pnl_stat?.token_num ?? r.unique_tokens ?? r.token_num ?? 0),
    nativeBalanceSol: Number(r.native_balance ?? 0),
    label: common.name || r.name || "",
    tags: Array.isArray(common.tags) ? common.tags : [],
    lastActive: r.last_timestamp ?? r.last_active ?? null,
    source: "gmgn",
  };
}

/**
 * Extract the pre-computed per-token risk fields that GMGN embeds in every
 * /v1/market/rank and /v1/trenches row. All values are rates (0–1 fraction)
 * or counts; null means GMGN didn't include the field (treat as unknown, not 0).
 */
export function extractGmgnRowRisk(t) {
  const n = (v) => (v != null && v !== "") ? Number(v) : null;
  const b = (v) => (v === true || v === 1 || v === "true" || v === "1") ? true
    : (v === false || v === 0 || v === "false" || v === "0") ? false : null;
  return {
    // Rates / counts (0-1 fractions or integers; null = not provided by GMGN)
    rug_ratio: n(t.rug_ratio),
    sniper_count: n(t.sniper_count),
    bundler_rate: n(t.bundler_rate),
    top_10_holder_rate: n(t.top_10_holder_rate),
    top70_sniper_hold_rate: n(t.top70_sniper_hold_rate),
    rat_trader_amount_rate: n(t.rat_trader_amount_rate),
    dev_team_hold_rate: n(t.dev_team_hold_rate),
    suspected_insider_hold_rate: n(t.suspected_insider_hold_rate),
    fresh_wallet_rate: n(t.fresh_wallet_rate),
    bluechip_owner_percentage: n(t.bluechip_owner_percentage),
    // Booleans (null = not provided / unknown)
    is_honeypot: b(t.is_honeypot),
    renounced_mint: b(t.renounced_mint),
    renounced_freeze_account: b(t.renounced_freeze_account),
  };
}

/**
 * Normalize a GMGN /market/rank (trending) row to a stable shape. GMGN uses
 * `marketcap`, `change1h/5m`, `volume`, `swaps`, `holder_count`; numeric fields
 * can arrive as strings, so everything is coerced via Number().
 */
function normalizeTrendingToken(t) {
  return {
    address: t.address || t.token_address || t.mint || "",
    symbol: t.symbol || "?",
    name: t.name || t.symbol || "?",
    price: Number(t.price ?? 0),
    marketcap: Number(t.marketcap ?? t.usd_market_cap ?? t.market_cap ?? 0),
    liquidity: Number(t.liquidity ?? 0),
    volume: Number(t.volume ?? t.volume_1h ?? t.volume_24h ?? 0),
    swaps: Number(t.swaps ?? t.swaps_1h ?? t.swaps_24h ?? 0),
    holder_count: Number(t.holder_count ?? 0),
    // VERIFIED 2026-05-31: /v1/market/rank uses `price_change_percent1h/5m` and
    // `price_change_percent` (24h-ish); the old change1h/5m/24h names don't exist.
    change1h: Number(t.price_change_percent1h ?? t.change1h ?? 0),
    change5m: Number(t.price_change_percent5m ?? t.change5m ?? 0),
    change24h: Number(t.price_change_percent ?? t.change24h ?? 0),
    smart_buy_count: Number(t.smart_degen_count ?? t.smart_buy_24h ?? 0),
    created_timestamp: t.creation_timestamp ?? t.open_timestamp ?? t.created_timestamp ?? t.created_at ?? null,
    launchpad: t.launchpad || t.launchpad_platform || "unknown",
    _gmgn_risk: extractGmgnRowRisk(t),
  };
}

/**
 * Normalize GMGN top-holder entry to the shape expected by holder-data-enricher
 * and insider-detector: { address, wallet, balance, pct, tags }.
 */
export function normalizeTopHolder(h) {
  // VERIFIED 2026-05-31: the real percent field is `amount_percentage`, a 0–1
  // FRACTION (0.39 = 39%); downstream (rug-signals bundle_buyers_pct,
  // holder-enricher pct-diff) expects 0–100, so scale fractions up. Legacy
  // `percent`/`pct` (already 0–100) are kept as fallbacks and NOT rescaled.
  let pct;
  if (h.amount_percentage != null) {
    pct = Number(h.amount_percentage);
    if (Number.isFinite(pct) && pct <= 1) pct *= 100;
  } else {
    pct = Number(h.percent ?? h.pct ?? h.percentage ?? 0);
  }
  if (!Number.isFinite(pct)) pct = 0;

  // VERIFIED: classification is STRING tags (`tags`, `maker_token_tags`,
  // `wallet_tag_v2`), not is_* booleans. Match by keyword; keep boolean
  // fallbacks for any future/alternate shape.
  const tagStrings = [
    ...(Array.isArray(h.tags) ? h.tags : []),
    ...(Array.isArray(h.maker_token_tags) ? h.maker_token_tags : []),
    ...(Array.isArray(h.maker_tags) ? h.maker_tags : []),
    h.wallet_tag_v2,
  ].filter(Boolean).map((t) => String(t).toLowerCase());
  const has = (kw) => tagStrings.some((t) => t.includes(kw));

  return {
    address: h.address || h.wallet_address || h.account_address || "",
    wallet: h.address || h.wallet_address || h.account_address || "",
    balance: Number(h.balance ?? h.amount_cur ?? h.amount ?? 0),
    pct,
    tags: {
      smart_money: has("smart") || Boolean(h.is_smart_money || h.smart_money),
      kol: has("kol") || Boolean(h.is_kol || h.kol),
      rat: has("rat") || Boolean(h.is_rat || h.rat),
      bundler: has("bundle") || Boolean(h.is_bundler || h.bundler),
      sniper: has("snip") || Boolean(h.is_sniper || h.sniper),
      whale: has("whale") || Boolean(h.is_whale || h.whale),
    },
  };
}

export { isEnabled as isGmgnEnabled };

/** Flush cache — useful in tests. */
export function _resetGmgnCache() { _cache.clear(); }

/** Full state reset (cache + circuit + rate gate) — for deterministic tests. */
export function _resetGmgnState() {
  _cache.clear();
  _circuitUntil = 0;
  _lastCall = 0;
  _gate = Promise.resolve();
}
