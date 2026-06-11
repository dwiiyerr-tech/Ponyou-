/**
 * Hunter Agent — Dedicated discovery sub-agent that actively hunts
 * for tokens matching Ponyou strategy criteria across multiple sources.
 *
 * Runs on its own cron independent of the main screening loop.
 * Found tokens are pre-scored and injected into the screening pipeline,
 * bypassing the passive DexScreener trending feed.
 *
 * Hunting strategy:
 *   1. Multi-query DexScreener search (narratives, trending topics)
 *   2. pump.fun ecosystem new launches
 *   3. Active Jupiter pairs with real volume
 *   4. Narrative-targeted keyword hunting
 *
 * Pre-score dimensions:
 *   - Liquidity depth (higher = better)
 *   - Volume quality (real swap activity)
 *   - Narrative match (strategy alignment)
 *   - Token age (not too fresh, not too old)
 *   - Holder signals (if Helius available)
 */

import { log } from "../logger.js";
import { config } from "../config.js";
import { getTrendingTokens, getTrenches, getTokenSignals, isGmgnEnabled, extractGmgnRowRisk } from "./gmgn.js";
import { recordChainSnapshot, getChainAllocationWeights } from "../market-chain-intel.js";
import { getChainOverrides } from "./vault-reader.js";
import { NARRATIVES, classifyNarrative, getNarrativeHeat, getCrossBatchVelocity } from "./narratives.js";

// ─── Hunting Sources ────────────────────────────────────────────

const DS_BASE = "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
// Jupiter retired quote-api.jup.ag in 2025. /tokens endpoint moved to tokens/v2/tag.
const JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1";
const JUPITER_TOKENS = "https://lite-api.jup.ag/tokens/v2/tag?query=verified";
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// ─── Expanded Hunting Queries ──────────────────────────────────
// Cycled to avoid API fatigue, covers all major meme narratives

const HUNT_QUERIES = [
  // AI / Agent narratives
  "ai", "agent", "gpt", "llm", "chat", "virtual", "ai16z", "autonomous",
  "neural", "brain", "compute", "singularity", "agi",
  // Meme culture
  "meme", "doge", "cat", "pepe", "wojak", "chad", "based", "based",
  "ponke", "bonk", "wif", "moodeng", "chillguy", "fartcoin",
  // Gaming / Metaverse
  "game", "gaming", "nft", "metaverse", "pixel", "rpg",
  // DeFi / Finance
  "defi", "swap", "yield", "staking", "liquidity", "rwa", "depin",
  // Solana ecosystem
  "sol", "solana", "spl", "pump",
  // Trending topics (rotating)
  "trump", "maga", "usa", "america", "freedom",
  "china", "japan", "korea", "europe",
  // Abstract / Vibe
  "moon", "sigma", "alpha", "quantum", "cyber", "digital",
  "cosmic", "eternal", "infinity", "zen",
];

// ─── Narrative-Heat-Driven Hunting ──────────────────────────────
// The rotation above is deliberate wide-net exploration. On top of it, each
// expedition gets up to HOT_QUERY_EXTRA additional queries aimed at narratives
// that are currently hot — sourced from cross-batch velocity (live momentum)
// and narrative heat (realized P&L). Additive only: the rotation window is
// never reduced, so full-list coverage is preserved.

const HOT_QUERY_EXTRA = 2;        // extra heat-driven queries per expedition
const MAX_HOT_NARRATIVES = 3;     // cap how many narratives steer hunting at once
const HOT_NARRATIVE_TTL_MS = 5 * 60_000;
let _hotNarrativeCache = { at: 0, narratives: [], queries: [] };

/**
 * Hot narratives in priority order: velocity sustained (multi-cycle momentum)
 * > heat hot (avg PnL > +10%) > velocity emerging. Heat-cold narratives
 * (avg PnL < -10%) are excluded — never steer the net toward proven losers.
 * Returns { narratives: [names], queries: [search keywords] }.
 */
export function getHotNarratives({ now = Date.now() } = {}) {
  if (now - _hotNarrativeCache.at < HOT_NARRATIVE_TTL_MS) return _hotNarrativeCache;

  const names = [];
  const push = (n) => {
    if (typeof n === "string" && NARRATIVES[n] && !names.includes(n)) names.push(n);
  };
  try {
    const velocity = getCrossBatchVelocity();
    const heat = getNarrativeHeat();
    for (const n of velocity.sustained || []) push(n);
    for (const n of heat.hot || []) push(n);
    for (const n of velocity.emerging || []) push(n);

    const cold = new Set(heat.cold || []);
    const narratives = names.filter(n => !cold.has(n)).slice(0, MAX_HOT_NARRATIVES);

    const queries = [];
    for (const n of narratives) {
      for (const kw of (NARRATIVES[n]?.keywords || []).slice(0, 2)) {
        if (!queries.includes(kw)) queries.push(kw);
      }
    }
    _hotNarrativeCache = { at: now, narratives, queries };
  } catch (e) {
    log("hunter", `Hot narrative lookup failed (non-fatal): ${e.message}`);
    _hotNarrativeCache = { at: now, narratives: [], queries: [] };
  }
  return _hotNarrativeCache;
}

// pump.fun DEX identifiers on DexScreener
export const PUMPFUN_DEXES = ["pumpswap", "pump.fun", "pumpfun", "pump", "pump swap"];
// Raydium — where tokens migrate after pump.fun graduation
const RAYDIUM_DEXES = ["raydium", "raydium clmm", "raydium cpmm"];
// LetsBonk.fun launchpad DEX identifiers on DexScreener
const LETSBONK_DEXES = ["launchlab", "letsbonk", "bonkfun", "raydium launchlab"];
// All Solana DEXes we care about
const SOLANA_DEXES = [...PUMPFUN_DEXES, ...RAYDIUM_DEXES, "orca", "meteora", "whirlpool"];

// ─── Scoring Constants ──────────────────────────────────────────

const MIN_LIQUIDITY = 500;
const MIN_SWAPS = 5;        // Higher bar than discovery pre-filter
const MIN_MCAP = 5000;
const MAX_TOKEN_AGE_HOURS = 168; // 7 days — don't hunt ancient tokens
const MIN_TOKEN_AGE_MINUTES = 5; // 5 min — skip fresh-launch snipes

// ─── HTTP Helpers ───────────────────────────────────────────────

async function fetchDS(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // Rate limited — exponential backoff with jitter before retrying.
        // Cap at 30s so a single hunt doesn't block the expedition too long.
        const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, i) + Math.random() * 500);
        if (i < retries) { await new Promise(r => setTimeout(r, backoffMs)); continue; }
        return null;
      }
      if (!res.ok) {
        if (i < retries) { await new Promise(r => setTimeout(r, 500 * (i + 1))); continue; }
        return null;
      }
      return await res.json();
    } catch {
      if (i >= retries) return null;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return null;
}

