/**
 * Community & Developer Detector for Ponyou
 *
 * Four detection subsystems:
 *
 * 1. DEV REPUTATION — track developer wallet history across multiple coins.
 *    A dev who has launched 5+ coins with 0 rugs gets a credibility score.
 *    A dev with rug history gets permanently flagged.
 *
 * 2. COMMUNITY TAKEOVER (CTO) — detect when a dev abandons a coin and
 *    the community takes over. Signs: dev sold all tokens, yet social
 *    activity & holder count are increasing, new wallets accumulating.
 *
 * 3. MIGRATION DETECTION — detect coins migrating between platforms
 *    (PumpFun → Raydium, DEX → CEX listing, chain migration).
 *
 * 4. ACTIVE COMMUNITY QUALITY — measure community health via holder
 *    distribution, social velocity, organic growth patterns.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_REPUTATION_FILE = path.join(__dirname, "..", "dev-reputation.json");
const CTO_DETECTIONS_FILE = path.join(__dirname, "..", "cto-detections.json");

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════
// 1. DEV REPUTATION SCORING
// ═══════════════════════════════════════════════════════════════

function loadDevReputation() {
  if (!fs.existsSync(DEV_REPUTATION_FILE)) return { devs: {} };
  try {
    return JSON.parse(fs.readFileSync(DEV_REPUTATION_FILE, "utf8"));
  } catch {
    return { devs: {} };
  }
}

function saveDevReputation(data) {
  atomicWriteJson(DEV_REPUTATION_FILE, data);
}

/**
 * Score a developer based on their launch history.
 *
 * Scoring factors:
 *   + coins_launched (quantity) → capped at 20
 *   + success_rate (coins that didn't rug / are still trading)
 *   + avg_coin_longevity_hours (how long their coins live)
 *   + community_growth_rate (avg holder growth across launches)
 *   - rug_count (instant penalty)
 *   - dump_count (dev sold >50% within 24h)
 *   - abandoned_count (dev sold all, no further activity)
 *
 * Returns { score: 0-100, tier: "ELITE"|"TRUSTED"|"NEUTRAL"|"SUSPECT"|"RUGGER", ... }
 */
