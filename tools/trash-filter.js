/**
 * Pro-Grade Trash Filter — Ponyou's outermost shield.
 *
 * Multi-layer 0-100 scoring engine that replaces binary block/pass with
 * tiered decisions: ALLOW / FLAG / WARN / BLOCK.
 *
 * Scoring dimensions (weighted):
 *   1. Liquidity quality      — 25 pts  (LP depth, LP age, LP/token ratio)
 *   2. Supply integrity        — 20 pts  (circulating %, concentration signals)
 *   3. Age / velocity          — 15 pts  (new pair risk, holder ramp speed)
 *   4. Price action sanity     — 20 pts  (pump/dump probability, volatility)
 *   5. Name / symbol hygiene   — 10 pts  (unicode spam, mimicry, copycat)
 *   6. Volume / trade pattern  — 10 pts  (wash detection, dust, avg trade size)
 *
 * Market-condition multiplier adjusts thresholds per-regime.
 *
 * Layer 0 (outermost): RugCheck.xyz API — external risk verification
 * Layer 1-6: DexScreener-based scoring dimensions
 */

import { log } from "../logger.js";
import { rugCheckBatchScreen, getRugCheckReport } from "./rugcheck.js";

// ─── Constants ────────────────────────────────────────────────────

const MIN_LIQUIDITY_USD = 500;
const MIN_SWAPS = 1;
const MIN_MCAP_USD = 1000;
const MAX_PRICE_CHANGE_5M_PCT = 1500;
const MAX_SYMBOL_LENGTH = 16;

// P2-9: HIGH_RISK_LAUNCHPADS now matches all pump.fun dex variants from hunter-agent,
// not just the exact "pump.fun" string. DexScreener uses "pumpswap"/"pumpfun"/"pump".
import { PUMPFUN_DEXES } from "./hunter-agent.js";
const HIGH_RISK_LAUNCHPADS = new Set([...PUMPFUN_DEXES, "pump.fun"]);
const BLOCKED_LAUNCHPADS = new Set([]);

const BLOCKED_SYMBOLS_EXACT = new Set([
  "USDC", "USDT", "SOL", "BONK", "WIF",
]);

// P2-7: scam name patterns with leet-normalize and case-insensitive matching.
// Original patterns were case-sensitive and missed leet variants (RUGZ, T3ST, etc.)
const SCAM_NAME_KEYWORDS = ["test", "scam", "hack", "rug", "fake", "rugpull", "honeypot"];
const SCAM_NAME_PATTERNS = SCAM_NAME_KEYWORDS.map(w => new RegExp(`\\b${w}\\b`, "i"));

// ─── Tier definitions ──────────────────────────────────────────────

const TIERS = {
  ALLOW: { max: 25, label: "ALLOW", action: "pass" },
  FLAG:  { max: 50, label: "FLAG",  action: "flag" },
  WARN:  { max: 75, label: "WARN",  action: "warn" },
  BLOCK: { max: 101, label: "BLOCK", action: "block" },
};

function tierFor(score) {
  if (score <= TIERS.ALLOW.max) return TIERS.ALLOW;
  if (score <= TIERS.FLAG.max)  return TIERS.FLAG;
  if (score <= TIERS.WARN.max)  return TIERS.WARN;
  return TIERS.BLOCK;
}

// ─── Market-condition multipliers ──────────────────────────────────
// In DEAD markets, thresholds tighten (multiply score). In HOT, loosen.

const MARKET_MULTIPLIERS = {
  EXTREME: 1.30,
  HOT:     0.85,
  NORMAL:  1.00,
  COLD:    1.15,
  DEAD:    1.40,
};

// ─── Scoring dimension configs ─────────────────────────────────────