// ─── Token Mapping ──────────────────────────────────────────────

function mapPair(pair, source = "hunter") {
  const h24 = pair.txns?.h24 || {};
  const buys = h24.buys || 0;
  const sells = h24.sells || 0;
  const total = buys + sells;
  const vol = pair.volume?.h24 || 0;

  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    price: parseFloat(pair.priceUsd || 0),
    mcap: pair.marketCap || pair.fdv || 0,
    // P2-5: never substitute marketCap/fdv for missing liquidity —
    // conflating FDV with LP depth defeats the LP-hard-block in trash-filter.
    liquidity: pair.liquidity?.usd || 0,
    volume: vol,
    swaps: total,
    buys,
    sells,
    buy_vol: total > 0 ? vol * (buys / total) : 0,
    sell_vol: total > 0 ? vol * (sells / total) : 0,
    price_change_5m: pair.priceChange?.m5 || 0,
    price_change_1h: pair.priceChange?.h1 || 0,
    price_change_24h: pair.priceChange?.h24 || 0,
    created_at: pair.pairCreatedAt ? Math.floor(pair.pairCreatedAt / 1000) : null,
    pair_address: pair.pairAddress,
    dex: pair.dexId,
    launchpad: pair.dexId || "unknown",
    _hunter_source: source,
    _hunter_score: 0,
    narrative_tags: [],
    hot_level: 0,
    creator: null,
    timeframe: "24h",
  };
}

// ─── Pre-Scoring ────────────────────────────────────────────────

function computeHunterScore(token, strategy) {
  let score = 0;
  const reasons = [];

  // Liquidity depth (max 25)
  const liq = token.liquidity || 0;
  if (liq >= 50000) { score += 25; reasons.push("deep_liquidity"); }
  else if (liq >= 10000) { score += 20; reasons.push("solid_liquidity"); }
  else if (liq >= 2000) { score += 15; reasons.push("moderate_liquidity"); }
  else if (liq >= 500) { score += 8; reasons.push("min_liquidity"); }

  // Volume quality (max 25)
  const vol = token.volume || 0;
  const swaps = token.swaps || 0;
  if (vol >= 100000 && swaps >= 100) { score += 25; reasons.push("high_activity"); }
  else if (vol >= 10000 && swaps >= 20) { score += 18; reasons.push("moderate_activity"); }
  else if (vol >= 1000 && swaps >= 5) { score += 10; reasons.push("low_activity"); }

  // Buy/sell ratio — healthy tokens have balanced buys/sells (max 15)
  const total = (token.buys || 0) + (token.sells || 0);
  if (total > 0) {
    const buyRatio = token.buys / total;
    if (buyRatio >= 0.4 && buyRatio <= 0.6) { score += 15; reasons.push("balanced_flow"); }
    else if (buyRatio >= 0.3 && buyRatio <= 0.7) { score += 8; reasons.push("acceptable_flow"); }
    else { score += 3; reasons.push("unbalanced_flow"); }
  }

  // Token age (max 15)
  if (token.created_at) {
    const ageMin = (Date.now() / 1000 - token.created_at) / 60;
    if (ageMin >= 30 && ageMin <= 72 * 60) { score += 15; reasons.push("established_age"); }
    else if (ageMin >= 10 && ageMin < 30) { score += 10; reasons.push("seasoning"); }
    else if (ageMin >= 5 && ageMin < 10) { score += 5; reasons.push("very_new"); }
  }

  // Market cap (max 10)
  const mcap = token.mcap || 0;
  if (mcap >= 50000 && mcap <= 5000000) { score += 10; reasons.push("target_mcap"); }
  else if (mcap >= 10000 && mcap < 50000) { score += 6; reasons.push("micro_mcap"); }

  // pump.fun ecosystem bonus (max 5)
  const dexLower = (token.dex || "").toLowerCase();
  if (PUMPFUN_DEXES.some(d => dexLower.includes(d))) {
    score += 5;
    reasons.push("pumpfun_ecosystem");
  }

  // Strategy narrative match bonus (max 5).
  // Entries that are taxonomy names ("AI", "DOGS", ...) match via
  // classifyNarrative word-boundary keywords — plain substring would
  // over-match (e.g. "ai" inside "chain"). Non-taxonomy entries keep the
  // legacy lowercase-substring behavior for custom strategy keywords.
  const strategyNarratives = strategy?.narratives || [];
  let narrativeMatch = false;
  if (strategyNarratives.length > 0) {
    const taxonomyTargets = strategyNarratives
      .map(n => String(n).toUpperCase())
      .filter(n => NARRATIVES[n]);
    if (taxonomyTargets.length > 0) {
      const tags = classifyNarrative(token);
      narrativeMatch = tags.some(t => taxonomyTargets.includes(t.narrative));
    }
    if (!narrativeMatch) {
      narrativeMatch = strategyNarratives.some(n =>
        typeof n === "string" && !NARRATIVES[n.toUpperCase()] && (
          (token.name || "").toLowerCase().includes(n.toLowerCase()) ||
          (token.symbol || "").toLowerCase().includes(n.toLowerCase())
        )
      );
    }
  }
  if (narrativeMatch) { score += 5; reasons.push("narrative_match"); }

  return {
    score: Math.min(100, score),
    reasons,
    tier: score >= 65 ? "PRIORITY" : score >= 45 ? "GOOD" : score >= 25 ? "WATCH" : "LOW",
  };
}

// ─── Hunting Functions ──────────────────────────────────────────

/**
 * Hunt via DexScreener multi-query search.
 * Cycles through different narrative keywords to find varied tokens.
 */