export function scoreDevReputation({
  creatorWallet,
  tokenMint = null,
  tokenSymbol = null,
  launchPlatform = null,
  holderCount = null,
  ageMinutes = null,
  devBalanceChangePct = null,
} = {}) {
  if (!creatorWallet) return { score: 50, tier: "NEUTRAL", reason: "No creator wallet provided" };

  const store = loadDevReputation();
  let dev = store.devs[creatorWallet];

  if (!dev) {
    dev = {
      creator: creatorWallet,
      first_seen_at: nowIso(),
      coins_launched: 0,
      coins_active: 0,
      coins_rugged: 0,
      coins_abandoned: 0,
      total_holder_count: 0,
      total_longevity_hours: 0,
      launches: [],
      tier: "NEUTRAL",
      score: 50,
    };
  }

  // Update with new observation — dedupe by mint to avoid recounting
  if (tokenMint && !dev.launches.some(l => l.mint === tokenMint)) {
    dev.coins_launched += 1;
    dev.launches.push({
      mint: tokenMint,
      symbol: tokenSymbol || null,
      platform: launchPlatform || null,
      first_seen: nowIso(),
      holder_count_snapshot: holderCount || 0,
      age_minutes_snapshot: ageMinutes || 0,
    });
    // Cap history
    if (dev.launches.length > 100) dev.launches = dev.launches.slice(-100);
  }

  // Calculate reputation score
  const totalLaunches = dev.coins_launched || 1;
  const activeCount = Math.max(0, (dev.coins_active || 0));
  const rugCount = dev.coins_rugged || 0;
  const abandonedCount = dev.coins_abandoned || 0;
  const badCount = rugCount + abandonedCount;

  // Base score from success rate
  const successRate = Math.max(0, (totalLaunches - badCount) / totalLaunches);
  let score = successRate * 60; // base: 0-60 from success rate

  // Quantity bonus: more launches = more data points (capped at +15)
  const quantityBonus = Math.min(15, totalLaunches * 0.75);
  score += quantityBonus;

  // Longevity bonus: coins that stay alive (capped at +15)
  const avgLongevity = totalLaunches > 0 ? (dev.total_longevity_hours || 0) / totalLaunches : 0;
  const longevityBonus = Math.min(15, avgLongevity / 24); // 1 point per 24h avg, max 15
  score += longevityBonus;

  // Penalties
  score -= rugCount * 20;        // each rug = -20
  score -= abandonedCount * 8;   // each abandonment = -8

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Tier assignment
  let tier;
  if (score >= 80 && totalLaunches >= 5 && rugCount === 0) tier = "ELITE";
  else if (score >= 65 && rugCount === 0) tier = "TRUSTED";
  else if (score >= 40 && rugCount <= 1) tier = "NEUTRAL";
  else if (rugCount >= 2) tier = "RUGGER";
  else tier = "SUSPECT";

  dev.score = score;
  dev.tier = tier;
  dev.last_updated_at = nowIso();
  store.devs[creatorWallet] = dev;
  saveDevReputation(store);

  return {
    creator: creatorWallet,
    score,
    tier,
    total_launches: totalLaunches,
    active_coins: activeCount,
    rugs: rugCount,
    abandoned: abandonedCount,
    success_rate: (successRate * 100).toFixed(0) + "%",
    avg_longevity_hours: avgLongevity.toFixed(1),
    reason: buildDevReason(dev),
    credibility: tier === "ELITE" ? "HIGH" : tier === "TRUSTED" ? "MEDIUM" : tier === "RUGGER" ? "ZERO" : "LOW",
  };
}

function buildDevReason(dev) {
  const parts = [];
  if (dev.tier === "ELITE") parts.push(`${dev.coins_launched} launches, 0 rugs — proven track record`);
  else if (dev.tier === "TRUSTED") parts.push(`${dev.coins_launched} launches, clean history`);
  else if (dev.tier === "SUSPECT") parts.push(`rugs: ${dev.coins_rugged}, caution advised`);
  else if (dev.tier === "RUGGER") parts.push(`${dev.coins_rugged} rugs — HIGH RISK`);
  else parts.push(`limited history (${dev.coins_launched} launches)`);
  return parts.join("; ");
}

/**
 * Mark a dev's coin as rugged or abandoned. Called when a rug is detected.
 */
export function markDevCoinOutcome({ creatorWallet, mint, outcome, longevityHours = 0 }) {
  if (!creatorWallet || !mint) return null;
  const store = loadDevReputation();
  let dev = store.devs[creatorWallet];
  if (!dev) {
    dev = {
      creator: creatorWallet,
      first_seen_at: nowIso(),
      coins_launched: 0,
      coins_active: 0,
      coins_rugged: 0,
      coins_abandoned: 0,
      total_holder_count: 0,
      total_longevity_hours: 0,
      launches: [],
      tier: "NEUTRAL",
      score: 50,
    };
  }

  if (outcome === "rug") dev.coins_rugged += 1;
  else if (outcome === "abandoned") dev.coins_abandoned += 1;
  else if (outcome === "active") dev.coins_active += 1;

  dev.total_longevity_hours += (longevityHours || 0);
  dev.last_updated_at = nowIso();

  // Recalculate score and tier
  const totalLaunches = Math.max(1, dev.coins_launched || dev.launches.length);
  const badCount = (dev.coins_rugged || 0) + (dev.coins_abandoned || 0);
  const successRate = Math.max(0, (totalLaunches - badCount) / totalLaunches);
  let score = Math.round(successRate * 60 + Math.min(15, totalLaunches * 0.75) + Math.min(15, dev.total_longevity_hours / totalLaunches / 24));
  score = Math.max(0, Math.min(100, score - (dev.coins_rugged || 0) * 20 - (dev.coins_abandoned || 0) * 8));
  dev.score = score;
  dev.tier = score >= 80 && totalLaunches >= 5 && (dev.coins_rugged || 0) === 0 ? "ELITE"
    : score >= 65 && (dev.coins_rugged || 0) === 0 ? "TRUSTED"
    : score >= 40 && (dev.coins_rugged || 0) <= 1 ? "NEUTRAL"
    : (dev.coins_rugged || 0) >= 2 ? "RUGGER"
    : "SUSPECT";

  store.devs[creatorWallet] = dev;
  saveDevReputation(store);
  return dev;
}

