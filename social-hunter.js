/**
 * Social Hunter — multi-source hype signal scanner.
 *
 * Sources ($0 cost, no API keys required):
 *   1. Reddit JSON API      — r/solanatrading, r/cryptomoonshots, r/solanamemes
 *   2. CoinGecko Trending   — top-7 coins by search volume
 *   3. Dexscreener Hot      — new Solana pairs with momentum
 *   4. Nitter RSS           — Twitter mirror, optional (can be down)
 *
 * All candidates are filtered through social-trash-gate.js before storage.
 * Results are merged with Discord / Telegram signals (written by their own modules)
 * into social-signals.json every SCAN_INTERVAL_MS.
 *
 * Integration: signal-aggregator.js reads social-signals.json and adds
 * social_buzz as a scoring component.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { gateBatch } from "./social-trash-gate.js";
import { log } from "./logger.js";
import { withFileLock } from "./atomic-write.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = __dirname;

const SIGNALS_FILE   = resolve(ROOT, "social-signals.json");
const SCAN_INTERVAL  = 30 * 60 * 1000;   // 30 minutes
const SIGNAL_TTL     = 6  * 60 * 60 * 1000; // 6 hours — expire old signals

let _timer = null;
let _running = false;

// ─── Reddit subreddit config ───────────────────────────────────

const SUBREDDITS = [
  { name: "solanatrading",    limit: 25, sort: "new"  },
  { name: "solanamemes",      limit: 15, sort: "hot"  },
  { name: "cryptomoonshots",  limit: 20, sort: "hot"  },
  { name: "SolanaNFTs",       limit: 15, sort: "new"  },
  { name: "cryptocurrency",   limit: 20, sort: "hot"  },
];

// Regex to extract $SYMBOL or "TOKEN" mentions from post text
const SYMBOL_RE = /\$([A-Z]{2,12})\b|(?:^|\s)([A-Z]{3,10})(?:\s|$|\/)/g;

// ─── Fetch helpers ─────────────────────────────────────────────

async function fetchJSON(url, timeout = 8000, userAgent = null) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": userAgent || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─── Source 1: Reddit ─────────────────────────────────────────

// Reddit blocks anonymous JSON requests since 2024 — only enable if the operator
// provides a real User-Agent (typically "AppName/1.0 by u/username") via env.
const REDDIT_UA = process.env.REDDIT_USER_AGENT || "";
const REDDIT_ENABLED = !!REDDIT_UA;

async function scanReddit() {
  if (!REDDIT_ENABLED) return [];

  const signals = [];
  let blocked = false;

  for (const sub of SUBREDDITS) {
    if (blocked) break;
    try {
      // old.reddit.com is more permissive for anonymous JSON requests than www
      const url  = `https://old.reddit.com/r/${sub.name}/${sub.sort}.json?limit=${sub.limit}&t=day`;
      const data = await fetchJSON(url, 8000, REDDIT_UA);
      const posts = data?.data?.children || [];

      for (const { data: post } of posts) {
        const text  = `${post.title || ""} ${post.selftext || ""}`;
        const syms  = extractSymbols(text);

        for (const sym of syms) {
          signals.push({
            symbol:    sym,
            source:    "reddit",
            subreddit: sub.name,
            text:      `${post.title}`.slice(0, 200),
            engagement: post.score || 0,
            comments:  post.num_comments || 0,
            url:       `https://reddit.com${post.permalink}`,
            postedAt:  new Date(post.created_utc * 1000).toISOString(),
          });
        }
      }
    } catch (e) {
      // Reddit blocks anonymous JSON when rate-limited — bail early to avoid spam
      if (/HTTP 403|HTTP 429/.test(e.message)) {
        blocked = true;
        log("social_hunter_warn", `Reddit blocked (${e.message}) — skipping ${SUBREDDITS.length - signals.length} remaining subs`);
      } else {
        log("social_hunter_warn", `Reddit r/${sub.name} error: ${e.message}`);
      }
    }
  }

  return signals;
}

// ─── Source 2: CoinGecko trending ─────────────────────────────

async function scanCoinGecko() {
  try {
    const data = await fetchJSON("https://api.coingecko.com/api/v3/search/trending");
    const coins = data?.coins || [];

    return coins.map((item, idx) => ({
      symbol:    (item.item?.symbol || "?").toUpperCase(),
      name:      item.item?.name || "",
      source:    "coingecko",
      text:      `Trending on CoinGecko: ${item.item?.name}`,
      engagement: coins.length - idx,   // rank inverted as score
      rank:      idx + 1,
      postedAt:  new Date().toISOString(),
      market_cap_rank: item.item?.market_cap_rank || 9999,
    }));
  } catch (e) {
    log("social_hunter_warn", `CoinGecko trending error: ${e.message}`);
    return [];
  }
}

// ─── Source 3: Dexscreener hot Solana pairs ───────────────────

async function scanDexscreener() {
  try {
    const data = await fetchJSON(
      "https://api.dexscreener.com/latest/dex/search?q=solana",
      10000
    );
    const pairs = (data?.pairs || [])
      .filter(p => p.chainId === "solana" && p.priceChangeH1 > 20)
      .slice(0, 20);

    return pairs.map(p => ({
      symbol:    (p.baseToken?.symbol || "?").toUpperCase().slice(0, 12),
      name:      p.baseToken?.name || "",
      mint:      p.baseToken?.address || "",
      source:    "dexscreener",
      text:      `Hot pair: ${p.baseToken?.symbol} +${(p.priceChangeH1 || 0).toFixed(0)}% 1h`,
      engagement: Math.round((p.volume?.h1 || 0) / 100),
      txns:      (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0),
      priceChangeH1: p.priceChangeH1 || 0,
      liquidity: p.liquidity?.usd || 0,
      volume1h:  p.volume?.h1 || 0,
      postedAt:  new Date().toISOString(),
    }));
  } catch (e) {
    log("social_hunter_warn", `Dexscreener error: ${e.message}`);
    return [];
  }
}

// ─── Source 4: Nitter (Twitter mirror, optional) ──────────────

const NITTER_INSTANCES = [
  "nitter.privacydev.net",
  "nitter.poast.org",
];

const CRYPTO_QUERIES = [
  "solana+memecoin+gem",
  "%24SOL+buy+token",
  "solana+launch+buy",
];

async function scanNitter() {
  const signals = [];

  for (const instance of NITTER_INSTANCES) {
    for (const query of CRYPTO_QUERIES) {
      try {
        const url = `https://${instance}/search?f=tweets&q=${query}&lang=en`;
        const html = await fetchText(url, 6000);
        const parsed = parseNitterHTML(html, instance);
        signals.push(...parsed);
        if (parsed.length > 0) break; // got results from this instance
      } catch {
        // Nitter instance down — try next
      }
    }
    if (signals.length > 0) break;
  }

  return signals;
}

function parseNitterHTML(html, instance) {
  const signals = [];
  // Extract tweet text blocks
  const tweetBlocks = html.match(/<div class="tweet-content[^>]*>([\s\S]*?)<\/div>/gi) || [];

  for (const block of tweetBlocks.slice(0, 30)) {
    const text = block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const syms = extractSymbols(text);
    if (!syms.length) continue;

    // Extract stats
    const likes    = parseInt(html.match(/icon-heart[^>]*>.*?(\d+)/)?.[1] || "0");
    const retweets = parseInt(html.match(/icon-retweet[^>]*>.*?(\d+)/)?.[1] || "0");

    for (const sym of syms) {
      signals.push({
        symbol:    sym,
        source:    "nitter",
        text:      text.slice(0, 200),
        engagement: likes,
        likes,
        retweets,
        postedAt:  new Date().toISOString(),
      });
    }
  }
  return signals;
}

// ─── Symbol extractor ─────────────────────────────────────────

const IGNORE_WORDS = new Set([
  "THE", "AND", "FOR", "BUT", "NOT", "ALL", "GET", "PUT", "NEW", "NOW",
  "CAN", "USE", "BIG", "TOP", "HOT", "HIT", "LOW", "OUT", "OFF", "DID",
  "BUY", "APE", "GEM", "DEX", "NFT", "LFG", "ATH", "ATL", "USD", "TVL",
  "CEX", "OTC", "ROI", "PNL", "IRL", "AMA", "IDK", "IMO", "TBH",
  "FOMO", "HODL", "DYOR", "NGMI", "WAGMI", "IYKYK", "SOLANA", "CHAIN",
]);

function extractSymbols(text) {
  const found = new Set();
  let m;
  SYMBOL_RE.lastIndex = 0;

  while ((m = SYMBOL_RE.exec(text)) !== null) {
    const sym = (m[1] || m[2] || "").toUpperCase();
    if (sym.length >= 2 && sym.length <= 12 && !IGNORE_WORDS.has(sym)) {
      found.add(sym);
    }
  }
  return [...found];
}

// ─── Signal merge & dedup ─────────────────────────────────────

function mergeSignals(rawSignals) {
  const bySymbol = new Map();

  for (const sig of rawSignals) {
    const key = sig.symbol;
    if (!bySymbol.has(key)) {
      bySymbol.set(key, {
        symbol:    sig.symbol,
        mint:      sig.mint || null,
        mentions:  0,
        engagement: 0,
        sources:   [],
        firstSeen: sig.postedAt || new Date().toISOString(),
        lastSeen:  sig.postedAt || new Date().toISOString(),
        texts:     [],
        // gate fields — will be set after gating
        gate:      null,
      });
    }

    const entry = bySymbol.get(key);
    entry.mentions   += 1;
    entry.engagement += sig.engagement || 0;
    entry.sources.push(`${sig.source}:${sig.subreddit || sig.channel || ""}:${sig.engagement || 0}`);
    if (sig.postedAt && sig.postedAt > entry.lastSeen) entry.lastSeen = sig.postedAt;
    if (sig.mint && !entry.mint) entry.mint = sig.mint;
    if (sig.texts && sig.texts.length < 3) entry.texts.push(sig.text?.slice(0, 100) || "");
  }

  return [...bySymbol.values()].map(entry => ({
    ...entry,
    // flood detection: same signal from many sources can be fake hype
    floodCount: entry.sources.length,
    // use latest text for gate evaluation
    text:       entry.texts.join(" ").slice(0, 400),
    source:     entry.sources[0]?.split(":")?.[0] || "unknown",
  }));
}

// ─── Compute social score (0-100) ────────────────────────────

function computeSocialScore(signal) {
  const mentionScore    = Math.min(signal.mentions  * 8,  40);
  const engageScore     = Math.min(signal.engagement * 0.05, 30);
  const sourceScore     = Math.min(signal.sources.length * 5, 20);
  const gateBonus       = signal.gate?.tier === "PASS" ? 10 : 0;
  const shillPenalty    = (signal.gate?.trashScore || 0) * 0.3;

  return Math.max(0, Math.min(100, Math.round(
    mentionScore + engageScore + sourceScore + gateBonus - shillPenalty
  )));
}

// ─── Cache I/O ────────────────────────────────────────────────

function loadCache() {
  try {
    if (existsSync(SIGNALS_FILE)) {
      return JSON.parse(readFileSync(SIGNALS_FILE, "utf-8"));
    }
  } catch {}
  return { updatedAt: null, signals: [] };
}

// SH-1: lock the social-signals.json read-modify-write — three modules
// (this one, discord-listener.js, telegram.js handleCallMessage) all merge
// into the same cache file. Without coordination, concurrent runs clobber.
function saveCache(signals) {
  return withFileLock(SIGNALS_FILE, async () => {
    const now = new Date().toISOString();
    // Expire signals older than TTL
    const fresh = signals.filter(s => {
      if (!s.lastSeen) return true;
      return (Date.now() - new Date(s.lastSeen).getTime()) < SIGNAL_TTL;
    });

    // Merge with existing cache (Discord/Telegram signals live there too)
    const existing = loadCache();
    const existingExternal = (existing.signals || []).filter(
      s => s.source === "discord" || s.source === "telegram"
    );

    // Combine and dedup by symbol (prefer newer)
    const combined = new Map();
    for (const s of [...existingExternal, ...fresh]) {
      const prev = combined.get(s.symbol);
      if (!prev || s.lastSeen > prev.lastSeen) combined.set(s.symbol, s);
    }

    const payload = {
      updatedAt: now,
      signals:   [...combined.values()].sort((a, b) => (b.socialScore || 0) - (a.socialScore || 0)),
    };

    writeFileSync(SIGNALS_FILE, JSON.stringify(payload, null, 2));
    return payload;
  });
}

// ─── Main scan ────────────────────────────────────────────────

export async function runScan() {
  if (_running) return;
  _running = true;
  log("social_hunter", `Scan started — ${REDDIT_ENABLED ? "Reddit + " : ""}CoinGecko + Dexscreener + Nitter${REDDIT_ENABLED ? "" : " (Reddit disabled — set REDDIT_USER_AGENT to enable)"}`);

  try {
    const [reddit, cgecko, dex, nitter] = await Promise.allSettled([
      scanReddit(),
      scanCoinGecko(),
      scanDexscreener(),
      scanNitter(),
    ]);

    const raw = [
      ...(reddit.status  === "fulfilled" ? reddit.value  : []),
      ...(cgecko.status  === "fulfilled" ? cgecko.value  : []),
      ...(dex.status     === "fulfilled" ? dex.value     : []),
      ...(nitter.status  === "fulfilled" ? nitter.value  : []),
    ];

    log("social_hunter", `Fetched ${raw.length} raw signals from ${
      [reddit, cgecko, dex, nitter].filter(r => r.status === "fulfilled").length
    }/4 sources`);

    // Merge by symbol first, then gate the merged result
    const merged  = mergeSignals(raw);
    const gated   = gateBatch(merged);

    // Compute social score + tag _social_source for learning attribution
    const scored  = gated.map(sig => ({
      ...sig,
      socialScore: computeSocialScore(sig),
      _hunt_source: "social",
      _social_source: sig.source || "social",
    }));

    const result  = await saveCache(scored);

    log("social_hunter", `Scan done — ${scored.length} signals passed gate, saved to social-signals.json`);
    return result;

  } catch (e) {
    log("social_hunter_error", `Scan failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

// ─── Public API ───────────────────────────────────────────────

export function startHunter() {
  if (_timer) return;
  runScan(); // immediate first run
  _timer = setInterval(runScan, SCAN_INTERVAL);
  log("social_hunter", `Hunter started — scanning every ${SCAN_INTERVAL / 60000}min`);
}

export function stopHunter() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export function getSocialSignals(limit = 20) {
  const cache = loadCache();
  return (cache.signals || []).slice(0, limit);
}

export function getSocialScore(symbol) {
  if (!symbol) return 0;
  const cache = loadCache();
  const match = (cache.signals || []).find(
    s => s.symbol.toUpperCase() === symbol.toUpperCase()
  );
  return match?.socialScore || 0;
}