let _queryIdx = 0;
const SEARCH_WINDOW = 4; // queries fired in parallel per expedition
async function huntDexScreenerSearch(strategy) {
  // Take a rotating window of SEARCH_WINDOW queries instead of just one, so a
  // single expedition samples multiple narratives. _queryIdx advances by the
  // window each call so coverage walks the full HUNT_QUERIES list over time.
  const queries = [];
  for (let i = 0; i < SEARCH_WINDOW; i++) {
    queries.push(HUNT_QUERIES[(_queryIdx + i) % HUNT_QUERIES.length]);
  }
  _queryIdx += SEARCH_WINDOW;

  // Heat-driven extras ON TOP of the rotation window — exploration coverage
  // stays intact while hot narratives get extra eyes this expedition.
  const hot = getHotNarratives();
  let hotAdded = 0;
  for (const q of hot.queries) {
    if (hotAdded >= HOT_QUERY_EXTRA) break;
    if (!queries.includes(q)) { queries.push(q); hotAdded++; }
  }
  if (hotAdded > 0) {
    log("hunter", `Heat queries +${hotAdded} [${queries.slice(SEARCH_WINDOW).join(",")}] from hot narratives: ${hot.narratives.join(",")}`);
  }

  try {
    const results = await Promise.allSettled(
      queries.map(q => fetchDS(`${DS_BASE}/latest/dex/search?q=${encodeURIComponent(q)}`))
    );

    const tokens = [];
    const seen = new Set();

    for (let qi = 0; qi < results.length; qi++) {
      const r = results[qi];
      const query = queries[qi];
      if (r.status !== "fulfilled" || !r.value?.pairs) continue;
      const solPairs = r.value.pairs.filter(p => p.chainId === "solana");

      for (const pair of solPairs) {
        const mint = pair.baseToken.address;
        if (mint === SOL_MINT || seen.has(mint)) continue;
        seen.add(mint);

        const token = mapPair(pair, `search:${query}`);
        if (token.liquidity < MIN_LIQUIDITY) continue;
        if (token.swaps < MIN_SWAPS) continue;
        if (token.mcap > 0 && token.mcap < MIN_MCAP) continue;

        // Age filter
        if (token.created_at) {
          const ageMin = (Date.now() / 1000 - token.created_at) / 60;
          if (ageMin < MIN_TOKEN_AGE_MINUTES) continue;
          if (ageMin > MAX_TOKEN_AGE_HOURS * 60) continue;
        }

        const hunterScore = computeHunterScore(token, strategy);
        token._hunter_score = hunterScore.score;
        token._hunter_tier = hunterScore.tier;
        token._hunter_reasons = hunterScore.reasons;
        tokens.push(token);
      }
    }

    return tokens;
  } catch (e) {
    log("hunter_error", `DexScreener search hunt failed: ${e.message}`);
    return [];
  }
}

/**
 * Hunt pump.fun ecosystem for new launches.
 */
async function huntPumpFun(strategy) {
  try {
    const results = await Promise.allSettled([
      fetchDS(`${DS_BASE}/latest/dex/search?q=sol`),
      fetchDS(`${DS_BASE}/latest/dex/search?q=meme`),
    ]);

    const tokens = [];
    const seen = new Set();

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value?.pairs) continue;
      const solPairs = result.value.pairs.filter(p => p.chainId === "solana");

      for (const pair of solPairs) {
        const dexId = (pair.dexId || "").toLowerCase();
        if (!PUMPFUN_DEXES.some(d => dexId.includes(d))) continue;

        const mint = pair.baseToken.address;
        if (mint === SOL_MINT || seen.has(mint)) continue;
        seen.add(mint);

        const token = mapPair(pair, "pumpfun");
        if (token.liquidity < MIN_LIQUIDITY) continue;
        if (token.swaps < MIN_SWAPS) continue;
        if (token.mcap > 0 && token.mcap < MIN_MCAP) continue;

        const hunterScore = computeHunterScore(token, strategy);
        token._hunter_score = hunterScore.score;
        token._hunter_tier = hunterScore.tier;
        token._hunter_reasons = hunterScore.reasons;
        tokens.push(token);
      }
    }

    return tokens;
  } catch (e) {
    log("hunter_error", `pump.fun hunt failed: ${e.message}`);
    return [];
  }
}

/**
 * Hunt LetsBonk.fun launchpad — a pump.fun alternative on Solana.
 * Complements GMGN trenches (mostly pump.fun) with a distinct launch source.
 */
async function huntLetsBonk(strategy) {
  try {
    // VERIFIED 2026-06-02: DexScreener search "launchlab" directly returns pairs
    // with dexId="launchlab". The previous queries "bonk"/"letsbonk" returned
    // BONK token and LetsBONK token pairs (orca/meteora/raydium) — not launchpad
    // pairs — so the isBonk filter never matched and 0lb appeared in every expedition.
    const results = await Promise.allSettled([
      fetchDS(`${DS_BASE}/latest/dex/search?q=launchlab`),
      fetchDS(`${DS_BASE}/latest/dex/search?q=letsbonk+launch`),
    ]);

    const tokens = [];
    const seen = new Set();

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value?.pairs) continue;
      const solPairs = result.value.pairs.filter(p => p.chainId === "solana");

      for (const pair of solPairs) {
        const dexId = (pair.dexId || "").toLowerCase();
        const labels = (pair.labels || []).map(l => String(l).toLowerCase());
        const isBonk = LETSBONK_DEXES.some(d => dexId.includes(d) || labels.some(l => l.includes(d)));
        if (!isBonk) continue;

        const mint = pair.baseToken.address;
        if (mint === SOL_MINT || seen.has(mint)) continue;
        seen.add(mint);

        const token = mapPair(pair, "letsbonk");
        if (token.liquidity < MIN_LIQUIDITY) continue;
        if (token.swaps < MIN_SWAPS) continue;
        if (token.mcap > 0 && token.mcap < MIN_MCAP) continue;

        const hunterScore = computeHunterScore(token, strategy);
        token._hunter_score = hunterScore.score;
        token._hunter_tier = hunterScore.tier;
        token._hunter_reasons = [...hunterScore.reasons, "letsbonk_launchpad"];
        tokens.push(token);
      }
    }

    return tokens;
  } catch (e) {
    log("hunter_error", `LetsBonk hunt failed: ${e.message}`);
    return [];
  }
}

/**
 * Hunt DexScreener gainers — tokens with highest price increases.
 * Timeframes: 1h, 6h, 24h. These are tokens with real momentum.
 */
async function huntGainers(strategy) {
  try {
    // Distinct queries from huntPumpFun (q=sol/q=meme) so the global dedup
    // doesn't starve this eye. These terms surface tokens with live momentum.
    const results = await Promise.allSettled([
      fetchDS(`${DS_BASE}/latest/dex/search?q=trending`),
      fetchDS(`${DS_BASE}/latest/dex/search?q=gainers`),
      fetchDS(`${DS_BASE}/latest/dex/search?q=new`),
    ]);

    const tokens = [];
    const seen = new Set();

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value?.pairs) continue;
      const solPairs = result.value.pairs.filter(p => p.chainId === "solana");

      for (const pair of solPairs) {
        const mint = pair.baseToken.address;
        if (mint === SOL_MINT || seen.has(mint)) continue;

        // Only tokens with significant price movement
        const change1h = pair.priceChange?.h1 || 0;
        const change6h = pair.priceChange?.h6 || 0;
        const change24h = pair.priceChange?.h24 || 0;
        const maxChange = Math.max(Math.abs(change1h), Math.abs(change6h), Math.abs(change24h));

        if (maxChange < 5) continue; // min 5% move to be interesting
        if (change1h > 500 || change6h > 1000) continue; // already pumped — skip

        seen.add(mint);
        const token = mapPair(pair, "gainers");
        if (token.liquidity < MIN_LIQUIDITY) continue;
        if (token.swaps < MIN_SWAPS * 2) continue; // gainers need real volume (was 3×, too tight)

        const hunterScore = computeHunterScore(token, strategy);
        token._hunter_score = Math.min(100, hunterScore.score + Math.min(10, maxChange / 10));
        token._hunter_tier = hunterScore.tier;
        token._hunter_reasons = [...hunterScore.reasons, `momentum:${maxChange.toFixed(0)}%`];
        token.price_change_1h = change1h;
        token.price_change_6h = change6h;
        token.price_change_24h = change24h;
        tokens.push(token);
      }
    }

    return tokens.sort((a, b) => Math.abs(b.price_change_1h || b.price_change_6h || 0) - Math.abs(a.price_change_1h || a.price_change_6h || 0));
  } catch { return []; }
}