export function getDevReputation(creatorWallet) {
  if (!creatorWallet) return null;
  const store = loadDevReputation();
  const dev = store.devs[creatorWallet];
  if (!dev) return { creator: creatorWallet, score: 50, tier: "NEUTRAL", reason: "Unknown developer" };
  return {
    creator: creatorWallet,
    score: dev.score,
    tier: dev.tier,
    total_launches: dev.coins_launched || 0,
    rugs: dev.coins_rugged || 0,
    success_rate: dev.coins_launched > 0
      ? ((dev.coins_launched - (dev.coins_rugged || 0) - (dev.coins_abandoned || 0)) / dev.coins_launched * 100).toFixed(0) + "%"
      : "N/A",
  };
}

// ═══════════════════════════════════════════════════════════════
// 2. COMMUNITY TAKEOVER (CTO) DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Detect if a coin has been taken over by the community after dev abandoned it.
 *
 * CTO signals:
 *   1. Dev wallet sold ALL tokens (balance = 0 or near 0)
 *   2. Holder count is INCREASING (new people buying in)
 *   3. Top 10 holders concentration DECREASING (distributing wider)
 *   4. Social velocity INCREASING (community building)
 *   5. Price recovering or stable (not in freefall)
 *
 * Returns { is_cto: boolean, confidence: 0-100, phase: string, signals: [] }
 */
