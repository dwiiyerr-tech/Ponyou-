/**
 * Social Trash Gate — outermost filter for social signals.
 *
 * Every signal from Reddit, Discord, Telegram, or any social source
 * must pass this gate before being stored in social-signals.json and
 * used by the signal aggregator. Mirrors the philosophy of trash-layer.js
 * but tuned for social call analysis instead of on-chain metrics.
 *
 * Gate layers (in order):
 *   L1: Symbol sanity      — format, stablecoin block, length
 *   L2: Scam name patterns — multi-language, honeypot, unicode abuse
 *   L3: Shill pattern tax  — "100x guaranteed", "don't miss", etc.
 *   L4: Engagement floor   — minimum credibility per source
 *   L5: Source credibility — known shill channels get penalized
 *   L6: Spam / bot signals — excessive caps, flood posting, link spam
 *   L7: Age filter         — stale calls rejected
 *
 * Score: 0 = perfectly clean, 100 = definitely trash.
 * Tiers: PASS ≤ 30 | FLAG ≤ 50 | WARN ≤ 70 | BLOCK > 70
 */

// NOTE: we used to `import { log } from "./logger.js"` but that closed a
// cycle (logger → telegram → social-trash-gate → logger). To break it
// statically, we inline a minimal logger that matches logger.js's
// `[ISO] [CATEGORY] msg` line format. We lose the daily log-file writes
// for this module's lines, but stdout still captures them.
function log(category, message) {
  const ts = new Date().toISOString();
  const cat = String(category || "log").toUpperCase();
  console.log(`[${ts}] [${cat}] ${message}`);
}

// ─── Tier definitions ──────────────────────────────────────────

const TIERS = {
  PASS:  { threshold: 30,  action: "pass"  },
  FLAG:  { threshold: 50,  action: "flag"  },
  WARN:  { threshold: 70,  action: "warn"  },
  BLOCK: { threshold: 101, action: "block" },
};

function tierFor(score) {
  if (score <= TIERS.PASS.threshold)  return "PASS";
  if (score <= TIERS.FLAG.threshold)  return "FLAG";
  if (score <= TIERS.WARN.threshold)  return "WARN";
  return "BLOCK";
}

// ─── L1: Blocked symbols ───────────────────────────────────────

const STABLECOINS = new Set(["USDC", "USDT", "BUSD", "DAI", "FRAX", "TUSD", "USDH"]);
const LARGE_CAPS  = new Set(["SOL", "BTC", "ETH", "BNB", "WSOL", "WBTC", "WETH"]);

// ─── L2: Scam name patterns ────────────────────────────────────

const SCAM_PATTERNS = [
  // English scam/honeypot
  { re: /\b(scam|hack|rug|fake|phish|ponzi|honeypot|exploit)\b/i,    w: 12 },
  { re: /\b(test|testcoin|testtoken|devnet|testnet)\b/i,              w: 10 },
  // Zero-width / invisible chars
  { re: /[​-‍﻿­]/,                                w: 15 },
  // 4+ non-ASCII (likely unicode spoof)
  { re: /[^\x00-\x7F]{4,}/,                                           w: 8  },
  // Chinese / Korean / Russian scam keywords
  { re: /[一-鿿]{2,}|[가-힯]{2,}|[Ѐ-ӿ]{4,}/, w: 6 },
  // Pure gibberish: ALLCAPS 10+ chars with no vowels
  { re: /^[B-DF-HJ-NP-TV-Z]{10,}$/,                                  w: 7  },
  // coin*coin / token*token duplicates
  { re: /coin.?coin|token.?token|swap.?swap/i,                        w: 5  },
  // Copycat "2" suffix
  { re: /\d+\s*(coin|token|sol|inu|swap)$/i,                          w: 4  },
];

// ─── L3: Shill language patterns (reduce score, don't block alone) ─