/**
 * Hunt newest pairs — tokens that just launched.
 * Priority source for early-entry strategies.
 */
async function huntNewest(strategy) {
  try {
    // Use DexScreener profiles for brand new tokens
    const profileRes = await fetchDS(`${DS_BASE}/token-profiles/latest/v1`);
    if (!profileRes || !Array.isArray(profileRes)) return [];

    const solProfiles = profileRes.filter(p => p.chainId === "solana").slice(0, 20);
    if (solProfiles.length === 0) return [];

    const mintStr = solProfiles.map(p => p.tokenAddress).join(",");
    const pairData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mintStr}`);
    if (!pairData?.pairs) return [];

    const tokens = [];
    for (const pair of pairData.pairs.filter(p => p.chainId === "solana")) {
      const mint = pair.baseToken.address;
      if (mint === SOL_MINT) continue;

      const token = mapPair(pair, "newest");
      if (token.liquidity < MIN_LIQUIDITY * 0.5) continue; // newer tokens may have less liq
      if (token.mcap > 0 && token.mcap < MIN_MCAP) continue;

      // Only tokens < 6 hours old for "newest"
      if (token.created_at) {
        const ageMin = (Date.now() / 1000 - token.created_at) / 60;
        if (ageMin > 360) continue; // >6 hours = not "newest" anymore
        if (ageMin < MIN_TOKEN_AGE_MINUTES) continue;
      }

      const hunterScore = computeHunterScore(token, strategy);
      token._hunter_score = Math.min(100, hunterScore.score + (token.swaps > 20 ? 10 : 0));
      token._hunter_tier = hunterScore.tier;
      token._hunter_reasons = [...hunterScore.reasons, "new_launch"];
      tokens.push(token);
    }

    return tokens.sort((a, b) => (b.swaps || 0) - (a.swaps || 0));
  } catch { return []; }
}

/**
 * GeckoTerminal v2 returns base-token ids network-prefixed, e.g.
 * "solana_So11111111111111111111111111111111111111112". The bare base58
 * mint is everything after the network prefix. Passing the prefixed id
 * downstream 400s every mint-keyed call (RugCheck, Helius, on-chain
 * lookups, position tracking), so strip it here at the source.
 *
 * @param {string} rawId  pool.relationships.base_token.data.id
 * @returns {string|null} bare mint, or null when unusable
 */
export function geckoMintFromId(rawId) {
  if (typeof rawId !== "string" || rawId.length === 0) return null;
  const us = rawId.indexOf("_");
  const bare = us >= 0 ? rawId.slice(us + 1) : rawId;
  return bare || null;
}

/**
 * Hunt GeckoTerminal — free API, trending pools on Solana.
 * Different perspective from DexScreener, catches tokens missed by DS.
 */
async function huntGeckoTerminal(strategy) {
  try {
    const res = await fetch(`${GECKO_BASE}/networks/solana/trending_pools?page=1`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const pools = data?.data || [];

    const tokens = [];
    const seen = new Set();

    for (const pool of pools.slice(0, 25)) {
      const attrs = pool.attributes || {};
      const token = attrs.base_token_price_quote_token
        || attrs.quote_token_price_base_token
        || null;
      // base_token.data.id is "solana_<mint>"; attrs.address is the POOL
      // address (see pair_address below), never a valid token mint — so we
      // strip the prefix and skip pools that carry no base token.
      const mint = geckoMintFromId(pool.relationships?.base_token?.data?.id);
      if (!mint || mint === SOL_MINT || seen.has(mint)) continue;
      seen.add(mint);

      const tokenData = {
        mint,
        symbol: attrs.name?.split(" / ")[0] || attrs.symbol || "?",
        name: attrs.name || "?",
        price: parseFloat(attrs.base_token_price_usd || 0),
        mcap: parseFloat(attrs.market_cap_usd || attrs.fdv_usd || 0),
        liquidity: parseFloat(attrs.reserve_in_usd || 0),
        volume: parseFloat(attrs.volume_usd?.h24 || 0),
        swaps: attrs.transactions?.h24?.buys + attrs.transactions?.h24?.sells || 0,
        buys: attrs.transactions?.h24?.buys || 0,
        sells: attrs.transactions?.h24?.sells || 0,
        price_change_1h: parseFloat(attrs.price_change_percentage?.h1 || 0),
        price_change_24h: parseFloat(attrs.price_change_percentage?.h24 || 0),
        buy_vol: 0,
        sell_vol: 0,
        created_at: null,
        pair_address: attrs.address || null,
        dex: attrs.dex_id || "unknown",
        launchpad: attrs.dex_id || "unknown",
        _hunter_source: "geckoterminal",
        _hunter_score: 0,
        narrative_tags: [],
        hot_level: 0,
        creator: null,
        timeframe: "24h",
      };

      if (tokenData.liquidity < MIN_LIQUIDITY) continue;
      if (tokenData.mcap > 0 && tokenData.mcap < MIN_MCAP) continue;

      const hunterScore = computeHunterScore(tokenData, strategy);
      tokenData._hunter_score = hunterScore.score;
      tokenData._hunter_tier = hunterScore.tier;
      tokenData._hunter_reasons = [...hunterScore.reasons, "geckoterminal"];

      tokens.push(tokenData);
    }

    return tokens.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  } catch { return []; }
}

/**
 * Hunt Smart Money Inflow — detects tokens that tracked smart wallets
 * are actively buying. Highest-priority signal: smart money = conviction.
 * Feeds wallet ping signals as Eye #7 into the discovery pipeline.
 */
async function huntSmartMoney(strategy) {
  try {
    // Dynamic import to avoid circular dependency
    const { getSmartMoneyInflow } = await import("./dexscreener.js");
    const inflow = await getSmartMoneyInflow({ timeframe: "1h" });

    if (!inflow?.tokens || inflow.tokens.length === 0) {
      return []; // No smart money activity or no wallets tracked
    }

    const tokens = [];
    for (const smToken of inflow.tokens.slice(0, 15)) {
      // Smart money signal is strong — these tokens get priority
      const token = {
        mint: smToken.mint,
        symbol: smToken.symbol || "?",
        name: smToken.symbol || "?",
        price: smToken.price || 0,
        mcap: smToken.market_cap || smToken.mcap || 0,
        liquidity: smToken.liquidity || 0,
        volume: smToken.volume || 0,
        swaps: 0,
        buys: smToken.buy_count || 0,
        sells: smToken.sell_count || 0,
        price_change_1h: 0,
        price_change_6h: 0,
        price_change_24h: 0,
        buy_vol: 0,
        sell_vol: 0,
        // P2-10: mark unknown age explicitly so the age gate can treat it as
        // age-unverified, preventing anti-snipe bypass via null created_at.
        created_at: smToken.created_at || null,
        _age_unknown: !smToken.created_at, // flag for downstream age gate
        pair_address: null,
        dex: "unknown",
        launchpad: "unknown",
        _hunter_source: "smart_money",
        _hunter_score: 0,
        narrative_tags: [],
        hot_level: 3, // MAX hot_level — smart money is the strongest signal
        creator: null,
        timeframe: "1h",
        _smart_money: {
          uniqueWallets: smToken.unique_wallets || 0,
          buyCount: smToken.buy_count || 0,
          sellCount: smToken.sell_count || 0,
          buyRatio: smToken.buy_ratio || 0,
          weightedScore: smToken.weighted_buy_score || 0,
          topWallet: smToken.top_wallet_label || null,
        },
      };

      // Smart money tokens get elevated base score
      const walletCount = smToken.unique_wallets || 0;
      const buyRatio = smToken.buy_ratio || 0;

      let score = 40; // base: already interesting because smart money is watching
      if (walletCount >= 3) score += 25;      // 3+ smart wallets buying = VERY strong
      else if (walletCount >= 2) score += 18;  // 2 wallets = strong
      else score += 10;                         // 1 wallet = worth watching

      if (buyRatio >= 0.8) score += 15;        // mostly buying = accumulation
      else if (buyRatio >= 0.6) score += 8;     // slight buying bias

      if (smToken.weighted_buy_score > 3) score += 10; // high-quality wallets buying

      token._hunter_score = Math.min(100, score);
      token._hunter_tier = walletCount >= 2 ? "PRIORITY" : "GOOD";
      token._hunter_reasons = [
        `smart_money:${walletCount}wallets`,
        buyRatio >= 0.8 ? "accumulation" : "watching",
      ];

      tokens.push(token);
    }

    // Sort: most wallets buying first
    return tokens.sort((a, b) =>
      (b._smart_money?.uniqueWallets || 0) - (a._smart_money?.uniqueWallets || 0)
    );
  } catch (e) {
    log("hunter_error", `Smart money hunt failed: ${e.message}`);
    return [];
  }
}

/**
 * Hunt Jupiter for actively traded tokens.
 */
async function huntJupiter(strategy) {
  try {
    const res = await fetch(JUPITER_TOKENS, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const jupTokens = await res.json();
    if (!Array.isArray(jupTokens) || jupTokens.length === 0) return [];

    // New API: token mint is in `id` field
    const solTokens = jupTokens.slice(0, 50);
    const mintStr = solTokens.map(t => t.id || t.address).filter(Boolean).slice(0, 25).join(",");
    const pairData = await fetchDS(`${DS_BASE}/latest/dex/tokens/${mintStr}`);
    if (!pairData?.pairs) return [];

    const tokens = [];
    for (const pair of pairData.pairs.filter(p => p.chainId === "solana")) {
      const mint = pair.baseToken.address;
      if (mint === SOL_MINT) continue;
      const token = mapPair(pair, "jupiter");
      if (token.liquidity < MIN_LIQUIDITY) continue;
      if (token.swaps < MIN_SWAPS * 2) continue; // Jupiter tokens should have more activity

      const hunterScore = computeHunterScore(token, strategy);
      token._hunter_score = hunterScore.score;
      token._hunter_tier = hunterScore.tier;
      token._hunter_reasons = hunterScore.reasons;
      tokens.push(token);
    }
    return tokens;
  } catch (e) {
    log("hunter_error", `Jupiter hunt failed: ${e.message}`);
    return [];
  }
}

// ─── Main Hunter Agent ──────────────────────────────────────────

let _hunterRunning = false;
let _hunterStats = {
  cycles: 0,
  totalFound: 0,
  priorityFound: 0,
  lastRun: null,
  lastError: null,
};

/**
 * Apply score penalty from GMGN's pre-computed per-row risk fields.
 * Returns [penalizedScore, reasons[]] so the caller can append them.
 * null fields = GMGN didn't report them; treated as no penalty (unknown ≠ risky).
 */
export function applyGmgnRiskPenalty(score, risk) {
  if (!risk) return [score, []];
  const reasons = [];
  const { rug_ratio, sniper_count, bundler_rate, rat_trader_amount_rate, suspected_insider_hold_rate } = risk;
  if (rug_ratio != null && rug_ratio > 0.35) { score -= 20; reasons.push(`rug_ratio:${(rug_ratio * 100).toFixed(0)}%`); }
  if (sniper_count != null && sniper_count > 30) { score -= 15; reasons.push(`snipers:${sniper_count}`); }
  if (bundler_rate != null && bundler_rate > 0.25) { score -= 15; reasons.push(`bundlers:${(bundler_rate * 100).toFixed(0)}%`); }
  if (rat_trader_amount_rate != null && rat_trader_amount_rate > 0.3) { score -= 10; reasons.push(`rats:${(rat_trader_amount_rate * 100).toFixed(0)}%`); }
  if (suspected_insider_hold_rate != null && suspected_insider_hold_rate > 0.25) { score -= 10; reasons.push(`insiders:${(suspected_insider_hold_rate * 100).toFixed(0)}%`); }
  return [Math.max(0, score), reasons];
}

/**
 * Hunt GMGN trending rank — tokens with highest activity on 1h and 5m intervals.
 * Returns tokens with GMGN-sourced momentum signals.
 */
async function huntGmgnTrending(strategy) {
  if (!isGmgnEnabled() || config.gmgn?.hunter === false) return [];
  // Run discovery per active chain. Default ["sol"] = single-chain (current
  // behavior). Chains are processed sequentially because the GMGN rate-gate is
  // global/per-key — parallel fan-out just queues on the same 300ms gate.
  const _disabledChains = new Set(getChainOverrides().disable_chains);
  const chains = (Array.isArray(config.gmgn?.chains) && config.gmgn.chains.length > 0
    ? config.gmgn.chains : ["sol"]
  ).filter(c => !_disabledChains.has(c));
  const seen = new Set();
  // Bucket processed tokens per chain so we can record per-chain market intel
  // and then trim each chain's contribution by its allocation weight.
  const perChain = new Map(); // chain → token[]

  for (const chain of chains) {
    const chainTokens = [];
    try {
      const [rank1h, rank5m] = await Promise.all([
        getTrendingTokens("1h", 40, chain),
        getTrendingTokens("5m", 20, chain),
      ]);

      const process = (items, interval) => {
        if (!Array.isArray(items)) return;
        for (const t of items) {
          // getTrendingTokens() already returns the normalized shape.
          const mint = t.address;
          if (!mint || seen.has(mint)) continue;
          seen.add(mint);

          const mcap = Number(t.marketcap ?? 0);
          const liq = Number(t.liquidity ?? 0);
          const vol = Number(t.volume ?? 0);
          const swaps = Number(t.swaps ?? 0);

          let score = 35;
          if (interval === "5m") score += 20; // faster signal = higher urgency
          if (mcap >= 100_000 && mcap <= 10_000_000) score += 15;
          if (liq >= 10_000) score += 10;
          if (swaps >= 50) score += 10;
          if (vol >= 50_000) score += 10;
          if (Number(t.smart_buy_count ?? 0) >= 3) score += 10; // smart money piling in

          const [penalizedScore, riskReasons] = applyGmgnRiskPenalty(score, t._gmgn_risk);
          const chainTag = chain !== "sol" ? [chain] : [];
          const reasons = [`gmgn_trending_${interval}`, ...chainTag, mcap ? `mcap:${Math.round(mcap / 1000)}k` : null, ...riskReasons].filter(Boolean);

          chainTokens.push({
            mint,
            chain,
            symbol: t.symbol || "?",
            name: t.name || t.symbol || "?",
            price: Number(t.price ?? 0),
            mcap,
            liquidity: liq,
            volume: vol,
            swaps,
            buys: 0,
            sells: 0,
            price_change_1h: Number(t.change1h ?? 0),
            price_change_6h: 0,
            price_change_24h: Number(t.change24h ?? 0),
            buy_vol: 0,
            sell_vol: 0,
            created_at: t.created_timestamp || null,
            pair_address: null,
            dex: "unknown",
            launchpad: t.launchpad || "unknown",
            _hunter_source: `gmgn_trending_${interval}`,
            _hunter_score: Math.min(100, penalizedScore),
            _hunter_tier: penalizedScore >= 70 ? "PRIORITY" : penalizedScore >= 50 ? "GOOD" : "WATCH",
            _hunter_reasons: reasons,
            _gmgn_risk: t._gmgn_risk || null,
            narrative_tags: [],
            hot_level: interval === "5m" ? 3 : 2,
            creator: null,
          });
        }
      };

      process(rank1h, "1h");
      process(rank5m, "5m");

      // Per-chain market intelligence. Count high-rug-ratio tokens as "rug
      // active" so a chain that looks hot by volume but is full of likely rugs
      // gets a score penalty (stops the hunter chasing rug farms).
      const rugActiveCount = chainTokens.filter(t => t._gmgn_risk?.rug_ratio > 0.7).length;
      try { recordChainSnapshot(chain, chainTokens, rugActiveCount); } catch {}
    } catch (e) {
      log("hunter_error", `GMGN trending hunt failed (${chain}): ${e.message}`);
    }
    perChain.set(chain, chainTokens);
  }

  return allocateAcrossChains(perChain, chains);
}

/**
 * Trim each chain's hunter contribution by its allocation weight so the hottest
 * chain keeps the most slots and dead chains contribute 0. The total slot
 * budget scales with how many tokens were actually found. Single-chain configs
 * (the default ["sol"]) pass through unchanged.
 */
function allocateAcrossChains(perChain, chains) {
  const all = [];
  for (const list of perChain.values()) all.push(...list);

  // No weighting needed for a single active chain — keep current behavior.
  if (chains.length <= 1 || all.length === 0) return all;

  const weights = getChainAllocationWeights(chains);
  const totalFound = all.length;

  const out = [];
  for (const chain of chains) {
    const list = (perChain.get(chain) || [])
      .slice()
      .sort((a, b) => (b._hunter_score || 0) - (a._hunter_score || 0));
    if (list.length === 0) continue;
    const w = weights[chain] ?? 0;
    if (w <= 0) continue; // dead chain → 0 slots
    // Keep at least 1 token from any alive chain so a quiet-but-alive chain
    // isn't fully starved by rounding.
    const cap = Math.max(1, Math.round(totalFound * w));
    out.push(...list.slice(0, cap));
  }
  return out.length > 0 ? out : all;
}

/**
 * Hunt GMGN trenches — new pump.fun launches and near-graduation tokens.
 * These are earlier signals than DexScreener; high risk but first-mover advantage.
 */
async function huntGmgnTrenches(strategy) {
  if (!isGmgnEnabled() || config.gmgn?.hunter === false) return [];
  // Per active chain. getTrenches() returns [] for EVM (no launchpad map yet),
  // so EVM contributes via signals only; sol contributes trenches + signals.
  const _disabledChainsTrenches = new Set(getChainOverrides().disable_chains);
  const chains = (Array.isArray(config.gmgn?.chains) && config.gmgn.chains.length > 0
    ? config.gmgn.chains : ["sol"]
  ).filter(c => !_disabledChainsTrenches.has(c));
  const seen = new Set();
  const tokens = [];

  for (const chain of chains) {
    try {
      const [signals, trenches] = await Promise.all([
        getTokenSignals(undefined, {}, chain),       // all supported signal types (1–13,17,18)
        getTrenches(["new_creation", "near_completion"], 30, chain),
      ]);

      const chainTag = chain !== "sol" ? [chain] : [];

      // getTrenches() returns a flat array, each item tagged with _trench_type.
      const trenchList = Array.isArray(trenches) ? trenches : [];

      for (const t of trenchList) {
        const mint = t.address || t.token_address || t.mint;
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);

        // Server bucket taxonomy: new_creation (early), pump (near-graduation —
        // server maps requested "near_completion" to "pump"), completed (graduated).
        // Near-graduated = more validated, lower rug risk → higher base score.
        const isNearGrad = t._trench_type === "completed" || t._trench_type === "pump";
        let score = isNearGrad ? 45 : 25;
        if (Number(t.holder_count ?? 0) >= 100) score += 15;
        if (Number(t.volume_24h ?? 0) >= 10_000) score += 10;
        if (Number(t.smart_degen_count ?? 0) >= 2) score += 15; // smart money in early

        const rowRisk = extractGmgnRowRisk(t);
        const [penalizedScore, riskReasons] = applyGmgnRiskPenalty(score, rowRisk);
        const reasons = [`trenches:${t._trench_type || "new"}`, ...chainTag, isNearGrad ? "near_graduation" : null, ...riskReasons].filter(Boolean);

        const trenchToken = {
          mint,
          chain,
          symbol: t.symbol || "?",
          name: t.name || t.symbol || "?",
          price: Number(t.price ?? 0),
          // trenches numeric fields arrive as strings — Number() coerces them.
          mcap: Number(t.usd_market_cap ?? t.market_cap ?? 0),
          liquidity: Number(t.liquidity ?? 0),
          volume: Number(t.volume_24h ?? t.volume_1h ?? 0),
          swaps: Number(t.swaps_24h ?? t.swaps_1h ?? 0),
          buys: 0, sells: 0,
          price_change_1h: 0, price_change_6h: 0, price_change_24h: 0,
          buy_vol: 0, sell_vol: 0,
          created_at: t.created_timestamp || null,
          pair_address: null,
          dex: "pump.fun",
          launchpad: t.launchpad || t.launchpad_platform || "pump.fun",
          _hunter_source: `gmgn_trenches_${t._trench_type || "new"}`,
          _hunter_score: Math.min(100, penalizedScore),
          _hunter_tier: (isNearGrad || penalizedScore >= 50) ? "GOOD" : "WATCH",
          _hunter_reasons: reasons,
          _gmgn_risk: rowRisk,
          narrative_tags: [],
          hot_level: isNearGrad ? 2 : 1,
          creator: t.creator || null,
        };
        tokens.push(trenchToken);
      }

      // NOTE: per-chain market-intel snapshots are recorded ONLY from
      // huntGmgnTrending() — its trending-rank rows carry real swap/volume
      // depth. Trench rows are early/low-liquidity by nature and would clobber
      // that signal with a near-always-DEAD reading. Allocation weighting is
      // applied to the final flat list below (grouped by token.chain).

      // Overlay smart money signals — bump scores for tokens that signal wallets are buying
      const signalList = Array.isArray(signals) ? signals
        : Array.isArray(signals?.tokens) ? signals.tokens : [];
      for (const s of signalList) {
        const mint = s.address || s.token_address || s.mint;
        if (!mint) continue;
        const existing = tokens.find(t => t.mint === mint);
        if (existing) {
          existing._hunter_score = Math.min(100, existing._hunter_score + 20);
          existing._hunter_reasons.push("gmgn_signal");
          existing.hot_level = Math.min(3, existing.hot_level + 1);
        } else if (!seen.has(mint)) {
          const sigLiquidity = Number(s.liquidity ?? 0);
          // P1-11: require non-zero liquidity before injecting signal-only tokens.
          // A GMGN signal with zero fundamentals was entering at hot_level:3/score:55
          // without going through the LP hard-block in trash-filter.
          if (sigLiquidity <= 0) continue;
          seen.add(mint);
          tokens.push({
            mint,
            chain,
            symbol: s.symbol || "?",
            name: s.name || s.symbol || "?",
            price: Number(s.price ?? 0),
            mcap: Number(s.market_cap ?? 0),
            liquidity: sigLiquidity,
            volume: Number(s.volume ?? 0),
            swaps: 0, buys: 0, sells: 0,
            price_change_1h: 0, price_change_6h: 0, price_change_24h: 0,
            buy_vol: 0, sell_vol: 0,
            created_at: null, pair_address: null,
            dex: "unknown", launchpad: "unknown",
            _hunter_source: "gmgn_signal",
            _hunter_score: 40, // reduced from 55 — signal-only needs enrichment
            _hunter_tier: "WATCH",
            _hunter_reasons: ["gmgn_smart_money_signal", ...chainTag],
            narrative_tags: [], hot_level: 2, creator: null, // tier WATCH not GOOD
          });
        }
      }
    } catch (e) {
      log("hunter_error", `GMGN trenches hunt failed (${chain}): ${e.message}`);
    }
  }

  // Allocation weighting: group the flat list by token.chain, then trim each
  // chain by its allocation weight (hottest chain keeps the most, dead = 0).
  const byChain = new Map();
  for (const t of tokens) {
    const c = t.chain || "sol";
    if (!byChain.has(c)) byChain.set(c, []);
    byChain.get(c).push(t);
  }
  return allocateAcrossChains(byChain, chains);
}

// Prey cache — stores latest hunt results for injection into screening
let _preyCache = [];
const PREY_TTL_MS = 10 * 60 * 1000; // 10 min TTL
let _preyCachedAt = null;

export function getHunterStats() {
  return { ..._hunterStats, running: _hunterRunning, cachedPrey: _preyCache.length };
}

export function getCachedPrey() {
  if (_preyCachedAt && (Date.now() - new Date(_preyCachedAt).getTime()) > PREY_TTL_MS) {
    _preyCache = [];
    _preyCachedAt = null;
  }
  return _preyCache;
}

// Allow external callers (e.g. trash-layer → screening-agent) to overwrite the
// cache with an already-filtered set so screening reads cleaned prey, not raw.
export function setCachedPrey(tokens) {
  _preyCache = Array.isArray(tokens) ? tokens : [];
  _preyCachedAt = new Date().toISOString();
}

/**
 * Run a hunting expedition. Called by the main loop on its own schedule.
 * Returns tokens sorted by hunter score (highest first).
 */
export async function runHunterExpedition({ strategy = null } = {}) {
  if (_hunterRunning) {
    log("hunter", "Previous expedition still in progress — skipping");
    return [];
  }

  _hunterRunning = true;
  const startTime = Date.now();

  try {
    // Clone so the caller's strategy object is never mutated.
    const strategyParams = { ...(strategy || {
      narratives: config.screening?.narrativeFilter || [],
    }) };

    // Auto-fill narratives from current hot narratives when the strategy
    // doesn't specify any — this is what makes the narrative_match scoring
    // bonus actually fire (no preset defines narratives).
    if (!Array.isArray(strategyParams.narratives) || strategyParams.narratives.length === 0) {
      const hot = getHotNarratives();
      if (hot.narratives.length > 0) {
        strategyParams.narratives = hot.narratives;
        log("hunter", `Strategy narratives auto-filled from heat: ${hot.narratives.join(",")}`);
      }
    }

    // Hunt across ALL sources in parallel — 9 pairs of eyes
    const [
      searchResults, pumpFunResults, gainerResults,
      newestResults, geckoResults, smartMoneyResults, jupiterResults,
      gmgnTrendingResults, gmgnTrenchesResults, letsBonkResults,
    ] = await Promise.allSettled([
      huntDexScreenerSearch(strategyParams),   // Eye 1: Multi-query search (45 keywords, 4/call)
      huntPumpFun(strategyParams),              // Eye 2: pump.fun ecosystem
      huntGainers(strategyParams),              // Eye 3: Top gainers (momentum, distinct queries)
      huntNewest(strategyParams),              // Eye 4: Newest launches
      huntGeckoTerminal(strategyParams),       // Eye 5: GeckoTerminal trending
      huntSmartMoney(strategyParams),          // Eye 6: Smart Money inflow (wallet ping)
      huntJupiter(strategyParams),             // Eye 7: Jupiter active pairs
      huntGmgnTrending(strategyParams),        // Eye 8: GMGN trending rank (1h + 5m)
      huntGmgnTrenches(strategyParams),        // Eye 9: GMGN trenches + smart money signals
      huntLetsBonk(strategyParams),            // Eye 10: LetsBonk.fun launchpad
    ]);

    const allTokens = [];
    const seenMints = new Set();

    const SKIP_SYMBOLS = new Set(["SOL", "USDC", "USDT", "WSOL"]);
    // mintIndex: mint → index in allTokens for fast dedup-by-score merging
    const mintIndex = new Map();
    const collectResults = (results, source) => {
      if (results.status !== "fulfilled" || !Array.isArray(results.value)) return 0;
      let added = 0;
      for (const token of results.value) {
        if (SKIP_SYMBOLS.has((token.symbol || "").toUpperCase())) continue;
        if (token.mint === SOL_MINT) continue;
        if (seenMints.has(token.mint)) {
          // P2-4: when same mint appears from a better source, keep the higher-score
          // record and union risk fields (_gmgn_risk, _rug_signals, etc.) so downstream
          // rug scoring never loses signals from a later, richer source.
          const idx = mintIndex.get(token.mint);
          if (idx !== undefined) {
            const existing = allTokens[idx];
            if ((token._hunter_score || 0) > (existing._hunter_score || 0)) {
              allTokens[idx] = { ...token, _hunter_score: token._hunter_score };
            }
            // Union risk metadata regardless of which record wins
            if (token._gmgn_risk) existing._gmgn_risk = { ...(existing._gmgn_risk || {}), ...token._gmgn_risk };
            if (token._rug_signals) existing._rug_signals = { ...(existing._rug_signals || {}), ...token._rug_signals };
          }
          continue;
        }
        seenMints.add(token.mint);
        mintIndex.set(token.mint, allTokens.length);
        allTokens.push(token);
        added++;
      }
      return added;
    };

    const searchAdded = collectResults(searchResults, "search");
    const pumpFunAdded = collectResults(pumpFunResults, "pumpfun");
    const gainerAdded = collectResults(gainerResults, "gainers");
    const newestAdded = collectResults(newestResults, "newest");
    const geckoAdded = collectResults(geckoResults, "geckoterminal");
    const smAdded = collectResults(smartMoneyResults, "smart_money");
    const jupiterAdded = collectResults(jupiterResults, "jupiter");
    const gmgnTrendAdded = collectResults(gmgnTrendingResults, "gmgn_trending");
    const gmgnTrenchAdded = collectResults(gmgnTrenchesResults, "gmgn_trenches");
    const letsBonkAdded = collectResults(letsBonkResults, "letsbonk");

    // Sort by hunter score descending, then by liquidity
    allTokens.sort((a, b) => {
      if (b._hunter_score !== a._hunter_score) return b._hunter_score - a._hunter_score;
      return (b.liquidity || 0) - (a.liquidity || 0);
    });

    const priorityTokens = allTokens.filter(t => t._hunter_score >= 50);
    const durationMs = Date.now() - startTime;

    _hunterStats.cycles++;
    _hunterStats.totalFound += allTokens.length;
    _hunterStats.priorityFound += priorityTokens.length;
    _hunterStats.lastRun = new Date().toISOString();
    _hunterStats.lastDurationMs = durationMs;

    // Update prey cache for screening cycle injection
    _preyCache = allTokens;
    _preyCachedAt = new Date().toISOString();

    log("hunter", [
      `Expedition #${_hunterStats.cycles}: ${allTokens.length} tokens`,
      `(src: ${searchAdded}s, ${pumpFunAdded}pf, ${gainerAdded}g, ${newestAdded}n, ${geckoAdded}gk, ${smAdded}sm, ${jupiterAdded}jp, ${gmgnTrendAdded}gt, ${gmgnTrenchAdded}gtr, ${letsBonkAdded}lb)`,
      `${priorityTokens.length} priority`,
      `${durationMs}ms`,
    ].join(" | "));

    if (priorityTokens.length > 0) {
      const top3 = priorityTokens.slice(0, 3)
        .map(t => `${t.symbol}(${t._hunter_score}:${t._hunter_tier})`)
        .join(", ");
      log("hunter", `Top prey: ${top3}`);
    }

    return allTokens;
  } catch (e) {
    _hunterStats.lastError = e.message;
    log("hunter_error", `Expedition failed: ${e.message}`);
    return [];
  } finally {
    _hunterRunning = false;
  }
}