export function detectCommunityTakeover({
  tokenMint,
  tokenSymbol = null,
  devWallet = null,
  devBalance = null,
  devInitialBalance = null,
  holderCount = null,
  holderCount24hAgo = null,
  top10Concentration = null,
  top10Concentration24hAgo = null,
  priceUsd = null,
  price24hAgo = null,
  volume24h = null,
  socialVelocity = null,
  ageHours = null,
} = {}) {
  const signals = [];
  let score = 0;

  // Signal 1: Dev dumped
  if (devWallet && devInitialBalance != null && devBalance != null) {
    const devSoldPct = devInitialBalance > 0
      ? ((devInitialBalance - devBalance) / devInitialBalance) * 100
      : 0;
    if (devSoldPct >= 95) {
      signals.push({ signal: "dev_fully_exited", strength: "STRONG", detail: `Dev sold ${devSoldPct.toFixed(0)}%` });
      score += 30;
    } else if (devSoldPct >= 70) {
      signals.push({ signal: "dev_mostly_exited", strength: "MEDIUM", detail: `Dev sold ${devSoldPct.toFixed(0)}%` });
      score += 15;
    }
  }

  // Signal 2: Holder count growing (community buying in)
  if (holderCount != null && holderCount24hAgo != null && holderCount24hAgo > 0) {
    const holderGrowth = ((holderCount - holderCount24hAgo) / holderCount24hAgo) * 100;
    if (holderGrowth >= 10) {
      signals.push({ signal: "holders_growing_fast", strength: "STRONG", detail: `+${holderGrowth.toFixed(0)}% holders in 24h` });
      score += 25;
    } else if (holderGrowth >= 3) {
      signals.push({ signal: "holders_growing", strength: "MEDIUM", detail: `+${holderGrowth.toFixed(0)}% holders` });
      score += 12;
    } else if (holderGrowth < -10) {
      signals.push({ signal: "holders_declining", strength: "NEGATIVE", detail: `${holderGrowth.toFixed(0)}% holders` });
      score -= 15;
    }
  }

  // Signal 3: Distribution improving (top 10 concentration dropping)
  if (top10Concentration != null && top10Concentration24hAgo != null) {
    const concChange = top10Concentration - top10Concentration24hAgo;
    if (concChange < -5) {
      signals.push({ signal: "distribution_improving", strength: "STRONG", detail: `Top10 conc: ${top10Concentration}% (was ${top10Concentration24hAgo}%)` });
      score += 20;
    } else if (concChange < -2) {
      signals.push({ signal: "distribution_slightly_improving", strength: "MEDIUM", detail: `Top10: ${top10Concentration}%` });
      score += 10;
    }
  }

  // Signal 4: Price stabilizing or recovering
  if (priceUsd != null && price24hAgo != null && price24hAgo > 0) {
    const priceChange = ((priceUsd - price24hAgo) / price24hAgo) * 100;
    if (priceChange >= 5) {
      signals.push({ signal: "price_recovering", strength: "STRONG", detail: `Price +${priceChange.toFixed(1)}% in 24h` });
      score += 20;
    } else if (priceChange >= -10 && priceChange < 5) {
      signals.push({ signal: "price_stable", strength: "MEDIUM", detail: `Price ${priceChange.toFixed(1)}%` });
      score += 10;
    } else if (priceChange < -30) {
      signals.push({ signal: "price_freefall", strength: "NEGATIVE", detail: `Price ${priceChange.toFixed(1)}%` });
      score -= 10;
    }
  }

  // Signal 5: Community social activity
  if (socialVelocity != null && socialVelocity > 0) {
    signals.push({ signal: "social_active", strength: "MEDIUM", detail: `Social velocity: ${socialVelocity}` });
    score += 10;
  }

  // Signal 6: Coin age — young CTOs are riskier
  if (ageHours != null && ageHours < 6) {
    signals.push({ signal: "very_young_cto", strength: "CAUTION", detail: `Only ${ageHours.toFixed(0)}h old` });
    score -= 10;
  }

  const confidence = Math.max(0, Math.min(100, Math.round(score)));
  let phase;
  if (score >= 70) phase = "CONFIRMED_CTO";
  else if (score >= 45) phase = "LIKELY_CTO";
  else if (score >= 20) phase = "POSSIBLE_CTO";
  else phase = "NO_CTO";

  // Persist CTO detections
  let ctoStore = { detections: [] };
  try {
    if (fs.existsSync(CTO_DETECTIONS_FILE)) {
      ctoStore = JSON.parse(fs.readFileSync(CTO_DETECTIONS_FILE, "utf8"));
    }
  } catch { /* fresh */ }
  if (phase !== "NO_CTO") {
    ctoStore.detections.push({
      mint: tokenMint,
      symbol: tokenSymbol,
      phase,
      confidence,
      signals: signals.filter(s => s.strength !== "NEGATIVE" && s.strength !== "CAUTION"),
      detected_at: nowIso(),
    });
    if (ctoStore.detections.length > 200) ctoStore.detections = ctoStore.detections.slice(-200);
    atomicWriteJson(CTO_DETECTIONS_FILE, ctoStore);
  }

  return {
    is_cto: phase !== "NO_CTO",
    confidence,
    phase,
    signals,
    recommendation: phase === "CONFIRMED_CTO" ? "STRONG_COMMUNITY_PLAY"
      : phase === "LIKELY_CTO" ? "WATCH_COMMUNITY"
      : phase === "POSSIBLE_CTO" ? "MONITOR_ONLY"
      : "STANDARD_TRADE",
  };
}

// ═══════════════════════════════════════════════════════════════
// 3. MIGRATION DETECTION
// ═══════════════════════════════════════════════════════════════

