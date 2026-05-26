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

// ─── Hunting Sources ────────────────────────────────────────────

const DS_BASE = "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_QUOTE = "https://quote-api.jup.ag/v6";
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

// pump.fun DEX identifiers on DexScreener
const PUMPFUN_DEXES = ["pumpswap", "pump.fun", "pumpfun", "pump", "pump swap"];
// Raydium — where tokens migrate after pump.fun graduation
const RAYDIUM_DEXES = ["raydium", "raydium clmm", "raydium cpmm"];
// All Solana DEXes we care about
const SOLANA_DEXES = [...PUMPFUN_DEXES, ...RAYDIUM_DEXES, "orca", "meteora", "whirlpool"];

// ─── Scoring Constants ──────────────────────────────────────────

const MIN_LIQUIDITY = 500;
const MIN_SWAPS = 5;        // Higher bar than discovery pre-filter
const MIN_MCAP = 5000;
const MAX_TOKEN_AGE_HOURS = 168; // 7 days — don't hunt ancient tokens
const MIN_TOKEN_AGE_MINUTES = 5; // 5 min — skip fresh-launch snipes

// ─── HTTP Helpers ───────────────────────────────────────────────

async function fetchDS(url, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (i < retries) { await new Promise(r => setTimeout(r, 500 * (i + 1))); continue; }
        return null;
      }
      return await res.json();
    } catch { if (i >= retries) return null; }
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

  // Strategy narrative match bonus (max 5)
  const strategyNarratives = strategy?.narratives || [];
  const narrativeMatch = strategyNarratives.some(n =>
    (token.name || "").toLowerCase().includes(n) ||
    (token.symbol || "").toLowerCase().includes(n)
  );
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
async function huntDexScreenerSearch(strategy) {
  const query = HUNT_QUERIES[_queryIdx % HUNT_QUERIES.length];
  _queryIdx++;

  try {
    const data = await fetchDS(`${DS_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!data?.pairs) return [];

    const solPairs = data.pairs.filter(p => p.chainId === "solana");
    const tokens = [];
    const seen = new Set();

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
 * Hunt DexScreener gainers — tokens with highest price increases.
 * Timeframes: 1h, 6h, 24h. These are tokens with real momentum.
 */
async function huntGainers(strategy) {
  try {
    const results = await Promise.allSettled([
      fetchDS(`${DS_BASE}/latest/dex/search?q=sol`),     // broad search
      fetchDS(`${DS_BASE}/latest/dex/search?q=meme`),    // meme search
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
        if (token.swaps < MIN_SWAPS * 3) continue; // gainers need real volume

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
      const mint = pool.relationships?.base_token?.data?.id
        || attrs.address
        || null;
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
        mcap: 0,
        liquidity: 0,
        volume: 0,
        swaps: 0,
        buys: smToken.buy_count || 0,
        sells: smToken.sell_count || 0,
        price_change_1h: 0,
        price_change_6h: 0,
        price_change_24h: 0,
        buy_vol: 0,
        sell_vol: 0,
        created_at: null,
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
    const res = await fetch(`${JUPITER_QUOTE}/tokens`);
    if (!res.ok) return [];
    const jupTokens = await res.json();
    if (!Array.isArray(jupTokens) || jupTokens.length === 0) return [];

    // Get top tokens by some heuristic, fetch pair data
    const solTokens = jupTokens.slice(0, 50);
    const mintStr = solTokens.map(t => t.address).slice(0, 25).join(",");
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
    const strategyParams = strategy || {
      narratives: config.screening?.narrativeFilter || [],
    };

    // Hunt across ALL sources in parallel — 7 pairs of eyes
    const [
      searchResults, pumpFunResults, gainerResults,
      newestResults, geckoResults, smartMoneyResults, jupiterResults,
    ] = await Promise.allSettled([
      huntDexScreenerSearch(strategyParams),   // Eye 1: Multi-query search (45 keywords)
      huntPumpFun(strategyParams),              // Eye 2: pump.fun ecosystem
      huntGainers(strategyParams),              // Eye 3: Top gainers (momentum)
      huntNewest(strategyParams),              // Eye 4: Newest launches
      huntGeckoTerminal(strategyParams),       // Eye 5: GeckoTerminal trending
      huntSmartMoney(strategyParams),          // Eye 6: Smart Money inflow (wallet ping)
      huntJupiter(strategyParams),             // Eye 7: Jupiter active pairs
    ]);

    const allTokens = [];
    const seenMints = new Set();

    const SKIP_SYMBOLS = new Set(["SOL", "USDC", "USDT", "WSOL"]);
    const collectResults = (results, source) => {
      if (results.status !== "fulfilled" || !Array.isArray(results.value)) return 0;
      let added = 0;
      for (const token of results.value) {
        if (seenMints.has(token.mint)) continue;
        if (SKIP_SYMBOLS.has((token.symbol || "").toUpperCase())) continue;
        if (token.mint === SOL_MINT) continue;
        seenMints.add(token.mint);
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
      `(src: ${searchAdded}s, ${pumpFunAdded}pf, ${gainerAdded}g, ${newestAdded}n, ${geckoAdded}gk, ${smAdded}sm, ${jupiterAdded}jp)`,
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