/**
 * Inject hunter-found tokens into the screening pipeline.
 * Called at the start of each screening cycle.
 * Merges hunter prey with DexScreener discovery, deduplicating by mint.
 */
export function injectHunterPrey(screeningTokens, hunterTokens, maxInject = 15) {
  if (!Array.isArray(hunterTokens) || hunterTokens.length === 0) {
    return screeningTokens;
  }

  const existingMints = new Set(
    Array.isArray(screeningTokens) ? screeningTokens.map(t => t.mint).filter(Boolean) : []
  );

  // Take top-scored hunter tokens not already in the screening list
  const newPrey = hunterTokens
    .filter(t => t.mint && !existingMints.has(t.mint) && t._hunter_score >= 25)
    .slice(0, maxInject);

  if (newPrey.length === 0) return screeningTokens || [];

  log("hunter", `Injecting ${newPrey.length} hunter prey into screening pipeline`);

  return [...(Array.isArray(screeningTokens) ? screeningTokens : []), ...newPrey];
}

/**
 * Pick the deep-screen batch from trash-gate survivors by alternating discovery
 * tokens with pre-scored prey (_hunter_score >= 50: GOOD/PRIORITY tier).
 * Injected sources (GMGN trending/trenches, smart-money pings) are appended
 * AFTER discovery in the candidate list, so a plain slice(0, budget) starved
 * them out of rug scoring entirely — no _gmgn_risk token was ever evaluated.
 * Interleaving gives both sources slots without starving either.
 */