const MIGRATION_PATTERNS = {
  PUMPFUN_TO_RAYDIUM: {
    from: "pumpfun",
    to: "raydium",
    signals: ["bonding_curve_complete", "lp_migration", "dex_listing"],
    bullish: true,
    reason: "PumpFun graduation → Raydium = legitimacy signal",
  },
  DEX_TO_CEX: {
    from: "dex",
    to: "cex",
    signals: ["cex_announcement", "listing_confirmed", "volume_spike"],
    bullish: true,
    reason: "DEX → CEX listing = major liquidity unlock",
  },
  V2_TO_V3: {
    from: "v2",
    to: "v3",
    signals: ["contract_upgrade", "migration_announcement"],
    bullish: true,
    reason: "Protocol upgrade = team still building",
  },
  CHAIN_MIGRATION: {
    from: "solana",
    to: "ethereum|base|arbitrum|polygon",
    signals: ["bridge_deployed", "wrapped_token", "cross_chain_announcement"],
    bullish: true,
    reason: "Cross-chain expansion = broader market access",
  },
  RUG_MIGRATION: {
    from: null,
    to: null,
    signals: ["dev_wallet_drained", "lp_removed", "socials_deleted", "new_token_same_dev"],
    bullish: false,
    reason: "Dev rug-pulled old coin, launching new one — AVOID",
  },
};

/**
 * Detect if a coin is undergoing migration.
 *
 * Checks for:
 *   - PumpFun → Raydium graduation
 *   - DEX → CEX listing
 *   - Contract upgrade / V2 migration
 *   - Cross-chain bridge deployment
 *   - Rug migration (dev abandoning old coin for new one)
 */
export function detectMigration({
  tokenMint,
  tokenSymbol = null,
  currentPlatform = null,
  launchPlatform = null,
  bondingCurveProgress = null,
  lpMovedTo = null,
  cexListings = [],
  contractUpgraded = null,
  bridgeDeployed = null,
  devWallet = null,
  devNewCoinMint = null,
  volume24h = null,
  volume24hPrev = null,
} = {}) {
  const detections = [];

  // PumpFun → Raydium
  if ((launchPlatform === "pumpfun" || currentPlatform === "pumpfun") &&
      (bondingCurveProgress >= 100 || lpMovedTo === "raydium")) {
    detections.push({
      type: "PUMPFUN_TO_RAYDIUM",
      confidence: bondingCurveProgress >= 100 ? 95 : 70,
      bullish: true,
      detail: MIGRATION_PATTERNS.PUMPFUN_TO_RAYDIUM.reason,
      phase: bondingCurveProgress >= 100 ? "COMPLETED" : "IN_PROGRESS",
    });
  }

  // DEX → CEX
  if (Array.isArray(cexListings) && cexListings.length > 0) {
    detections.push({
      type: "DEX_TO_CEX",
      confidence: 85,
      bullish: true,
      detail: `Listed on: ${cexListings.join(", ")}`,
      phase: "COMPLETED",
      exchanges: cexListings,
    });
  }

  // Volume spike (potential pre-listing accumulation)
  if (volume24h != null && volume24hPrev != null && volume24hPrev > 0) {
    const volRatio = volume24h / volume24hPrev;
    if (volRatio >= 3 && cexListings.length === 0) {
      detections.push({
        type: "POTENTIAL_PRE_LISTING",
        confidence: Math.min(70, Math.round(volRatio * 15)),
        bullish: true,
        detail: `Volume ${volRatio.toFixed(1)}x spike — possible pre-listing accumulation`,
        phase: "SUSPECTED",
      });
    }
  }

  // Contract upgrade
  if (contractUpgraded) {
    detections.push({
      type: "CONTRACT_UPGRADE",
      confidence: 60,
      bullish: true,
      detail: "Smart contract upgraded — team actively developing",
      phase: "COMPLETED",
    });
  }

  // Bridge deployment (cross-chain)
  if (bridgeDeployed) {
    detections.push({
      type: "BRIDGE_DEPLOYED",
      confidence: 70,
      bullish: true,
      detail: "Cross-chain bridge deployed — expanding to new chains",
      phase: "COMPLETED",
    });
  }

  // Rug migration detection
  if (devWallet && devNewCoinMint) {
    detections.push({
      type: "RUG_MIGRATION",
      confidence: 80,
      bullish: false,
      detail: `Dev moved to new coin: ${devNewCoinMint.slice(0, 12)}...`,
      phase: "DETECTED",
    });
  }

  const activeMigrations = detections.filter(d => d.confidence >= 50);
  const bullishCount = activeMigrations.filter(d => d.bullish).length;
  const bearishCount = activeMigrations.filter(d => !d.bullish).length;

  return {
    has_migration: activeMigrations.length > 0,
    count: activeMigrations.length,
    bullish: bullishCount,
    bearish: bearishCount,
    active: activeMigrations,
    summary: activeMigrations.length > 0
      ? activeMigrations.map(d => d.detail).join(" | ")
      : "No migration activity detected",
    recommendation: bearishCount > 0 ? "AVOID_RUG_MIGRATION"
      : bullishCount >= 2 ? "STRONG_ACCUMULATE"
      : bullishCount >= 1 ? "BULLISH_MIGRATION"
      : "NEUTRAL",
  };
}