const SHILL_PATTERNS = [
  { re: /\b(guaranteed|100%\s*safe|can't\s*miss|don't\s*miss)\b/i,   w: 8  },
  { re: /\b(ape\s*in|buy\s*now|last\s*chance|get\s*in\s*now)\b/i,    w: 8  },
  { re: /\b(\d{3,}x|moon(shot)?|lambo|to\s*the\s*moon)\b/i,          w: 6  },
  { re: /\b(easy\s*money|free\s*money|next\s*(bonk|wif|pepe))\b/i,   w: 7  },
  { re: /\b(call|alpha|gem|signal)\b.{0,20}(group|channel|dm\s*me)/i, w: 9  },
  { re: /t\.me\/|discord\.gg\//i,                                     w: 5  },
  // Excessive exclamation marks
  { re: /!{3,}/,                                                       w: 4  },
  // All caps long message (shouting = shill)
  { re: /^[A-Z\s\d!$]{40,}$/,                                         w: 5  },
];

// ─── L5: Known low-quality source names ───────────────────────

const SHILL_SUBREDDITS = new Set([
  "cryptomoonshots",   // high shill density but keep with penalty
  "satoshistreetbets",
  "shitcoinstreet",
]);

const QUALITY_SUBREDDITS = new Set([
  "solanatrading", "solanadefi", "solanamemes",
  "cryptocurrency", "cryptomarkets",
]);

// ─── Engagement floors by source ──────────────────────────────

const ENGAGEMENT_FLOORS = {
  reddit:      { score: 3,   comments: 0 },
  discord:     { reactions: 1 },
  telegram:    { views: 10,  forwards: 0 },
  nitter:      { likes: 3,   retweets: 0 },
  coingecko:   { rank: 15 },   // top-N in trending
  dexscreener: { txns: 5 },
};

// ─── Core gate function ────────────────────────────────────────

/**
 * @param {Object} signal
 * @param {string} signal.symbol        - token symbol e.g. "PEPE"
 * @param {string} [signal.name]        - token name
 * @param {string} signal.source        - "reddit"|"discord"|"telegram"|"nitter"|"coingecko"|"dexscreener"
 * @param {string} [signal.text]        - raw post/message content
 * @param {number} [signal.engagement]  - upvotes, reactions, likes, etc.
 * @param {number} [signal.score]       - reddit score, discord reactions, etc.
 * @param {number} [signal.comments]    - comment count
 * @param {number} [signal.views]       - view count (telegram)
 * @param {number} [signal.rank]        - position in trending list
 * @param {string} [signal.subreddit]   - subreddit name (reddit only)
 * @param {string} [signal.channel]     - channel name (discord/telegram)
 * @param {string} [signal.account]     - poster handle
 * @param {number} [signal.accountAge]  - account age in days
 * @param {number|string} [signal.postedAt] - ISO timestamp or unix ms
 * @returns {{ pass: boolean, tier: string, trashScore: number, flags: string[], reason: string|null }}
 */
export function gateSignal(signal = {}) {
  const flags   = [];
  let trashScore = 0;

  const sym     = (signal.symbol || "").toUpperCase().trim();
  const name    = (signal.name   || sym).toUpperCase().trim();
  const text    = (signal.text   || "").trim();
  const source  = (signal.source || "unknown").toLowerCase();

  // ── L1: Symbol sanity ──────────────────────────────────────
  if (!sym) {
    return _block("missing_symbol", 100, flags);
  }
  if (sym.length < 2 || sym.length > 20) {
    flags.push("symbol_length");
    trashScore += 15;
  }
  if (STABLECOINS.has(sym)) {
    return _block("stablecoin", 100, flags);
  }
  if (LARGE_CAPS.has(sym)) {
    return _block("large_cap", 80, flags);
  }

  // ── L2: Scam name patterns ─────────────────────────────────
  const nameAndText = `${sym} ${name} ${text}`;
  for (const { re, w } of SCAM_PATTERNS) {
    if (re.test(nameAndText)) {
      flags.push(`scam_pattern:${re.source.slice(0, 24)}`);
      trashScore += w;
    }
  }

  // ── L3: Shill language ────────────────────────────────────
  let shillScore = 0;
  for (const { re, w } of SHILL_PATTERNS) {
    if (re.test(text)) {
      flags.push(`shill:${re.source.slice(0, 24)}`);
      shillScore += w;
    }
  }
  // Shill language alone can't BLOCK but adds meaningful weight
  trashScore += Math.min(shillScore, 30);

  // ── L4: Engagement floor ──────────────────────────────────
  const floor   = ENGAGEMENT_FLOORS[source] || {};
  const eng     = signal.engagement || signal.score || signal.reactions || signal.likes || 0;
  const views   = signal.views   || 0;
  const rank    = signal.rank    || 999;
  const txns    = signal.txns    || 0;

  if (source === "reddit") {
    if (eng < floor.score) {
      flags.push("low_engagement_reddit");
      trashScore += 12;
    }
  } else if (source === "discord") {
    if (eng < floor.reactions) {
      flags.push("low_engagement_discord");
      trashScore += 8;
    }
  } else if (source === "telegram") {
    if (views < floor.views && (signal.forwards || 0) < 1) {
      flags.push("low_engagement_telegram");
      trashScore += 8;
    }
  } else if (source === "nitter") {
    if (eng < floor.likes) {
      flags.push("low_engagement_twitter");
      trashScore += 10;
    }
  } else if (source === "coingecko") {
    if (rank > floor.rank) {
      flags.push("low_coingecko_rank");
      trashScore += 5;
    }
  } else if (source === "dexscreener") {
    if (txns < floor.txns) {
      flags.push("low_dex_txns");
      trashScore += 5;
    }
  }

  // ── L5: Source credibility ────────────────────────────────
  const subreddit = (signal.subreddit || "").toLowerCase().replace(/^r\//, "");
  if (subreddit && SHILL_SUBREDDITS.has(subreddit)) {
    flags.push(`shill_subreddit:${subreddit}`);
    trashScore += 10;
  }
  if (subreddit && QUALITY_SUBREDDITS.has(subreddit)) {
    trashScore = Math.max(0, trashScore - 5); // credibility bonus
  }

  // ── L6: Spam / bot signals ────────────────────────────────
  if (signal.accountAge != null && signal.accountAge < 1) {
    flags.push("new_account");
    trashScore += 12;
  }
  if (text.length > 0 && text.length < 15 && source !== "coingecko" && source !== "dexscreener") {
    flags.push("very_short_post");
    trashScore += 6;
  }
  // Flood: same symbol from same channel more than 3× in signals cache
  // (checked externally — gate receives `signal.floodCount` if set)
  if ((signal.floodCount || 0) >= 3) {
    flags.push("flood_detected");
    trashScore += 15;
  }

  // ── L7: Age filter ────────────────────────────────────────
  if (signal.postedAt) {
    const ageMs = Date.now() - new Date(signal.postedAt).getTime();
    const ageH  = ageMs / 3_600_000;
    if (ageH > 24) {
      return _block("stale_call_24h", 80, flags);
    }
    if (ageH > 6) {
      flags.push("stale_call_6h");
      trashScore += 20;
    } else if (ageH > 2) {
      flags.push("aging_call_2h");
      trashScore += 8;
    }
  }

  // ── Final verdict ─────────────────────────────────────────
  const tier = tierFor(trashScore);

  if (tier === "BLOCK") {
    return _block(flags[0] || "trash_score_exceeded", trashScore, flags);
  }

  log("social_gate", `${sym} [${source}] tier=${tier} score=${trashScore} flags=${flags.join(",") || "none"}`);

  return {
    pass:       tier === "PASS" || tier === "FLAG",
    tier,
    trashScore,
    flags,
    reason:     flags.length ? flags.join(", ") : null,
  };
}

function _block(reason, score, flags) {
  return { pass: false, tier: "BLOCK", trashScore: score, flags, reason };
}

/**
 * Batch-gate a list of signals. Returns only signals that pass.
 * Attaches `.gate` result to each passing signal.
 */
export function gateBatch(signals = []) {
  const passed  = [];
  let   blocked = 0;

  for (const sig of signals) {
    const result = gateSignal(sig);
    if (result.pass) {
      passed.push({ ...sig, gate: result });
    } else {
      blocked++;
      log("social_gate_block",
        `BLOCK ${sig.symbol || "?"} [${sig.source}] reason=${result.reason} score=${result.trashScore}`
      );
    }
  }

  if (blocked > 0) {
    log("social_gate_summary", `Blocked ${blocked}/${signals.length} social signals`);
  }
  return passed;
}