const SCORING = {
  liquidity:   { max: 25, weight: 1.0, label: "LP quality" },
  supply:      { max: 20, weight: 1.0, label: "supply integrity" },
  age:         { max: 15, weight: 1.0, label: "age/velocity" },
  priceAction: { max: 20, weight: 1.0, label: "price action" },
  nameHygiene: { max: 10, weight: 1.0, label: "name hygiene" },
  feeIntegrity: { max: 15, weight: 1.0, label: "fee integrity (wash detection)" },
  distribution: { max: 15, weight: 1.0, label: "distribution / boost-ad risk" },
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeAgeSeconds(createdAt) {
  if (!createdAt) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
}

function isUnicodeSpam(s) {
  if (!s) return false;
  const nonAscii = [...s].filter(c => c.charCodeAt(0) > 127).length;
  return nonAscii / s.length > 0.3;
}

function isAllCapsSpam(s) {
  if (!s || s.length < 20) return false;
  return s === s.toUpperCase() && /^[A-Z0-9_]+$/.test(s);
}

function isRepeatingChars(s) {
  if (!s || s.length < 4) return false;
  return new Set([...s]).size <= 2 && s.length >= 6;
}

function isFreshCopycat(symbol, recentRugs) {
  if (!symbol || !recentRugs?.length) return false;
  const upper = symbol.toUpperCase();
  return recentRugs.some(r => {
    const rugSym = (r.symbol || "").toUpperCase();
    if (rugSym === upper) return true;
    if (rugSym.length >= 3 && upper.startsWith(rugSym) && /^\d+$/.test(upper.slice(rugSym.length))) return true;
    return false;
  });
}

// ─── Dimension 1: Liquidity quality (0-25 pts) ────────────────────

function scoreLiquidity(token) {
  let score = 0;
  const reasons = [];
  const liq = Number(token.liquidity || 0);
  const mcap = Number(token.mcap || 0);

  // LP depth scoring curve
  if (liq >= 50000)       { /* 0 pts — deep LP */ }
  else if (liq >= 10000)  { score += 3;  reasons.push(`LP $${liq.toFixed(0)} < $10k`); }
  else if (liq >= 2000)   { score += 8;  reasons.push(`LP $${liq.toFixed(0)} < $2k`); }
  else if (liq >= 500)    { score += 15; reasons.push(`LP $${liq.toFixed(0)} < $500 — micro LP`); }
  else                     { score += 25; reasons.push(`LP $${liq.toFixed(0)} — dust`); return { score, reasons }; }

  // LP-to-mcap ratio: healthy projects have LP/MCAP > 5%
  if (mcap > 0 && liq > 0) {
    const lpRatio = liq / mcap;
    if (lpRatio < 0.02)       { score += 8;  reasons.push(`LP/MCAP ratio ${(lpRatio*100).toFixed(1)}% — rug-prone`); }
    else if (lpRatio < 0.05)  { score += 4;  reasons.push(`LP/MCAP ratio ${(lpRatio*100).toFixed(1)}% — low`); }
    else if (lpRatio > 0.80)  { score += 3;  reasons.push(`LP/MCAP ratio ${(lpRatio*100).toFixed(1)}% — over-collateralized, possible honeypot`); }
  }

  return { score: Math.min(25, score), reasons };
}

// ─── Dimension 2: Supply integrity (0-20 pts) ─────────────────────

function scoreSupply(token) {
  let score = 0;
  const reasons = [];
  const supply = Number(token.supply || 0);
  const mcap = Number(token.mcap || 0);

  if (!Number.isFinite(supply) || supply <= 0) {
    return { score: 20, reasons: ["supply data missing or zero"] };
  }

  // Derived price per token
  if (mcap > 0 && supply > 0) {
    const pricePerToken = mcap / supply;
    // Extremely tiny price = massive supply = likely dilution risk
    if (pricePerToken < 1e-9)        { score += 6; reasons.push("near-zero token price — massive supply dilution risk"); }
    else if (pricePerToken < 1e-7)   { score += 3; reasons.push("very low token price"); }
  }

  // Supply concentration signals (from DexScreener txns if available)
  const txns = token.txns || {};
  const h1Buys = Number(txns.h1?.buys || 0);
  const h1Sells = Number(txns.h1?.sells || 0);
  const h1Vol = Number(txns.h1?.volume || 0);

  // High volume with few buys = concentrated supply movement
  if (h1Buys > 0 && h1Vol > 0) {
    const avgBuySize = h1Vol / h1Buys;
    if (avgBuySize > 10000)  { score += 5; reasons.push("whale-sized avg buy — supply concentration"); }
    else if (avgBuySize > 5000) { score += 3; reasons.push("large avg buy size"); }
  }

  // Extreme buy/sell imbalance signals supply manipulation
  const h1Total = h1Buys + h1Sells;
  if (h1Total > 20) {
    const buyPct = h1Buys / h1Total;
    if (buyPct > 0.90)  { score += 6; reasons.push(`${(buyPct*100).toFixed(0)}% buys — likely self-buying`); }
    if (buyPct < 0.15)  { score += 8; reasons.push(`${((1-buyPct)*100).toFixed(0)}% sells — dumping`); }
  }

  return { score: Math.min(20, score), reasons };
}

// ─── Dimension 3: Age / velocity (0-15 pts) ───────────────────────

function scoreAge(token) {
  let score = 0;
  const reasons = [];
  const ageSec = computeAgeSeconds(token.created_at);

  if (ageSec === null) {
    score += 5;
    reasons.push("no creation timestamp — unknown age");
  } else if (ageSec < 30) {
    score += 15;
    reasons.push(`${ageSec}s old — insufficient data`);
  } else if (ageSec < 120) {
    score += 12;
    reasons.push(`${ageSec}s old — very young`);
  } else if (ageSec < 300) {
    score += 8;
    reasons.push(`${Math.floor(ageSec/60)}min old — unproven`);
  } else if (ageSec < 900) {
    score += 5;
    reasons.push(`${Math.floor(ageSec/60)}min old — caution`);
  } else if (ageSec < 3600) {
    score += 2;
    reasons.push(`<1h old`);
  }

  // Holder velocity proxy: high swap count on very new token = sniper fest
  const swaps = Number(token.swaps || 0);
  if (ageSec !== null && ageSec > 0 && ageSec < 3600) {
    const swapsPerMin = swaps / (ageSec / 60);
    if (swapsPerMin > 30)       { score += 5; reasons.push(`${swapsPerMin.toFixed(0)} swaps/min — sniper frenzy`); }
    else if (swapsPerMin > 15)  { score += 3; reasons.push(`${swapsPerMin.toFixed(0)} swaps/min — elevated velocity`); }
  }

  return { score: Math.min(15, score), reasons };
}

// ─── Dimension 4: Price action sanity (0-20 pts) ──────────────────

function scorePriceAction(token) {
  let score = 0;
  const reasons = [];
  const p5m = Number(token.price_change_5m || 0);
  const p1h = Number(token.price_change_1h || 0);
  const p6h = Number(token.price_change_6h || 0);

  // 5-minute change
  if (Math.abs(p5m) > 1500)    { score += 20; reasons.push(`${p5m.toFixed(0)}% 5m — already gone`); return { score, reasons }; }
  else if (p5m > 800)           { score += 14; reasons.push(`${p5m.toFixed(0)}% 5m pump — extremely late`); }
  else if (p5m > 500)           { score += 10; reasons.push(`${p5m.toFixed(0)}% 5m pump — late entry risk`); }
  else if (p5m > 200)           { score += 6;  reasons.push(`${p5m.toFixed(0)}% 5m pump`); }
  else if (p5m > 100)           { score += 3;  reasons.push(`${p5m.toFixed(0)}% 5m — momentum`); }
  else if (p5m < -60)           { score += 12; reasons.push(`${p5m.toFixed(0)}% 5m dump — collapsing`); }
  else if (p5m < -30)           { score += 7;  reasons.push(`${p5m.toFixed(0)}% 5m drop`); }

  // 1h vs 5m divergence: 5m pumping but 1h dumping = exit liquidity trap
  if (p5m > 100 && p1h < -30)   { score += 8; reasons.push("5m↑ 1h↓ — exit liquidity trap"); }
  if (p5m < -30 && p1h > 50)    { score += 5; reasons.push("5m↓ 1h↑ — may be dip, not dump"); }

  // 6h context: if 6h > 200% and 5m > 100%, this is sustained pump (good)
  // but if 6h > 500% and 5m < 0, this is post-pump dump (dangerous)
  if (p6h > 500 && p5m < 0)     { score += 8; reasons.push("post-hyperpump correction"); }

  return { score: Math.min(20, score), reasons };
}

// ─── Dimension 5: Name / symbol hygiene (0-10 pts) ────────────────

function scoreNameHygiene(token, recentRugs) {
  let score = 0;
  const reasons = [];
  const symbol = token.symbol || "";
  const name = token.name || "";

  // Hard blocks upgraded to very high score (handled in hardBlocks layer)
  if (BLOCKED_SYMBOLS_EXACT.has(symbol.toUpperCase())) {
    return { score: 10, reasons: [`mimic symbol: ${symbol}`] };
  }
  if (isUnicodeSpam(symbol)) {
    return { score: 10, reasons: ["unicode spam symbol"] };
  }
  if (isAllCapsSpam(symbol)) {
    return { score: 10, reasons: ["all-caps spam symbol"] };
  }
  if (isRepeatingChars(symbol)) {
    return { score: 10, reasons: ["repeating chars symbol"] };
  }

  for (const pat of SCAM_NAME_PATTERNS) {
    if (pat.test(name) || pat.test(symbol)) {
      // Hard-block: scam pattern in name/symbol is nearly always a rug
      // Downgraded from scoring-only in v2.0.1 back to hard-block
      return { score: 10, block: true, blockReason: `scam_name: ${pat.source}`, reasons: [`scam pattern in name/symbol: ${pat.source}`] };
    }
  }

  if (symbol && symbol.length > MAX_SYMBOL_LENGTH) {
    score += 3;
    reasons.push("overlong symbol");
  }

  if (isFreshCopycat(symbol, recentRugs)) {
    score += 7;
    reasons.push("fresh copycat of recently rugged token");
  }

  // Symbol is all numbers = lazy deployer
  if (/^\d+$/.test(symbol)) {
    score += 5;
    reasons.push("numeric-only symbol");
  }

  // Symbol contains URL-like patterns
  if (/https?:\/\//i.test(symbol) || /\.com\b/i.test(symbol) || /\.io\b/i.test(symbol)) {
    score += 5;
    reasons.push("URL-like symbol");
  }

  return { score: Math.min(10, score), reasons };
}

// ─── Dimension 6: Fee integrity / Volume pattern (0-15 pts) ──────
//
// Uses LP fee economics to detect fake volume. The 0.25% LP fee on
// every DEX swap is a cryptographic receipt — you can't fake fees
// paid to liquidity pools without actually spending SOL.
//
// Key insight: volume-to-fee ratio reveals wash trading:
//   Organic:     avg trade $10-500, expected fees ≈ 0.25% of volume
//   Wash trade:  avg trade < $1, swap/vol ratio > 0.05
//   Bot pump:    few giant trades, swap/vol ratio < 0.001

function scoreVolume(token) {
  let score = 0;
  const reasons = [];
  const swaps = Number(token.swaps || 0);
  const vol = Number(token.volume || 0);
  const mcap = Number(token.mcap || 0);

  if (swaps > 0 && vol > 0) {
    const avgTrade = vol / swaps;
    const swapVolRatio = swaps / Math.max(vol, 1);

    // ─── LP Fee Economics ──────────────────────────
    // Expected LP fees = volume * 0.0025
    // If avg trade < $4, LP fee < $0.01 per trade — economically irrational
    const expectedFee = avgTrade * 0.0025;
    const totalExpectedFees = vol * 0.0025;

    if (expectedFee < 0.001) {
      score += 12;
      reasons.push(`avg fee $${expectedFee.toFixed(4)}/trade — dust, impossible to be organic`);
    } else if (expectedFee < 0.01) {
      score += 7;
      reasons.push(`avg fee $${expectedFee.toFixed(3)}/trade — likely wash`);
    } else if (expectedFee < 0.05) {
      score += 3;
      reasons.push(`avg fee $${expectedFee.toFixed(2)}/trade — low LP compensation`);
    }

    // ─── Wash trade: swap storm with tiny volume ────
    if (swapVolRatio > 0.1) {
      score += 10;
      reasons.push(`${swaps} swaps / $${vol.toFixed(0)} vol — swap storm (${swapVolRatio.toFixed(3)}), wash`);
    } else if (swapVolRatio > 0.05) {
      score += 6;
      reasons.push(`high swap/vol ratio ${swapVolRatio.toFixed(3)} — suspicious`);
    } else if (swapVolRatio > 0.02) {
      score += 2;
      reasons.push(`elevated swap/vol ratio ${swapVolRatio.toFixed(3)}`);
    }

    // ─── Bot pump: few giant trades ────────────────
    if (swapVolRatio < 0.0005 && swaps < 10 && vol > 50000) {
      score += 10;
      reasons.push(`${swaps} swaps for $${(vol/1000).toFixed(0)}k vol — bot pump signature`);
    }

    // ─── Avg trade size sanity ─────────────────────
    if (avgTrade > 500000) {
      score += 10; reasons.push(`avg trade $${(avgTrade/1000).toFixed(0)}k — whale manipulation`);
    } else if (avgTrade > 100000) {
      score += 6; reasons.push(`avg trade $${(avgTrade/1000).toFixed(0)}k — suspicious`);
    } else if (avgTrade < 0.5) {
      score += 6; reasons.push(`avg trade $${avgTrade.toFixed(2)} — dust`);
    }

    // ─── Total fee sanity check ────────────────────
    // $100k volume should generate ~$250 in LP fees
    // If total expected fees < $1 on high volume, it's wash
    if (vol > 50000 && totalExpectedFees < 1) {
      score += 8;
      reasons.push(`$${(vol/1000).toFixed(0)}k vol but only $${totalExpectedFees.toFixed(2)} expected fees — wash`);
    }
  }

  // Volume-to-mcap ratio
  if (vol > 0 && mcap > 0) {
    const volRatio = vol / mcap;
    if (volRatio > 10) {
      score += 8; reasons.push(`volume ${volRatio.toFixed(0)}x MCAP — manufactured`);
    } else if (volRatio > 5) {
      score += 5; reasons.push(`volume ${volRatio.toFixed(0)}x MCAP — suspicious`);
    } else if (volRatio > 2) {
      score += 2; reasons.push(`volume ${volRatio.toFixed(0)}x MCAP — elevated`);
    }
  }

  return { score: Math.min(15, score), reasons };
}

// ─── Dimension 7: Distribution / Boost-Ad Risk (0-15 pts) ───────
//
// Key insight from on-chain pattern analysis:
//   Boost/Ads BEFORE pump + organic community = dev committed long-term
//   Boost/Ads AFTER pump (>300%) + whale concentration = DISTRIBUTION TRAP
//
// When a token pumps hard and THEN suddenly appears in paid promotions,
// it's devs/whales using visibility to attract exit liquidity. They dump
// once enough new buyers enter at the top.

function scoreDistribution(token) {
  let score = 0;
  const reasons = [];
  const priceChange1h = Number(token.price_change_1h || 0);
  const priceChange5m = Number(token.price_change_5m || 0);
  const swaps = Number(token.swaps || 0);
  const mcap = Number(token.mcap || 0);
  const ageSec = computeAgeSeconds(token.created_at);

  // ─── Pattern 1: Pump + bounce pattern (classic distribution) ─
  // Token pumped 300%+ then dropped 20%+ = whales distributing
  if (priceChange1h > 300 && priceChange5m < -20) {
    score += 12;
    reasons.push(`+${priceChange1h.toFixed(0)}% 1h then ${priceChange5m.toFixed(0)}% 5m — pump & dump distribution`);
  } else if (priceChange1h > 200 && priceChange5m < -10) {
    score += 8;
    reasons.push(`+${priceChange1h.toFixed(0)}% 1h then dropping — likely distribution phase`);
  } else if (priceChange1h > 500) {
    // Extreme pump — regardless of current direction, late entry risk
    score += 6;
    reasons.push(`+${priceChange1h.toFixed(0)}% 1h — extreme pump, likely late`);
  }

  // ─── Pattern 2: Boost/Ads visibility spike ────────────────
  // DexScreener "boosts" field indicates paid promotion
  if (token.boosts && token.boosts > 0) {
    if (priceChange1h > 100) {
      // Boost + pump = distribution signal
      score += 10;
      reasons.push(`${token.boosts}x Boost AFTER +${priceChange1h.toFixed(0)}% pump — distribution signal`);
    } else if (ageSec !== null && ageSec < 600 && priceChange1h < 50) {
      // P2-8: do NOT reduce score for boost — boost is an attacker-controllable
      // signal (cheap to buy) and a negative risk contribution is flippable.
      // Changed from -3 to 0 (neutral, no penalty but no reward).
      reasons.push("Boost di awal launch (diabaikan — tidak menurunkan risk score)");
    }
  }

  // ─── Pattern 3: High holder growth + falling price ─────────
  const txns = token.txns || {};
  const h1Buys = Number(txns.h1?.buys || 0);
  const h1Sells = Number(txns.h1?.sells || 0);

  if (h1Buys > 50 && priceChange1h < -30) {
    // Many buyers but price falling = whales selling into buy pressure
    score += 10;
    reasons.push(`${h1Buys} buys but price ${priceChange1h.toFixed(0)}% — whales distributing into buyers`);
  }

  if (h1Sells > h1Buys * 3 && h1Buys > 10) {
    // 3x more sells than buys = clear distribution
    score += 8;
    reasons.push(`${h1Sells} sells vs ${h1Buys} buys — heavy distribution`);
  }

  // ─── Pattern 4: MCAP / swap ratio → distribution check ─────
  // Large MCAP with few swaps = low organic interest after pump
  if (mcap > 500000 && swaps < 50 && priceChange1h > 200) {
    score += 8;
    reasons.push(`$${(mcap/1000).toFixed(0)}k MCAP, ${swaps} swaps — low organic, pump may be engineered`);
  }

  // ─── Pattern 5: Fresh copycat after pump ────────────────────
  if (priceChange1h > 200 && ageSec !== null && ageSec < 1800 && swaps < 100) {
    score += 5;
    reasons.push("Fresh token, extreme pump, low swaps — classic rug setup");
  }

  return { score: Math.min(15, score), reasons };
}

// ─── Hard-block gates (pre-scoring, instant rejection) ────────────

function checkHardBlocks(token, rugMemory) {
  if (!token?.mint) return { block: true, reason: "missing_mint" };

  const liq = Number(token.liquidity || 0);
  if (liq < MIN_LIQUIDITY_USD)
    return { block: true, reason: `dust_liquidity: $${liq.toFixed(0)} < $${MIN_LIQUIDITY_USD}` };

  const swaps = Number(token.swaps || 0);
  if (swaps < MIN_SWAPS)
    return { block: true, reason: "zero_swaps" };

  const mcap = Number(token.mcap || 0);
  if (mcap > 0 && mcap < MIN_MCAP_USD)
    return { block: true, reason: `dust_mcap: $${mcap.toFixed(0)} < $${MIN_MCAP_USD}` };

  // Supply check: only hard-block when supply is *explicitly* invalid
  // (provided as 0/NaN/negative). When the source signal didn't carry a
  // supply field at all (CoinGecko, social hunters, on-chain new-pool
  // detections), let the token through this layer — downstream layers
  // (Token-2022 extension check, RugCheck, Helius) will enrich and re-gate.
  // Without this, every signal without pre-fetched supply was rejected
  // (see audit log: BLOCKED 1/1 across legitimate tokens like JLP/USDG/WETH).
  const hasSupplyField = token.supply !== undefined && token.supply !== null;
  if (hasSupplyField) {
    const supply = Number(token.supply);
    if (!Number.isFinite(supply) || supply <= 0)
      return { block: true, reason: "supply_invalid" };
  }

  const launchpad = token.launchpad || "unknown";
  if (BLOCKED_LAUNCHPADS.has(launchpad))
    return { block: true, reason: `blocked_launchpad: ${launchpad}` };

  const ageSec = computeAgeSeconds(token.created_at);
  if (ageSec !== null && ageSec < 30)
    return { block: true, reason: `too_young: ${ageSec}s` };

  const p5m = Math.abs(Number(token.price_change_5m || 0));
  if (p5m > MAX_PRICE_CHANGE_5M_PCT)
    return { block: true, reason: `pumped_5m: ${p5m.toFixed(0)}%` };

  if (rugMemory) {
    if (token.mint && rugMemory.blacklisted_tokens?.includes(token.mint))
      return { block: true, reason: "blacklisted_token" };
    if (token.creator && rugMemory.blacklisted_devs?.includes(token.creator))
      return { block: true, reason: "blacklisted_dev" };
  }

  return { block: false };
}

// ─── Main scoring function ─────────────────────────────────────────

/**
 * @param {Object} token   — Raw DexScreener token object
 * @param {Object} ctx
 * @param {string} ctx.marketCondition — EXTREME|HOT|NORMAL|COLD|DEAD
 * @param {Object} ctx.rugMemory       — rug-memory.json content
 * @param {Array}  ctx.recentRugs      — last N rug entries
 * @returns {{
 *   block: boolean,
 *   score: number,
 *   tier: string,
 *   tierAction: string,
 *   flags: string[],
 *   reasons: string[],
 *   breakdown: Object,
 *   marketMultiplier: number,
 * }}
 */
export function scoreTrash(token, ctx = {}) {
  const { marketCondition = "NORMAL", rugMemory, recentRugs } = ctx;

  // Hard blocks first — instant rejection
  const hard = checkHardBlocks(token, rugMemory);
  if (hard.block) {
    return {
      block: true,
      score: 100,
      tier: "BLOCK",
      tierAction: "block",
      flags: [],
      reasons: [hard.reason],
      breakdown: { hardBlock: hard.reason },
      marketMultiplier: 1,
    };
  }

  // Run all scoring dimensions
  const dims = {
    liquidity:   scoreLiquidity(token),
    supply:      scoreSupply(token),
    age:         scoreAge(token),
    priceAction: scorePriceAction(token),
    nameHygiene: scoreNameHygiene(token, recentRugs),
    feeIntegrity: scoreVolume(token),
    distribution: scoreDistribution(token),
  };

  // Check if any dimension signals a hard-block
  for (const [name, dim] of Object.entries(dims)) {
    if (dim.block) {
      return {
        block: true,
        score: 100,
        tier: "BLOCK",
        tierAction: "block",
        flags: [],
        reasons: [dim.blockReason || dim.reasons[0] || `${name}: blocked`],
        breakdown: { [name]: { score: dim.score, max: SCORING[name]?.max || 0, reasons: dim.reasons, blocked: true } },
        marketMultiplier: 1,
      };
    }
  }

  // Raw score = sum of dimension scores (each already clamped to its max)
  let rawScore = 0;
  const allReasons = [];
  const breakdown = {};
  for (const [name, dim] of Object.entries(dims)) {
    rawScore += dim.score;
    breakdown[name] = { score: dim.score, max: SCORING[name]?.max || 0, reasons: dim.reasons };
    allReasons.push(...dim.reasons);
  }

  // Apply market condition multiplier
  const marketMult = MARKET_MULTIPLIERS[marketCondition] || 1.0;
  const finalScore = clamp(Math.round(rawScore * marketMult), 0, 100);

  // Determine tier
  const tier = tierFor(finalScore);

  // Collect flags for downstream scoring
  const flags = [];
  const launchpad = token.launchpad || "";
  if (HIGH_RISK_LAUNCHPADS.has(launchpad)) flags.push(`high_risk_launchpad:${launchpad}`);

  const ageSec = computeAgeSeconds(token.created_at);
  if (ageSec !== null && ageSec < 120) flags.push("very_young");

  const p5m = Number(token.price_change_5m || 0);
  if (p5m > 500)  flags.push("already_pumping");
  if (p5m < -60)  flags.push("dumping_hard");

  const mcap = Number(token.mcap || 0);
  if (!Number.isFinite(mcap) || mcap <= 0) flags.push("mcap_zero_or_nan");

  const txns = token.txns || {};
  const h1Buys = Number(txns.h1?.buys || 0);
  const h1Sells = Number(txns.h1?.sells || 0);
  const h1Total = h1Buys + h1Sells;
  if (h1Total >= 5 && h1Total <= 30 && h1Buys / Math.max(h1Sells, 1) > 9) flags.push("suspicious_buy_pattern");
  if (h1Sells > h1Buys * 4 && h1Total > 10) flags.push("heavy_selling");

  const swaps = Number(token.swaps || 0);
  const vol = Number(token.volume || 0);
  if (swaps > 0 && vol > 0) {
    const avgTrade = vol / swaps;
    if (avgTrade > 500000) flags.push("suspicious_avg_trade_size");
    if (avgTrade < 0.01)   flags.push("dust_trading");
  }

  if (token.symbol && token.symbol.length > MAX_SYMBOL_LENGTH) flags.push("long_symbol");
  if (isFreshCopycat(token.symbol, recentRugs)) flags.push("fresh_copycat");

  return {
    block: tier.action === "block",
    score: finalScore,
    tier: tier.label,
    tierAction: tier.action,
    flags,
    reasons: allReasons,
    breakdown,
    marketMultiplier: marketMult,
  };
}

// ─── Batch scoring ─────────────────────────────────────────────────

/**
 * Score a batch of tokens and partition by tier.
 * Returns enriched tokens with `_trash_score` and `_trash_flags` attached.
 */
export function scoreBatch(tokens, ctx = {}) {
  const tiers = { ALLOW: [], FLAG: [], WARN: [], BLOCK: [] };
  const stats = { total: tokens.length, passed: 0, flagged: 0, warned: 0, blocked: 0 };
  const flagCounts = {};
  const reasonCounts = {};

  for (const token of tokens) {
    const result = scoreTrash(token, ctx);

    // Track stats
    for (const flag of result.flags) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
    for (const r of result.reasons) {
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }

    if (result.block) {
      stats.blocked++;
      tiers.BLOCK.push({ ...token, _trash_score: result.score, _trash_tier: result.tier, _trash_reasons: result.reasons });
    } else {
      const enriched = { ...token, _trash_score: result.score, _trash_flags: result.flags, _trash_tier: result.tier, _trash_reasons: result.reasons };
      if (result.tier === "WARN")  { stats.warned++;  tiers.WARN.push(enriched); }
      else if (result.tier === "FLAG") { stats.flagged++; tiers.FLAG.push(enriched); }
      else { stats.passed++; tiers.ALLOW.push(enriched); }
    }
  }

  // Logging
  if (stats.blocked > 0) {
    const blockedSamples = tiers.BLOCK.slice(0, 5).map(t => `${t.symbol || t.mint?.slice(0, 6)}(${t._trash_reasons?.[0] || "?"})`).join(", ");
    const suffix = tiers.BLOCK.length > 5 ? ` +${tiers.BLOCK.length - 5} more` : "";
    log("trash_filter", `BLOCKED ${stats.blocked}/${stats.total}: ${blockedSamples}${suffix}`);
  }
  if (stats.warned > 0) {
    const warnedSamples = tiers.WARN.slice(0, 5)
      .map(t => `${t.symbol || t.mint?.slice(0, 6)}(${t._trash_flags?.[0] || t._trash_reasons?.[0] || `score:${t._trash_score}`})`).join(", ");
    const warnSuffix = tiers.WARN.length > 5 ? ` +${tiers.WARN.length - 5} more` : "";
    log("trash_filter", `WARNED ${stats.warned}/${stats.total}: ${warnedSamples}${warnSuffix}`);
  }

  return {
    passed: tiers.ALLOW,
    flagged: tiers.FLAG,
    warned: tiers.WARN,
    blocked: tiers.BLOCK,
    stats: {
      ...stats,
      topFlags: Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
      topReasons: Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    },
  };
}

// ─── Layer 0: RugCheck.xyz integration (outermost shield) ──────

const RUGC_HARD_BLOCK_SCORE = 60;
const RUGC_CRITICAL_BLOCK = 1;
const RUGC_DIMENSION_MAX = 25;

// ─── Token-2022 Extension Check ────────────────────────────────
// Token-2022 adds program-level features that can be abused:
//   Freeze Authority    → deployer can freeze your holdings → BLOCK
//   Mint Authority      → deployer can mint unlimited supply → WARN
//   Transfer Hook       → contract can block transfers → BLOCK
//   Permanent Delegate  → can confiscate tokens → BLOCK
//   Transfer Fee >10%   → extraction tax → BLOCK
// RugCheck.xyz detects these for free in the full report.

function checkTokenExtensions(rugReport) {
  if (!rugReport?.indexed) return { block: false, score: 0, reasons: [] };

  const reasons = [];
  let score = 0;
  let block = false;

  // Freeze Authority — instant block
  if (rugReport.freeze_authority) {
    block = true;
    reasons.push(`Freeze Authority AKTIF — token bisa dibekukan kapan saja`);
  }

  // Mint Authority — heavy penalty (dilution risk)
  if (rugReport.mint_authority) {
    score += 15;
    reasons.push(`Mint Authority AKTIF — supply bisa ditambah tanpa batas (dilution)`);
  }

  // Permanent Delegate — instant block
  for (const risk of (rugReport.risks || [])) {
    const name = (risk.name || "").toLowerCase();
    const desc = (risk.description || "").toLowerCase();

    if (name.includes("permanent_delegate") || desc.includes("permanent delegate")) {
      block = true;
      reasons.push("Permanent Delegate — bisa sita token dari wallet manapun");
    }
    if (name.includes("transfer_hook") || desc.includes("transfer hook")) {
      block = true;
      reasons.push("Transfer Hook — kontrak bisa blokir transfer (honeypot)");
    }
    if (name.includes("non_transferable") || desc.includes("non-transferable") || desc.includes("soulbound")) {
      block = true;
      reasons.push("Token non-transferable — tidak bisa dijual");
    }
    if ((name.includes("transfer_fee") || desc.includes("transfer fee")) && (risk.level === "critical" || risk.level === "danger")) {
      block = true;
      reasons.push(`Transfer Fee tinggi: ${desc.slice(0, 80)}`);
    }
    if (name.includes("default_frozen") || desc.includes("default frozen")) {
      score += 10;
      reasons.push("Default frozen — perlu unfreeze manual untuk transfer");
    }
    if ((name.includes("transfer_fee") || desc.includes("transfer fee")) && risk.level === "warn") {
      score += 8;
      reasons.push(`Transfer Fee moderat: ${desc.slice(0, 60)}`);
    }
  }

  // Unverified metadata
  if (rugReport.verified === false) {
    score += 3;
    reasons.push("Metadata tidak terverifikasi oleh RugCheck");
  }

  return { block, score: Math.min(25, score), reasons };
}

/**
 * Score a single token's rugcheck result → trash-filter points.
 * Called by the combined pre-screener.
 */
function scoreRugCheck(rugResult) {
  if (!rugResult?.indexed) return { score: 0, reasons: [] };

  let score = 0;
  const reasons = [];

  if (rugResult.critical > 0) {
    score += 25;
    reasons.push(`RugCheck: ${rugResult.critical} critical risk(s)`);
  } else if (rugResult.score >= 60) {
    score += 20;
    reasons.push(`RugCheck score ${rugResult.score}/100 — high risk`);
  } else if (rugResult.score >= 40) {
    score += 12;
    reasons.push(`RugCheck score ${rugResult.score}/100 — moderate risk`);
  } else if (rugResult.score >= 20) {
    score += 6;
    reasons.push(`RugCheck score ${rugResult.score}/100 — caution`);
  } else if (rugResult.score > 0) {
    score += 2;
    reasons.push(`RugCheck score ${rugResult.score}/100 — low risk`);
  }

  if (rugResult.risks >= 5) {
    score += 8;
    reasons.push(`RugCheck: ${rugResult.risks} total risk factors`);
  }

  return { score: Math.min(RUGC_DIMENSION_MAX, score), reasons };
}

// ─── Combined pre-screener (RugCheck + Trash scoring) ───────────

/**
 * Outer shield: RugCheck summary → instant block → fall through to trash scoring.
 *
 * Flow:
 *   1. Batch RugCheck summary on all token mints (parallel, capped)
 *   2. Hard-block tokens with critical RugCheck risks or score >= 60
 *   3. Token-2022 extension check (freeze/mint authority, transfer hook, etc)
 *   4. Run standard 6-dimension trash scoring on survivors
 *   5. Add RugCheck + extension dimensions to overall score
 *   6. Return tiered partition
 *
 * @param {Array} tokens — raw DexScreener tokens
 * @param {Object} ctx   — { marketCondition, rugMemory, recentRugs }
 */
export async function outerShieldScreen(tokens, ctx = {}) {
  const { marketCondition = "NORMAL", rugMemory, recentRugs } = ctx;

  // Step 1: RugCheck batch (outermost layer)
  const rugResults = await rugCheckBatchScreen(tokens);

  // Step 2: First pass — hard-block via RugCheck summary
  const survivors = [];
  const rugBlocked = [];
  for (const token of tokens) {
    const rug = rugResults.get(token.mint);
    if (!rug) {
      survivors.push(token);
      continue;
    }

    if (rug.critical >= RUGC_CRITICAL_BLOCK || rug.score >= RUGC_HARD_BLOCK_SCORE) {
      rugBlocked.push({
        mint: token.mint,
        symbol: token.symbol,
        reason: rug.critical > 0
          ? `rugcheck_critical: ${rug.critical} critical risks, score ${rug.score}`
          : `rugcheck_score: ${rug.score}/100`,
        _trash_score: 100,
        _trash_tier: "BLOCK",
        _trash_reasons: [rug.critical > 0 ? `${rug.critical} critical RugCheck risks` : `RugCheck score ${rug.score}`],
      });
    } else {
      survivors.push({ ...token, _rugcheck: rug });
    }
  }

  if (rugBlocked.length > 0) {
    const samples = rugBlocked.slice(0, 5).map(b => `${b.symbol}(${b.reason})`).join(", ");
    log("trash_filter", `RugCheck BLOCKED ${rugBlocked.length}: ${samples}`);
  }

  // Step 3: Token-2022 Extension Check on survivors via RugCheck reports
  // Fetch full reports in parallel for indexed tokens to check freeze/mint authority
  const extBlocked = [];
  const extensionReports = new Map();
  if (survivors.length > 0) {
    const indexedTokens = survivors.filter(t => t._rugcheck?.indexed);
    if (indexedTokens.length > 0) {
      const reports = await Promise.all(
        indexedTokens.map(async (t) => {
          const report = await getRugCheckReport(t.mint);
          return { mint: t.mint, symbol: t.symbol, report };
        })
      );
      for (const { mint, symbol, report } of reports) {
        extensionReports.set(mint, report);
        const ext = checkTokenExtensions(report);
        if (ext.block) {
          extBlocked.push({
            mint, symbol,
            reason: `token_ext: ${ext.reasons[0]}`,
            _trash_score: 100,
            _trash_tier: "BLOCK",
            _trash_reasons: ext.reasons,
          });
        }
        // Attach extension score to the token's rugcheck metadata
        const survivor = survivors.find(s => s.mint === mint);
        if (survivor && !ext.block) {
          survivor._rugext = ext;
        }
      }
    }

    // Remove extension-blocked tokens from survivors
    if (extBlocked.length > 0) {
      const blockedMints = new Set(extBlocked.map(b => b.mint));
      for (let i = survivors.length - 1; i >= 0; i--) {
        if (blockedMints.has(survivors[i].mint)) survivors.splice(i, 1);
      }
      const samples = extBlocked.slice(0, 5).map(b => `${b.symbol}(${b.reason})`).join(", ");
      log("trash_filter", `Token-2022 Ext BLOCKED ${extBlocked.length}: ${samples}`);
    }
  }

  // Step 3: Standard trash scoring on survivors
  const tiers = { ALLOW: [], FLAG: [], WARN: [], BLOCK: [] };
  const stats = { total: tokens.length, passed: 0, flagged: 0, warned: 0, blocked: rugBlocked.length, rugBlocked: rugBlocked.length };

  for (const token of survivors) {
    const result = scoreTrash(token, { marketCondition, rugMemory, recentRugs });

    // Step 4: Add RugCheck dimension if available
    let finalScore = result.score;
    if (token._rugcheck?.indexed) {
      const rugDim = scoreRugCheck(token._rugcheck);
      finalScore = clamp(Math.round(finalScore + rugDim.score), 0, 100);
      result.breakdown.rugcheck = { score: rugDim.score, max: RUGC_DIMENSION_MAX, reasons: rugDim.reasons };
      result.reasons.unshift(...rugDim.reasons);
      result._rugcheck_score = token._rugcheck.score;
    }

    // Recompute tier with rugcheck boost
    const tier = tierFor(finalScore);
    result.score = finalScore;
    result.tier = tier.label;
    result.tierAction = tier.action;
    result.block = tier.action === "block";

    if (result.block) {
      stats.blocked++;
      tiers.BLOCK.push({ ...token, _trash_score: finalScore, _trash_tier: tier.label, _trash_reasons: result.reasons });
    } else {
      const enriched = { ...token, _trash_score: finalScore, _trash_flags: result.flags, _trash_tier: tier.label, _trash_reasons: result.reasons };
      if (tier.label === "WARN")  { stats.warned++;  tiers.WARN.push(enriched); }
      else if (tier.label === "FLAG") { stats.flagged++; tiers.FLAG.push(enriched); }
      else { stats.passed++; tiers.ALLOW.push(enriched); }
    }
  }

  // Log summary
  if (stats.blocked > 0) {
    const blockedSamples = tiers.BLOCK.slice(0, 3).map(t => `${t.symbol || t.mint?.slice(0, 6)}(${t._trash_reasons?.[0] || "?"})`).join(", ");
    log("trash_filter", `FINAL: ${stats.blocked}/${stats.total} BLOCKED (${stats.rugBlocked} via RugCheck)${blockedSamples ? ` — ${blockedSamples}` : ""}`);
  }
  if (stats.warned > 0) {
    const warnedSamples2 = tiers.WARN.slice(0, 5)
      .map(t => `${t.symbol || t.mint?.slice(0, 6)}(${t._trash_flags?.[0] || t._trash_reasons?.[0] || `score:${t._trash_score}`})`).join(", ");
    const warnSuffix2 = tiers.WARN.length > 5 ? ` +${tiers.WARN.length - 5} more` : "";
    log("trash_filter", `WARNED ${stats.warned} tokens: ${warnedSamples2}${warnSuffix2}`);
  }
  if (stats.passed > 0 || stats.flagged > 0) log("trash_filter", `PASSED ${stats.passed + stats.flagged}/${stats.total} — ${stats.passed} clean, ${stats.flagged} flagged`);

  return {
    passed: tiers.ALLOW,
    flagged: tiers.FLAG,
    warned: tiers.WARN,
    blocked: tiers.BLOCK,
    stats: {
      ...stats,
      rugBlocked: rugBlocked.length,
    },
  };
}

// ─── Backward-compatible wrapper ───────────────────────────────────
// preScreenTrash and preScreenBatch remain for existing callers in
// index.js. They delegate to the new scoring engine internally.

/**
 * @deprecated Use scoreTrash() for tiered decisions.
 */
export function preScreenTrash(token, opts = {}) {
  const result = scoreTrash(token, {
    marketCondition: opts.marketCondition || "NORMAL",
    rugMemory: opts.rugMemory,
    recentRugs: opts.recentRugs,
  });
  return {
    block: result.block,
    reason: result.block ? result.reasons[0] || "blocked_by_score" : null,
    flags: result.flags,
  };
}

/**
 * @deprecated Use scoreBatch() for tiered partitioning.
 */
export function preScreenBatch(tokens, opts = {}) {
  const result = scoreBatch(tokens, {
    marketCondition: opts.marketCondition || "NORMAL",
    rugMemory: opts.rugMemory,
    recentRugs: opts.recentRugs,
  });

  // Merge ALLOW + FLAG + WARN into one "passed" array for backward compat
  const passed = [...result.passed, ...result.flagged, ...result.warned];
  for (const p of passed) {
    // Preserve _trash_flags for downstream (rug-risk scoring reads this)
    if (!p._trash_flags) p._trash_flags = [];
    if (!p._trash_score) p._trash_score = 0;
  }

  return {
    passed,
    blocked: result.blocked.map(b => ({ mint: b.mint, symbol: b.symbol, reason: b._trash_reasons?.[0] || "blocked" })),
    stats: {
      total: result.stats.total,
      passed: passed.length,
      blocked: result.stats.blocked,
      flagged: [],
    },
  };
}

// ─── Analytics export ──────────────────────────────────────────────
// Callers can use this for dashboard / health-report rendering.

export function getTrashFilterStats() {
  return {
    version: "2.0.0-pro",
    tiers: TIERS,
    marketMultipliers: MARKET_MULTIPLIERS,
    scoringDimensions: SCORING,
    hardGates: {
      minLiquidity: MIN_LIQUIDITY_USD,
      minSwaps: MIN_SWAPS,
      minMcap: MIN_MCAP_USD,
      maxPriceChange5m: MAX_PRICE_CHANGE_5M_PCT,
    },
  };
}

export { MIN_LIQUIDITY_USD, HIGH_RISK_LAUNCHPADS, BLOCKED_LAUNCHPADS, TIERS, MARKET_MULTIPLIERS };