export function selectDeepScreenBatch(tokens, budget = 8) {
  if (!Array.isArray(tokens)) return [];
  if (tokens.length <= budget) return tokens;
  const prey = [];
  const discovery = [];
  for (const t of tokens) ((t._hunter_score ?? 0) >= 50 ? prey : discovery).push(t);
  const batch = [];
  for (let i = 0; batch.length < budget && (i < prey.length || i < discovery.length); i++) {
    if (i < discovery.length && batch.length < budget) batch.push(discovery[i]);
    if (i < prey.length && batch.length < budget) batch.push(prey[i]);
  }
  return batch;
}

/**
 * Get hunter token stats for dashboard.
 */
export function getHunterDashboard() {
  return {
    stats: { ..._hunterStats, running: _hunterRunning },
    queries: {
      total: HUNT_QUERIES.length,
      current: HUNT_QUERIES[_queryIdx % HUNT_QUERIES.length] || "none",
      list: [...HUNT_QUERIES],
    },
    thresholds: {
      minLiquidity: MIN_LIQUIDITY,
      minSwaps: MIN_SWAPS,
      minMcap: MIN_MCAP,
      maxAgeHours: MAX_TOKEN_AGE_HOURS,
      minAgeMinutes: MIN_TOKEN_AGE_MINUTES,
    },
  };
}