// ═══════════════════════════════════════════════════════════════
// 4. ACTIVE COMMUNITY QUALITY ASSESSMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Assess community quality based on multiple dimensions.
 *
 * Quality dimensions:
 *   - Holder distribution (Gini-like metric)
 *   - Organic growth rate
 *   - Wallet quality (real wallets vs bots)
 *   - Social velocity
 *   - Developer engagement
 */
export function assessCommunityQuality({
  holderCount = null,
  holderCount24hAgo = null,
  newHolderCount24h = null,
  top10Concentration = null,
  top50Concentration = null,
  botHolderEstimate = null,
  socialVelocity = null,
  devLastActiveHoursAgo = null,
  devEngagementScore = null,
  whaleCount = null,        // holders with >5% supply
  sniperCount = null,       // first-block buyers still holding
} = {}) {
  const metrics = {};
  let totalScore = 0;
  let maxPossible = 0;

  // 1. Distribution quality
  if (top10Concentration != null) {
    if (top10Concentration <= 30) {
      metrics.distribution = { score: 20, label: "EXCELLENT", detail: `Top 10 only ${top10Concentration}% — well distributed` };
    } else if (top10Concentration <= 50) {
      metrics.distribution = { score: 12, label: "GOOD", detail: `Top 10: ${top10Concentration}%` };
    } else if (top10Concentration <= 70) {
      metrics.distribution = { score: 5, label: "FAIR", detail: `Top 10: ${top10Concentration}% — somewhat concentrated` };
    } else {
      metrics.distribution = { score: -10, label: "POOR", detail: `Top 10: ${top10Concentration}% — whale dominated` };
    }
    totalScore += metrics.distribution.score;
    maxPossible += 20;
  }

  // 2. Organic growth
  if (holderCount24hAgo != null && holderCount != null) {
    const growth = holderCount24hAgo > 0
      ? ((holderCount - holderCount24hAgo) / holderCount24hAgo) * 100
      : 0;
    if (growth >= 5 && growth <= 50) {
      metrics.growth = { score: 15, label: "ORGANIC", detail: `+${growth.toFixed(0)}% holders — healthy growth` };
    } else if (growth > 50) {
      metrics.growth = { score: 5, label: "SUSPICIOUS", detail: `+${growth.toFixed(0)}% — possible bot inflating` };
    } else if (growth >= 1 && growth < 5) {
      metrics.growth = { score: 10, label: "STEADY", detail: `+${growth.toFixed(0)}% — slow but real` };
    } else {
      metrics.growth = { score: -5, label: "DECLINING", detail: `${growth.toFixed(0)}% — community shrinking` };
    }
    totalScore += metrics.growth.score;
    maxPossible += 15;
  }

  // 3. Bot/sniper contamination
  if (botHolderEstimate != null || sniperCount != null) {
    const botPct = holderCount > 0 ? ((botHolderEstimate || 0) + (sniperCount || 0)) / holderCount * 100 : 0;
    if (botPct <= 10) {
      metrics.purity = { score: 15, label: "CLEAN", detail: `~${botPct.toFixed(0)}% bots/snipers` };
    } else if (botPct <= 25) {
      metrics.purity = { score: 8, label: "MODERATE", detail: `~${botPct.toFixed(0)}% bots` };
    } else {
      metrics.purity = { score: -8, label: "INFESTED", detail: `~${botPct.toFixed(0)}% bots — low organic` };
    }
    totalScore += metrics.purity.score;
    maxPossible += 15;
  }

  // 4. Social velocity
  if (socialVelocity != null) {
    if (socialVelocity >= 0.5 && socialVelocity <= 3) {
      metrics.social = { score: 12, label: "ACTIVE", detail: "Community actively discussing" };
    } else if (socialVelocity > 3) {
      metrics.social = { score: 8, label: "HYPED", detail: "High activity — possible shilling" };
    } else {
      metrics.social = { score: 3, label: "QUIET", detail: "Low social activity" };
    }
    totalScore += metrics.social.score;
    maxPossible += 12;
  }

  // 5. Dev engagement
  if (devLastActiveHoursAgo != null || devEngagementScore != null) {
    if (devEngagementScore != null && devEngagementScore >= 70) {
      metrics.dev_engagement = { score: 12, label: "ENGAGED", detail: "Dev actively building & communicating" };
    } else if (devLastActiveHoursAgo != null && devLastActiveHoursAgo <= 72) {
      metrics.dev_engagement = { score: 8, label: "PRESENT", detail: `Dev active within ${devLastActiveHoursAgo.toFixed(0)}h` };
    } else if (devLastActiveHoursAgo != null && devLastActiveHoursAgo <= 168) {
      metrics.dev_engagement = { score: 3, label: "LURKING", detail: "Dev quiet but not gone" };
    } else {
      metrics.dev_engagement = { score: -8, label: "ABSENT", detail: "Dev not seen for >1 week" };
    }
    totalScore += metrics.dev_engagement.score;
    maxPossible += 12;
  }

  // 6. Whale concentration risk
  if (whaleCount != null && holderCount != null && holderCount > 0) {
    const whalePct = whaleCount / holderCount * 100;
    if (whalePct <= 2) {
      metrics.whale_risk = { score: 10, label: "LOW", detail: `${whaleCount} whales among ${holderCount} holders` };
    } else {
      metrics.whale_risk = { score: -5, label: "ELEVATED", detail: `${whaleCount} whales — dump risk` };
    }
    totalScore += metrics.whale_risk.score;
    maxPossible += 10;
  }

  // Normalize to 0-100
  const normalizedScore = maxPossible > 0
    ? Math.max(0, Math.min(100, Math.round((totalScore / maxPossible) * 100)))
    : 50;

  let grade;
  if (normalizedScore >= 75) grade = "A";
  else if (normalizedScore >= 60) grade = "B";
  else if (normalizedScore >= 40) grade = "C";
  else if (normalizedScore >= 25) grade = "D";
  else grade = "F";

  return {
    score: normalizedScore,
    grade,
    metrics,
    is_quality_community: normalizedScore >= 60,
    summary: `Community Grade ${grade} (${normalizedScore}/100)`,
    recommendation: normalizedScore >= 75 ? "STRONG_COMMUNITY"
      : normalizedScore >= 60 ? "GOOD_COMMUNITY"
      : normalizedScore >= 40 ? "AVERAGE_COMMUNITY"
      : "WEAK_COMMUNITY",
  };
}

// ═══════════════════════════════════════════════════════════════
// COMPOSITE: Full Coin + Community + Dev Assessment
// ═══════════════════════════════════════════════════════════════

/**
 * Run all community/dev/coin detectors for a single token.
 * This is the main entry point for the screening pipeline.
 */
export function runCommunityAssessment(tokenData = {}) {
  const {
    mint, symbol, creator, launchpad, holder_count, holder_count_24h,
    top_10_concentration, top_10_24h, price_usd, price_24h,
    volume_24h, volume_24h_prev, social_velocity, dev_balance,
    dev_initial_balance, dev_last_active_hours, dev_engagement_score,
    bot_holder_estimate, sniper_count, whale_count,
    bonding_curve_progress, lp_moved_to, cex_listings,
    contract_upgraded, bridge_deployed, dev_new_coin,
    age_hours, new_holder_count_24h,
  } = tokenData;

  // Dev reputation
  const devRep = scoreDevReputation({
    creatorWallet: creator,
    tokenMint: mint,
    tokenSymbol: symbol,
    launchPlatform: launchpad,
    holderCount: holder_count,
    ageMinutes: age_hours ? age_hours * 60 : null,
  });

  // Community takeover
  const cto = detectCommunityTakeover({
    tokenMint: mint,
    tokenSymbol: symbol,
    devWallet: creator,
    devBalance: dev_balance,
    devInitialBalance: dev_initial_balance,
    holderCount: holder_count,
    holderCount24hAgo: holder_count_24h,
    top10Concentration: top_10_concentration,
    top10Concentration24hAgo: top_10_24h,
    priceUsd: price_usd,
    price24hAgo: price_24h,
    volume24h: volume_24h,
    socialVelocity: social_velocity,
    ageHours: age_hours,
  });

  // Migration
  const migration = detectMigration({
    tokenMint: mint,
    tokenSymbol: symbol,
    currentPlatform: launchpad,
    launchPlatform: launchpad,
    bondingCurveProgress: bonding_curve_progress,
    lpMovedTo: lp_moved_to,
    cexListings: cexListings,
    contractUpgraded: contract_upgraded,
    bridgeDeployed: bridge_deployed,
    devWallet: creator,
    devNewCoinMint: dev_new_coin,
    volume24h: volume_24h,
    volume24hPrev: volume_24h_prev,
  });

  // Community quality
  const community = assessCommunityQuality({
    holderCount: holder_count,
    holderCount24hAgo: holder_count_24h,
    newHolderCount24h: new_holder_count_24h,
    top10Concentration: top_10_concentration,
    botHolderEstimate: bot_holder_estimate,
    socialVelocity: social_velocity,
    devLastActiveHoursAgo: dev_last_active_hours,
    devEngagementScore: dev_engagement_score,
    whaleCount: whale_count,
    sniperCount: sniper_count,
  });

  // Composite signal
  const signals = [];
  if (devRep.tier === "ELITE" || devRep.tier === "TRUSTED") signals.push("DEV_CREDIBLE");
  if (devRep.tier === "RUGGER") signals.push("DEV_RUGGER");
  if (cto.is_cto) signals.push("COMMUNITY_TAKEOVER");
  if (community.is_quality_community) signals.push("QUALITY_COMMUNITY");
  if (migration.bullish > 0) signals.push("BULLISH_MIGRATION");
  if (migration.bearish > 0) signals.push("BEARISH_MIGRATION");

  return {
    mint,
    symbol,
    dev: devRep,
    community_takeover: cto,
    migration,
    community_quality: community,
    signals,
    composite_score: Math.round(
      (devRep.score * 0.25 +
       (cto.is_cto ? cto.confidence * 0.20 : 0) +
       (community.score * 0.30) +
       (migration.bullish > 0 ? 70 : migration.bearish > 0 ? 10 : 50) * 0.25)
    ),
    summary: [
      `Dev: ${devRep.tier} (${devRep.score})`,
      `CTO: ${cto.phase}`,
      `Migration: ${migration.summary}`,
      `Community: ${community.grade} (${community.score}/100)`,
    ].join(" | "),
  };
}
