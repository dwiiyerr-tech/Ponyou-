/**
 * Conviction Memory — pengalaman agent dari profit dan keberhasilan.
 *
 * Conviction bukan sekadar skor — ini adalah rekaman pola KENAPA sebuah
 * coin bisa terbang dan profit. Setiap trade yang berhasil meninggalkan
 * "sidik jari" (profit fingerprint) yang mencakup:
 *   - Strategy apa yang dipakai
 *   - Market cap tier (nano/micro/small/mid/large)
 *   - Narasi ekosistem (AI, gaming, meme, DeFi, dll)
 *   - Kondisi market saat entry (HOT/NORMAL/COLD)
 *   - Launchpad / ekosistem (pumpfun, raydium, orca, dll)
 *   - Level social buzz saat entry
 *   - Level momentum teknikal saat entry
 *
 * Ketika coin baru datang untuk diriset, sistem mencocokkan profil coin itu
 * dengan sidik jari masa lalu. Semakin mirip dengan pola yang pernah profit
 * → semakin tinggi conviction dari pengalaman.
 *
 * Tiga lapisan conviction:
 *   1. Coin conviction     — rekaman observasi dan outcome per coin
 *   2. Narrative conviction— rekaman performa per narasi
 *   3. Experience score    — kemiripan dengan sidik jari profit masa lalu
 *
 * Experience score ini yang membuat conviction benar-benar "pengalaman".
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";
import { classifyNarrative } from "./tools/narratives.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVICTION_FILE      = path.join(__dirname, "coin-conviction.json");
const PROFIT_PATTERNS_FILE = path.join(__dirname, "profit-patterns.json");
const LOSS_PATTERNS_FILE   = path.join(__dirname, "loss-patterns.json");
const DECAY_WINDOW_MS     = 24 * 60 * 60 * 1000;
const MAX_PROFIT_PATTERNS = 500; // rolling window

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadStore() {
  if (!fs.existsSync(CONVICTION_FILE)) return { coins: {}, narratives: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONVICTION_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return { coins: {}, narratives: {} };
    return {
      coins:      parsed.coins      && typeof parsed.coins === "object"      ? parsed.coins      : {},
      narratives: parsed.narratives && typeof parsed.narratives === "object" ? parsed.narratives : {},
    };
  } catch { return { coins: {}, narratives: {} }; }
}

function saveStore(data) { atomicWriteJson(CONVICTION_FILE, data); }

function loadProfitPatterns() {
  if (!fs.existsSync(PROFIT_PATTERNS_FILE)) return { patterns: [] };
  try { return JSON.parse(fs.readFileSync(PROFIT_PATTERNS_FILE, "utf8")); }
  catch { return { patterns: [] }; }
}

function saveProfitPatterns(data) { atomicWriteJson(PROFIT_PATTERNS_FILE, data); }

function loadLossPatterns() {
  if (!fs.existsSync(LOSS_PATTERNS_FILE)) return { patterns: [] };
  try { return JSON.parse(fs.readFileSync(LOSS_PATTERNS_FILE, "utf8")); }
  catch { return { patterns: [] }; }
}

function saveLossPatterns(data) { atomicWriteJson(LOSS_PATTERNS_FILE, data); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOrCreateCoin(store, mint, symbol = null) {
  if (!store.coins[mint]) {
    store.coins[mint] = {
      mint,
      symbol: symbol || mint.slice(0, 8),
      observation_count: 0,
      passed_count: 0,
      failed_count: 0,
      gem_count: 0,
      trash_count: 0,
      rug_count: 0,
      win_count: 0,
      loss_count: 0,
      cumulative_signal_score: 0,
      cumulative_outcome_delta: 0,
      last_signal_score: 0,
      last_seen_at: null,
      last_market_condition: "UNKNOWN",
      narratives: [],
    };
  }
  if (symbol) store.coins[mint].symbol = symbol;
  return store.coins[mint];
}

function getOrCreateNarrative(store, narrative) {
  if (!store.narratives[narrative]) {
    store.narratives[narrative] = {
      narrative,
      observation_count: 0,
      gem_count: 0,
      trash_count: 0,
      rug_count: 0,
      win_count: 0,
      loss_count: 0,
      cumulative_signal_score: 0,
      cumulative_outcome_delta: 0,
      last_seen_at: null,
    };
  }
  return store.narratives[narrative];
}

function extractNarrativeNames(token = {}) {
  const explicit = Array.isArray(token.narrative_tags) ? token.narrative_tags : [];
  const normalizedExplicit = explicit
    .map(tag => typeof tag === "string" ? tag : tag?.narrative)
    .filter(Boolean);
  if (normalizedExplicit.length > 0) {
    return [...new Set(normalizedExplicit.filter(tag => tag !== "OTHER"))];
  }
  const classified = classifyNarrative(token);
  return [...new Set((classified || []).map(tag => tag?.narrative).filter(tag => tag && tag !== "OTHER"))];
}

function applyDecay(entity = {}, now = Date.now()) {
  const lastSeen = entity.last_seen_at ? new Date(entity.last_seen_at).getTime() : 0;
  if (!lastSeen || now <= lastSeen) return { ...entity, decay_factor: 1 };
  const ageMs = now - lastSeen;
  const windows = ageMs / DECAY_WINDOW_MS;
  const decayFactor = Math.pow(0.88, windows);
  return {
    ...entity,
    cumulative_outcome_delta: Number((Number(entity.cumulative_outcome_delta || 0) * decayFactor).toFixed(4)),
    cumulative_signal_score:  Number((Number(entity.cumulative_signal_score  || 0) * Math.max(0.92, decayFactor)).toFixed(4)),
    decay_factor: Number(decayFactor.toFixed(4)),
  };
}

// ─── Market Cap Tier ─────────────────────────────────────────────────────────
// Membagi ekosistem berdasarkan ukuran — pola profit berbeda di tiap tier.

function classifyMcapTier(mcap = 0) {
  if (mcap <= 0)           return "unknown";
  if (mcap < 50_000)       return "nano";      // < $50k  — sangat spekulatif
  if (mcap < 500_000)      return "micro";     // $50k-500k
  if (mcap < 5_000_000)    return "small";     // $500k-5M
  if (mcap < 50_000_000)   return "mid";       // $5M-50M
  return "large";                              // > $50M
}

function classifyMomentumLevel(momentumScore = 0) {
  if (momentumScore >= 70) return "high";
  if (momentumScore >= 40) return "medium";
  return "low";
}

function classifySocialLevel(socialBuzz = 0) {
  if (socialBuzz >= 60) return "high";
  if (socialBuzz >= 30) return "medium";
  return "low";
}

function normalizeLaunchpad(token = {}) {
  const lp = (token.launchpad || token._dex || token.dexId || "").toLowerCase();
  if (lp.includes("pump")) return "pumpfun";
  if (lp.includes("raydium")) return "raydium";
  if (lp.includes("orca")) return "orca";
  if (lp.includes("jupiter")) return "jupiter";
  if (lp.includes("meteora")) return "meteora";
  return lp || "unknown";
}

// ─── Profit Fingerprint ───────────────────────────────────────────────────────
// Database "KENAPA coin ini menang" — bukan kategori, tapi data nyata.
// Setiap trade profit menyimpan rekaman lengkap kondisi pada saat entry:
// holder, komunitas, developer, wallet pintar, struktur token, sinyal, narasi.

function buildProfitFingerprint({ mint, symbol, name, pnl_pct, hold_minutes, token = {}, strategy = null }) {
  const ca = token.community_assessment || {};
  const dev = ca.dev || token.dev_reputation || {};
  const community = ca.community_quality || {};
  const cto = ca.community_takeover || {};
  const sig = token.signal || {};
  const sigComponents = sig.components || {};
  const narratives = extractNarrativeNames(token);
  const mcap = Number(token.mcap || token.marketCap || 0);
  const launchpad = normalizeLaunchpad(token);
  const marketCondition = token.market_condition || "UNKNOWN";

  // ── Holder data (data nyata, bukan kategori) ──────────────────────────────
  const holderCount       = Number(token.holders || token.holder_count || 0);
  const top10Pct          = Number(token.top_10_pct || token.top10Concentration || ca.community_quality?.holder_concentration || 0);
  const freshFunded       = Number(token.fresh_funded_holders || 0);
  const dustHolders       = Number(token.dust_holders || 0);
  const bundleBuyersPct   = Number(token.bundle_buyers_pct || 0);
  const sameFunder        = Number(token.same_funder_holders || 0);
  const creatorPct        = Number(token.creator_pct || 0);

  // ── Komunitas ─────────────────────────────────────────────────────────────
  const isQualityCommunity = !!community.is_quality_community;
  const isCto              = !!cto.is_cto;
  const devCredibility     = dev.credibility || "UNKNOWN";
  const devTier            = dev.tier        || "UNKNOWN";
  const devEngagement      = Number(token.dev_engagement_score || ca.dev?.engagement_score || 0);
  const socialBuzz         = Number(sigComponents.social_buzz || token.social_buzz || 0);
  const communitySignals   = Array.isArray(ca.signals) ? ca.signals : [];

  // ── Smart wallet ──────────────────────────────────────────────────────────
  const walletSignals      = token._wallet_signals || token.wallet_signals || null;
  const smartWalletPresent = walletSignals ? (walletSignals.tier !== "none") : false;
  const walletTier         = walletSignals?.tier || "none";
  const walletCount        = Number(walletSignals?.match_count || 0);

  // ── Struktur token ────────────────────────────────────────────────────────
  const mintAuthority      = !!token.mint_authority;
  const freezeAuthority    = !!token.freeze_authority;
  const lpLocked           = token.lp_locked === true;
  const permanentDelegate  = !!token.permanent_delegate;
  const transferHook       = !!token.transfer_hook;
  const rugScore           = Number(token.rug_score || 0);
  const rugcheckScore      = Number(token._rugcheck_score || 0);

  // ── Market / LP saat entry ────────────────────────────────────────────────
  const liquidityUsd       = Number(token.liquidity || 0);
  const volume24h          = Number(token.volume || token.volume24h || 0);
  const swaps              = Number(token.swaps || 0);
  const ageMinutes         = Number(token.age_minutes || 0);
  const priceChange1h      = Number(token.priceChange?.h1 || token.price_change_1h || 0);
  const bondingCurve       = Number(token.bonding_curve || 0);

  // ── Sinyal agregator ──────────────────────────────────────────────────────
  const signalScore        = Number(sig.signal_score || 0);
  const convictionAtEntry  = Number(token.conviction?.conviction_score || 0);
  const momentumScore      = Number(token.momentum_score || 0);
  const volatilityPct      = Number(token.volatility_percentile || 0);
  const featureAggregate   = Number(token.feature_aggregate || 0);
  const narrativeVelocity  = Number(sigComponents.velocity || 0);
  const kellyFraction      = Number(token.kelly?.effective_fraction || 0);

  // ── Kenapa menang — alasan kemenangan yang bisa diidentifikasi ───────────
  const winReasons = [];
  if (isQualityCommunity)                   winReasons.push("quality_community");
  if (isCto)                               winReasons.push("community_takeover");
  if (devCredibility === "HIGH")           winReasons.push("high_dev_credibility");
  if (devCredibility === "MEDIUM")         winReasons.push("medium_dev_credibility");
  if (devTier === "BUILDER")               winReasons.push("builder_dev");
  if (smartWalletPresent)                  winReasons.push("smart_wallet_present");
  if (walletTier === "alpha")              winReasons.push("alpha_wallet");
  if (holderCount >= 100 && holderCount <= 1500) winReasons.push("healthy_holder_count");
  if (top10Pct > 0 && top10Pct <= 40)     winReasons.push("low_top10_concentration");
  if (freshFunded <= 2)                    winReasons.push("few_fresh_wallets");
  if (bundleBuyersPct <= 10)              winReasons.push("low_bundle_buyers");
  if (!mintAuthority)                      winReasons.push("no_mint_authority");
  if (!freezeAuthority)                    winReasons.push("no_freeze_authority");
  if (lpLocked)                            winReasons.push("lp_locked");
  if (rugScore <= 15)                      winReasons.push("clean_rug_score");
  if (liquidityUsd >= 5000)               winReasons.push("healthy_liquidity");
  if (socialBuzz >= 50)                    winReasons.push("strong_social_buzz");
  if (narrativeVelocity >= 60)            winReasons.push("strong_narrative_velocity");
  if (momentumScore >= 60)                winReasons.push("high_momentum");
  if (signalScore >= 65)                   winReasons.push("strong_signal_aggregate");
  if (convictionAtEntry >= 55)             winReasons.push("high_conviction_at_entry");
  if (narratives.length > 0)              winReasons.push("narrative_aligned");
  if (launchpad === "pumpfun")            winReasons.push("pumpfun_ecosystem");
  if (hold_minutes <= 30)                 winReasons.push("fast_pump");
  if (pnl_pct >= 100)                     winReasons.push("moonshot");

  return {
    id:           `win_${Date.now()}_${symbol || mint?.slice(0, 6)}`,
    mint,
    symbol:       symbol || mint?.slice(0, 8),
    name:         name || token.name || "",
    pnl_pct:      parseFloat((pnl_pct || 0).toFixed(2)),
    hold_minutes: Math.round(hold_minutes || 0),
    strategy:     strategy || token.strategy_id || "unknown",

    // ── Holder (data nyata) ──────────────────────────────────────────────
    holder: {
      count:            holderCount,
      top10_pct:        parseFloat(top10Pct.toFixed(1)),
      fresh_funded:     freshFunded,
      dust:             dustHolders,
      bundle_buyers_pct: parseFloat(bundleBuyersPct.toFixed(1)),
      same_funder:      sameFunder,
      creator_pct:      parseFloat(creatorPct.toFixed(1)),
    },

    // ── Komunitas ────────────────────────────────────────────────────────
    community: {
      is_quality:      isQualityCommunity,
      is_cto:          isCto,
      dev_credibility: devCredibility,
      dev_tier:        devTier,
      dev_engagement:  Math.round(devEngagement),
      social_buzz:     Math.round(socialBuzz),
      signals:         communitySignals.slice(0, 5),
    },

    // ── Smart wallet ─────────────────────────────────────────────────────
    wallet: {
      smart_present: smartWalletPresent,
      tier:          walletTier,
      count:         walletCount,
    },

    // ── Struktur token ───────────────────────────────────────────────────
    token_structure: {
      mint_authority:     mintAuthority,
      freeze_authority:   freezeAuthority,
      lp_locked:          lpLocked,
      permanent_delegate: permanentDelegate,
      transfer_hook:      transferHook,
      rug_score:          parseFloat(rugScore.toFixed(1)),
      rugcheck_score:     Math.round(rugcheckScore),
    },

    // ── Market / LP saat entry ───────────────────────────────────────────
    market: {
      mcap_usd:          Math.round(mcap),
      mcap_tier:         classifyMcapTier(mcap),
      liquidity_usd:     Math.round(liquidityUsd),
      volume_24h:        Math.round(volume24h),
      swaps:             Math.round(swaps),
      age_minutes:       Math.round(ageMinutes),
      price_change_1h:   parseFloat(priceChange1h.toFixed(1)),
      bonding_curve:     parseFloat(bondingCurve.toFixed(1)),
      launchpad,
      market_condition:  marketCondition,
    },

    // ── Sinyal agregator ─────────────────────────────────────────────────
    signals: {
      signal_score:       parseFloat(signalScore.toFixed(1)),
      conviction:         parseFloat(convictionAtEntry.toFixed(1)),
      momentum:           parseFloat(momentumScore.toFixed(1)),
      volatility_pct:     parseFloat(volatilityPct.toFixed(1)),
      feature_aggregate:  parseFloat(featureAggregate.toFixed(1)),
      narrative_velocity: parseFloat(narrativeVelocity.toFixed(1)),
      kelly_fraction:     parseFloat(kellyFraction.toFixed(3)),
      social_buzz:        Math.round(socialBuzz),
    },

    // ── Narasi ───────────────────────────────────────────────────────────
    narrative: {
      tags:     narratives,
      strongest: narratives[0] || null,
    },

    // ── Alasan kemenangan ────────────────────────────────────────────────
    win_reasons: winReasons,

    // ── Temporal — waktu entry (pola waktu di crypto sangat nyata) ───────
    temporal: {
      hour_utc:    new Date().getUTCHours(),
      day_of_week: new Date().getUTCDay(), // 0=Sun, 1=Mon ... 6=Sat
      is_weekend:  [0, 6].includes(new Date().getUTCDay()),
      session:     _classifySession(new Date().getUTCHours()),
    },

    recorded_at: new Date().toISOString(),
  };
}

// ─── Temporal Helper ──────────────────────────────────────────────────────────
// Session trading: Asia (00-08 UTC), London (08-16 UTC), New York (13-21 UTC)

function _classifySession(hourUtc) {
  if (hourUtc >= 0  && hourUtc < 8)  return "asia";
  if (hourUtc >= 8  && hourUtc < 13) return "london";
  if (hourUtc >= 13 && hourUtc < 21) return "new_york";
  return "after_hours";
}

// ─── Loss Fingerprint ─────────────────────────────────────────────────────────
// Rekaman kondisi trade yang RUGI — untuk menghindari pola yang sama.
// Lebih sederhana dari profit fingerprint — fokus pada apa yang salah.

function buildLossFingerprint({ mint, symbol, pnl_pct, hold_minutes, exit_reason, token = {} }) {
  const ca      = token.community_assessment || {};
  const dev     = ca.dev || token.dev_reputation || {};
  const walSig  = token._wallet_signals || token.wallet_signals || null;
  const narratives = extractNarrativeNames(token);
  const mcap    = Number(token.mcap || token.marketCap || 0);

  // Alasan kekalahan — apa yang ada saat entry yang ternyata salah
  const lossReasons = [];
  const isRug = /rug/i.test(exit_reason || "");
  if (isRug)                                                 lossReasons.push("rug_exit");
  if ((token.rug_score || 0) > 30)                          lossReasons.push("high_rug_score_at_entry");
  if ((token.top_10_pct || 0) > 60)                         lossReasons.push("high_concentration");
  if ((token.fresh_funded_holders || 0) > 5)                lossReasons.push("many_fresh_wallets");
  if ((token.bundle_buyers_pct || 0) > 20)                  lossReasons.push("high_bundle_buyers");
  if (dev.credibility === "LOW" || dev.tier === "RUGGER")   lossReasons.push("bad_dev");
  if (!(ca.community_quality?.is_quality_community))        lossReasons.push("no_quality_community");
  if (!walSig || walSig.tier === "none")                    lossReasons.push("no_smart_wallet");
  if (hold_minutes < 5)                                     lossReasons.push("instant_dump");
  if (hold_minutes < 15 && pnl_pct < -30)                   lossReasons.push("fast_dump");
  if ((token.signal?.signal_score || 0) < 40)               lossReasons.push("weak_signal_at_entry");
  if (token.market_condition === "DEAD")                    lossReasons.push("dead_market_entry");

  return {
    id:           `loss_${Date.now()}_${symbol || mint?.slice(0, 6)}`,
    mint,
    symbol:       symbol || mint?.slice(0, 8),
    pnl_pct:      parseFloat((pnl_pct || 0).toFixed(2)),
    hold_minutes: Math.round(hold_minutes || 0),
    exit_reason:  exit_reason || "",
    is_rug:       isRug,

    holder: {
      count:             Number(token.holders || 0),
      top10_pct:         parseFloat((token.top_10_pct || 0).toFixed(1)),
      fresh_funded:      Number(token.fresh_funded_holders || 0),
      bundle_buyers_pct: parseFloat((token.bundle_buyers_pct || 0).toFixed(1)),
    },
    community: {
      is_quality:      !!(ca.community_quality?.is_quality_community),
      dev_credibility: dev.credibility || "UNKNOWN",
      dev_tier:        dev.tier || "UNKNOWN",
      social_buzz:     Math.round(Number(token.signal?.components?.social_buzz || 0)),
    },
    wallet: {
      smart_present: !!(walSig && walSig.tier !== "none"),
      tier:          walSig?.tier || "none",
    },
    token_structure: {
      rug_score:       parseFloat((token.rug_score || 0).toFixed(1)),
      mint_authority:  !!(token.mint_authority),
      freeze_authority: !!(token.freeze_authority),
    },
    market: {
      mcap_usd:         Math.round(mcap),
      mcap_tier:        classifyMcapTier(mcap),
      liquidity_usd:    Math.round(Number(token.liquidity || 0)),
      launchpad:        normalizeLaunchpad(token),
      market_condition: token.market_condition || "UNKNOWN",
    },
    signals: {
      signal_score: parseFloat((token.signal?.signal_score || 0).toFixed(1)),
      conviction:   parseFloat((token.conviction?.conviction_score || 0).toFixed(1)),
      momentum:     parseFloat((token.momentum_score || 0).toFixed(1)),
    },
    narrative: {
      tags:     narratives,
      strongest: narratives[0] || null,
    },
    temporal: {
      hour_utc:    new Date().getUTCHours(),
      day_of_week: new Date().getUTCDay(),
      session:     _classifySession(new Date().getUTCHours()),
    },
    loss_reasons: lossReasons,
    recorded_at:  new Date().toISOString(),
  };
}

// ─── Experience Score ─────────────────────────────────────────────────────────
// Cocokkan data NYATA token saat ini dengan database sidik jari profit masa lalu.
// Bukan cocokkan kategori — tapi cocokkan nilai aktual: holder count, dev tier,
// wallet presence, top10%, liquidity, narasi, dll.

export function getExperienceScore(token = {}, { topN = 100, minMatches = 3 } = {}) {
  const data = loadProfitPatterns();
  const patterns = (data.patterns || []).slice(-topN);
  if (patterns.length === 0) return { score: 0, matched_patterns: 0, best_match: null, win_reasons_matched: [] };

  // Profil token saat ini
  const ca             = token.community_assessment || {};
  const dev            = ca.dev || token.dev_reputation || {};
  const community      = ca.community_quality || {};
  const walletSig      = token._wallet_signals || token.wallet_signals || null;
  const sig            = token.signal || {};
  const sigComp        = sig.components || {};

  const tokenMcap      = Number(token.mcap || token.marketCap || 0);
  const tokenMcapTier  = classifyMcapTier(tokenMcap);
  const tokenNarr      = new Set(extractNarrativeNames(token));
  const tokenLaunchpad = normalizeLaunchpad(token);
  const tokenMarket    = token.market_condition || "UNKNOWN";
  const tokenHolders   = Number(token.holders || 0);
  const tokenTop10     = Number(token.top_10_pct || token.top10Concentration || 0);
  const tokenFresh     = Number(token.fresh_funded_holders || 0);
  const tokenBundle    = Number(token.bundle_buyers_pct || 0);
  const tokenDevCred   = dev.credibility || "UNKNOWN";
  const tokenDevTier   = dev.tier || "UNKNOWN";
  const tokenQualComm  = !!community.is_quality_community;
  const tokenSmartW    = walletSig ? (walletSig.tier !== "none") : false;
  const tokenWalletTier= walletSig?.tier || "none";
  const tokenLiq       = Number(token.liquidity || 0);
  const tokenRug       = Number(token.rug_score || 0);
  const tokenMint      = !!token.mint_authority;
  const tokenFreeze    = !!token.freeze_authority;
  const tokenMomentum  = Number(token.momentum_score || 0);
  const tokenSocial    = Number(sigComp.social_buzz || token.social_buzz || 0);
  const tokenSignal    = Number(sig.signal_score || 0);
  const tokenConvEntry = Number(token.conviction?.conviction_score || 0);

  let totalSim = 0;
  let matchCount = 0;
  let bestScore = 0;
  let bestMatch = null;
  const winReasonsAgg = {};

  for (const fp of patterns) {
    let sim = 0;
    const h   = fp.holder          || {};
    const com = fp.community        || {};
    const wal = fp.wallet           || {};
    const ts  = fp.token_structure  || {};
    const mkt = fp.market           || {};
    const sigs= fp.signals          || {};
    const nar = fp.narrative        || {};

    // ── Holder similarity (30 pts total) ────────────────────────────────
    // Holder count dalam ±50% range pemenang lama
    if (h.count > 0 && tokenHolders > 0) {
      const ratio = tokenHolders / h.count;
      if (ratio >= 0.5 && ratio <= 2.0) sim += 10;
      else if (ratio >= 0.3 && ratio <= 3.0) sim += 5;
    }
    // Top10 concentration — keduanya rendah = baik
    if (h.top10_pct > 0 && tokenTop10 > 0) {
      const bothLow  = h.top10_pct <= 45 && tokenTop10 <= 45;
      const bothHigh = h.top10_pct >= 60 && tokenTop10 >= 60;
      if (bothLow)  sim += 10;
      else if (bothHigh) sim += 2;
    }
    // Fresh funded wallets — keduanya rendah = organik
    if (h.fresh_funded <= 3 && tokenFresh <= 3) sim += 5;
    // Bundle buyers rendah
    if (h.bundle_buyers_pct <= 15 && tokenBundle <= 15) sim += 5;

    // ── Komunitas (25 pts total) ─────────────────────────────────────────
    if (com.is_quality   === tokenQualComm && tokenQualComm) sim += 10;
    if (com.dev_credibility === tokenDevCred && tokenDevCred !== "UNKNOWN") sim += 8;
    if (com.dev_tier        === tokenDevTier  && tokenDevTier  !== "UNKNOWN") sim += 4;
    // Social buzz dalam range
    if (sigs.social_buzz > 0 && tokenSocial > 0) {
      const sRatio = tokenSocial / sigs.social_buzz;
      if (sRatio >= 0.5 && sRatio <= 2.0) sim += 3;
    }

    // ── Smart wallet (15 pts total) ──────────────────────────────────────
    if (wal.smart_present === tokenSmartW) {
      sim += tokenSmartW ? 10 : 3;
    }
    if (wal.tier === tokenWalletTier && tokenWalletTier !== "none") sim += 5;

    // ── Struktur token (15 pts total) ────────────────────────────────────
    if (ts.mint_authority     === tokenMint)   sim += 4;
    if (ts.freeze_authority   === tokenFreeze) sim += 4;
    if (ts.lp_locked          === !!token.lp_locked) sim += 3;
    // Rug score dalam range
    if (ts.rug_score >= 0 && tokenRug >= 0) {
      const bothClean = ts.rug_score <= 20 && tokenRug <= 20;
      if (bothClean) sim += 4;
    }

    // ── Market / ekosistem (15 pts total) ────────────────────────────────
    if (mkt.mcap_tier      === tokenMcapTier)   sim += 5;
    if (mkt.launchpad      === tokenLaunchpad)  sim += 4;
    if (mkt.market_condition === tokenMarket)   sim += 3;
    // Liquidity dalam ±3x range
    if (mkt.liquidity_usd > 0 && tokenLiq > 0) {
      const lRatio = tokenLiq / mkt.liquidity_usd;
      if (lRatio >= 0.33 && lRatio <= 3.0) sim += 3;
    }

    // ── Narasi (10 pts total) ────────────────────────────────────────────
    const fpNarr = new Set(nar.tags || []);
    const overlap = [...tokenNarr].filter(n => fpNarr.has(n)).length;
    if (overlap >= 2) sim += 10;
    else if (overlap === 1) sim += 5;

    // ── Sinyal (10 pts) ──────────────────────────────────────────────────
    if (sigs.signal_score > 0 && tokenSignal > 0) {
      if (Math.abs(sigs.signal_score - tokenSignal) <= 20) sim += 5;
    }
    if (sigs.momentum > 0 && tokenMomentum > 0) {
      if (Math.abs(sigs.momentum - tokenMomentum) <= 25) sim += 5;
    }

    // ── Temporal (5 pts) — pola waktu entry ─────────────────────────────
    const nowHour    = new Date().getUTCHours();
    const nowSession = _classifySession(nowHour);
    if (fp.temporal?.session === nowSession) sim += 5;

    // ── Age decay — pola lama bobotnya berkurang (crypto cepat berubah) ──
    // Pattern > 7 hari mulai pudar; > 30 hari hanya separuh bobot
    const ageMs    = fp.recorded_at ? Date.now() - new Date(fp.recorded_at).getTime() : 0;
    const ageDays  = ageMs / (86400 * 1000);
    const ageFactor = ageDays <= 7 ? 1.0
      : ageDays <= 14 ? 0.90
      : ageDays <= 30 ? 0.75
      : 0.55;

    // ── Profit boost — pengalaman moonshot lebih berharga ───────────────
    const profitBoost = fp.pnl_pct >= 100 ? 1.25 : fp.pnl_pct >= 50 ? 1.1 : 1.0;
    const finalSim = Math.min(100, Math.round(sim * profitBoost * ageFactor));

    if (finalSim >= 35) {
      totalSim += finalSim;
      matchCount++;

      for (const reason of (fp.win_reasons || [])) {
        winReasonsAgg[reason] = (winReasonsAgg[reason] || 0) + 1;
      }

      if (finalSim > bestScore) {
        bestScore = finalSim;
        bestMatch = {
          symbol:      fp.symbol,
          pnl_pct:     fp.pnl_pct,
          similarity:  finalSim,
          age_days:    Math.round(ageDays),
          win_reasons: fp.win_reasons || [],
          market:      fp.market?.market_condition,
          dev:         fp.community?.dev_credibility,
          holder_count: fp.holder?.count,
        };
      }
    }
  }

  // Require minimum matches to activate experience score — 1-2 is noise
  const score = matchCount >= minMatches
    ? clamp(Math.round(totalSim / matchCount), 0, 100)
    : 0;

  const topWinReasons = Object.entries(winReasonsAgg)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  return {
    score,
    matched_patterns:  matchCount,
    total_experience:  patterns.length,
    best_match:        matchCount >= minMatches ? bestMatch : null,
    win_reasons_matched: matchCount >= minMatches ? topWinReasons : [],
  };
}

// ─── Loss Score ───────────────────────────────────────────────────────────────
// Cocokkan token saat ini dengan database KERUGIAN masa lalu.
// Jika mirip dengan loser → hasilnya mengurangi net experience score.

export function getLossScore(token = {}, { topN = 100, minMatches = 3 } = {}) {
  const data = loadLossPatterns();
  const patterns = (data.patterns || []).slice(-topN);
  if (patterns.length === 0) return { penalty: 0, matched_patterns: 0, loss_reasons_matched: [] };

  const ca         = token.community_assessment || {};
  const dev        = ca.dev || token.dev_reputation || {};
  const walSig     = token._wallet_signals || token.wallet_signals || null;
  const narratives = new Set(extractNarrativeNames(token));
  const tokenMcapTier  = classifyMcapTier(Number(token.mcap || token.marketCap || 0));
  const tokenLaunchpad = normalizeLaunchpad(token);
  const tokenMarket    = token.market_condition || "UNKNOWN";
  const tokenHolders   = Number(token.holders || 0);
  const tokenTop10     = Number(token.top_10_pct || 0);
  const tokenFresh     = Number(token.fresh_funded_holders || 0);
  const tokenBundle    = Number(token.bundle_buyers_pct || 0);
  const tokenDevCred   = (ca.dev || dev).credibility || "UNKNOWN";
  const tokenSmartW    = !!(walSig && walSig.tier !== "none");
  const tokenRug       = Number(token.rug_score || 0);
  const tokenSignal    = Number(token.signal?.signal_score || 0);
  const nowSession     = _classifySession(new Date().getUTCHours());

  let totalPenalty = 0;
  let matchCount = 0;
  const lossReasonsAgg = {};

  for (const fp of patterns) {
    let sim = 0;
    const h   = fp.holder          || {};
    const com = fp.community        || {};
    const wal = fp.wallet           || {};
    const ts  = fp.token_structure  || {};
    const mkt = fp.market           || {};
    const sigs= fp.signals          || {};

    // Holder concentration mirip
    if (h.top10_pct > 50 && tokenTop10 > 50)   sim += 15;
    if (h.fresh_funded >= 3 && tokenFresh >= 3) sim += 10;
    if (h.bundle_buyers_pct > 15 && tokenBundle > 15) sim += 10;

    // Komunitas mirip loser
    if (com.dev_credibility === tokenDevCred && tokenDevCred === "LOW")  sim += 15;
    if (com.dev_credibility === tokenDevCred && tokenDevCred === "UNKNOWN") sim += 5;
    if (!com.is_quality && !((ca.community_quality?.is_quality_community))) sim += 8;

    // Wallet — keduanya tidak ada smart wallet
    if (!wal.smart_present && !tokenSmartW) sim += 10;

    // Rug score tinggi di entry
    if (ts.rug_score > 25 && tokenRug > 25) sim += 10;

    // Market sama
    if (mkt.mcap_tier === tokenMcapTier)   sim += 5;
    if (mkt.launchpad === tokenLaunchpad)  sim += 3;
    if (mkt.market_condition === tokenMarket) sim += 4;

    // Signal lemah di entry
    if (sigs.signal_score < 45 && tokenSignal < 45) sim += 8;

    // Temporal — jam yang sama sering loss
    if (fp.temporal?.session === nowSession) sim += 2;

    // Age decay — loss patterns lama juga berkurang relevansinya
    const ageMs    = fp.recorded_at ? Date.now() - new Date(fp.recorded_at).getTime() : 0;
    const ageDays  = ageMs / (86400 * 1000);
    const ageFactor = ageDays <= 7 ? 1.0
      : ageDays <= 14 ? 0.90
      : ageDays <= 30 ? 0.75
      : 0.55;

    // Boost jika loss besar
    const lossBoost = fp.pnl_pct <= -50 ? 1.3 : fp.pnl_pct <= -25 ? 1.1 : 1.0;
    const finalSim = Math.min(100, Math.round(sim * lossBoost * ageFactor));

    if (finalSim >= 30) {
      totalPenalty += finalSim;
      matchCount++;
      for (const reason of (fp.loss_reasons || [])) {
        lossReasonsAgg[reason] = (lossReasonsAgg[reason] || 0) + 1;
      }
    }
  }

  // Require minimum matches before penalizing — 1-2 is noise
  const penalty = matchCount >= minMatches
    ? clamp(Math.round(totalPenalty / matchCount), 0, 100)
    : 0;

  const topLossReasons = Object.entries(lossReasonsAgg)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, count]) => ({ reason, count }));

  return {
    penalty,
    matched_patterns: matchCount,
    loss_reasons_matched: matchCount >= minMatches ? topLossReasons : [],
  };
}

// ─── Record Loss Pattern ──────────────────────────────────────────────────────
// Dipanggil saat trade RUGI atau RUG — simpan sidik jari kekalahan.

export function recordLossPattern({ mint, symbol, pnl_pct, hold_minutes, exit_reason, token = {} } = {}) {
  if (!mint || (pnl_pct || 0) >= 0) return null;

  const fingerprint = buildLossFingerprint({ mint, symbol, pnl_pct, hold_minutes, exit_reason, token });
  const data = loadLossPatterns();
  data.patterns.push(fingerprint);
  if (data.patterns.length > 500) data.patterns = data.patterns.slice(-500);
  data.last_updated  = new Date().toISOString();
  data.total_losses  = (data.total_losses || 0) + 1;
  saveLossPatterns(data);
  return fingerprint;
}

// ─── Record Profit Pattern ────────────────────────────────────────────────────
// Dipanggil saat trade PROFIT ditutup — simpan sidik jari pengalaman.

export function recordProfitPattern({ mint, symbol, name, pnl_pct, hold_minutes, token = {}, strategy = null } = {}) {
  if (!mint || (pnl_pct || 0) <= 0) return null;

  const fingerprint = buildProfitFingerprint({ mint, symbol, name, pnl_pct, hold_minutes, token, strategy });
  const data = loadProfitPatterns();

  data.patterns.push(fingerprint);
  // Rolling window — buang yang paling lama
  if (data.patterns.length > MAX_PROFIT_PATTERNS) {
    data.patterns = data.patterns.slice(-MAX_PROFIT_PATTERNS);
  }
  data.last_updated = new Date().toISOString();
  data.total_wins   = (data.total_wins || 0) + 1;
  data.avg_pnl      = parseFloat(
    ((data.patterns.reduce((s, p) => s + p.pnl_pct, 0)) / data.patterns.length).toFixed(2)
  );

  saveProfitPatterns(data);
  return fingerprint;
}

// ─── Profit Pattern Summary ───────────────────────────────────────────────────
// Ringkasan "pengalaman" agent — pola apa yang paling sering profit.

export function getProfitPatternSummary() {
  const data = loadProfitPatterns();
  const patterns = data.patterns || [];
  if (patterns.length === 0) return { total: 0, patterns: [] };

  // Hitung frekuensi win_patterns
  const patternFreq = {};
  const mcapFreq    = {};
  const narrativeFreq = {};
  const launchpadFreq = {};
  const strategyFreq  = {};

  for (const fp of patterns) {
    for (const wp of (fp.win_patterns || [])) {
      patternFreq[wp] = (patternFreq[wp] || 0) + 1;
    }
    mcapFreq[fp.mcap_tier]      = (mcapFreq[fp.mcap_tier]      || 0) + 1;
    launchpadFreq[fp.launchpad] = (launchpadFreq[fp.launchpad] || 0) + 1;
    strategyFreq[fp.strategy]   = (strategyFreq[fp.strategy]   || 0) + 1;
    for (const n of (fp.narratives || [])) {
      narrativeFreq[n] = (narrativeFreq[n] || 0) + 1;
    }
  }

  const topPatterns   = Object.entries(patternFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ pattern: k, count: v }));
  const topMcap       = Object.entries(mcapFreq).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ tier: k, count: v }));
  const topNarratives = Object.entries(narrativeFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ narrative: k, count: v }));
  const topLaunchpads = Object.entries(launchpadFreq).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ launchpad: k, count: v }));
  const topStrategies = Object.entries(strategyFreq).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ strategy: k, count: v }));

  const avgPnl = patterns.reduce((s, p) => s + p.pnl_pct, 0) / patterns.length;
  const moonshotCount = patterns.filter(p => p.pnl_pct >= 100).length;

  return {
    total:           patterns.length,
    avg_pnl:         parseFloat(avgPnl.toFixed(2)),
    moonshot_count:  moonshotCount,
    top_win_patterns: topPatterns,
    best_mcap_tiers:  topMcap,
    best_narratives:  topNarratives,
    best_launchpads:  topLaunchpads,
    best_strategies:  topStrategies,
    last_updated:     data.last_updated,
  };
}

// ─── Signal Score ─────────────────────────────────────────────────────────────

export function deriveSignalScore(token = {}) {
  let score = 50;
  if (token.passed) score += 12;
  score -= Math.min(30, Number(token.rug_score || 0) * 0.5);
  score -= Math.min(20, (token.flags || []).length * 6);
  score += Math.max(-10, Math.min(15, Number(token.momentum_score || 0) / 8));

  if (token.kelly?.should_skip) score -= 25;
  else score += Math.min(12, Math.max(0, Number(token.kelly?.effective_fraction || 0) * 40));

  if (token.market_condition === "HOT")  score += 6;
  if (token.market_condition === "COLD") score -= 4;
  if (token.market_condition === "DEAD") score -= 12;

  const fa = Number(token.feature_aggregate || token.signal?.signal_score || 0);
  if (fa >= 60)      score += 10;
  else if (fa >= 40) score += 4;
  else if (fa < 25)  score -= 8;

  return clamp(Number(score.toFixed(2)), 0, 100);
}

// ─── Record Coin Observation ──────────────────────────────────────────────────

export async function recordCoinObservation(token = {}, { minIntervalMs = 30 * 60 * 1000 } = {}) {
  if (!token?.mint) return null;
  return withFileLock(CONVICTION_FILE, async () => {
    const store = loadStore();
    const coin  = getOrCreateCoin(store, token.mint, token.symbol);
    const now   = Date.now();
    const lastSeen = coin.last_seen_at ? new Date(coin.last_seen_at).getTime() : 0;
    if (lastSeen && now - lastSeen < minIntervalMs) return coin;

    const signalScore = deriveSignalScore(token);
    const narratives  = extractNarrativeNames(token);
    coin.observation_count += 1;
    if (token.passed) coin.passed_count += 1;
    else              coin.failed_count += 1;
    coin.cumulative_signal_score += signalScore;
    coin.last_signal_score       = signalScore;
    coin.last_seen_at            = new Date(now).toISOString();
    coin.last_market_condition   = token.market_condition || coin.last_market_condition || "UNKNOWN";
    coin.narratives = narratives;

    for (const narrative of narratives) {
      const slot = getOrCreateNarrative(store, narrative);
      slot.observation_count += 1;
      slot.cumulative_signal_score += signalScore;
      slot.last_seen_at = new Date(now).toISOString();
    }

    saveStore(store);
    return coin;
  });
}

// ─── Record Observation Outcomes ──────────────────────────────────────────────

export function recordObservationOutcomes(results = []) {
  if (!Array.isArray(results) || results.length === 0) return 0;
  // CM-2: serialize observations through the same lock the rest of the
  // module uses. Previously this skipped the lock and could race against
  // recordCoinObservation / recordTradeConvictionOutcome, losing deltas.
  return withFileLock(CONVICTION_FILE, async () => {
    const store = loadStore();
    let changed = 0;

    for (const result of results) {
      if (!result?.mint) continue;
      const coin       = getOrCreateCoin(store, result.mint, result.symbol);
      const narratives = coin.narratives || extractNarrativeNames(result);

      if (result.performance === "GEM") {
        coin.gem_count += 1;
        coin.cumulative_outcome_delta += 18;
      } else if (result.performance === "TRASH") {
        coin.trash_count += 1;
        coin.cumulative_outcome_delta -= 14;
      } else if (result.performance === "RUG") {
        coin.rug_count += 1;
        coin.cumulative_outcome_delta -= 28;
      }

      for (const narrative of narratives) {
        const slot = getOrCreateNarrative(store, narrative);
        if (result.performance === "GEM") {
          slot.gem_count += 1; slot.cumulative_outcome_delta += 12;
        } else if (result.performance === "TRASH") {
          slot.trash_count += 1; slot.cumulative_outcome_delta -= 10;
        } else if (result.performance === "RUG") {
          slot.rug_count += 1; slot.cumulative_outcome_delta -= 18;
        }
        slot.last_seen_at = new Date().toISOString();
      }
      changed += 1;
    }

    if (changed > 0) saveStore(store);
    return changed;
  });
}

// ─── Record Trade Conviction Outcome ─────────────────────────────────────────
// Dipanggil setiap trade ditutup. Jika profit → simpan profit fingerprint.

export function recordTradeConvictionOutcome({ mint, symbol, name, pnl_pct = 0, hold_minutes = 0, exit_reason = "", token = {}, strategy = null } = {}) {
  if (!mint) return null;

  // CM-3: serialize through the same file lock recordCoinObservation uses.
  // Without this, two trade outcomes resolving in the same tick race on
  // load/save and one set of deltas is lost.
  return withFileLock(CONVICTION_FILE, async () => {
  const store      = loadStore();
  const coin       = getOrCreateCoin(store, mint, symbol);
  const narratives = coin.narratives || [];

  // CM-1: harmonize with LA-1 — recognize LLM-closed rugs that don't match
  // /rug/ in the exit reason. A -80%+ wipeout regardless of label is
  // treated as a rug for conviction bookkeeping; otherwise positive PnL
  // is a win. Without this, every LLM-closed rug was booked as a plain
  // loss in conviction-memory while the rug counter stayed at 0.
  const pnl = Number(pnl_pct || 0);
  const reasonStr = String(exit_reason || "").toLowerCase();
  const reasonHasRug = /rug|honeypot|drained/.test(reasonStr);
  const isWipeout    = Number.isFinite(pnl) && pnl <= -80;
  const isRug = reasonHasRug || isWipeout;
  const isWin = !isRug && pnl > 0;

  if (isWin) {
    coin.win_count += 1;
    coin.cumulative_outcome_delta += Math.min(16, Math.max(6, pnl / 5));

    // Simpan sidik jari profit — ini adalah "pengalaman" agent
    try {
      recordProfitPattern({ mint, symbol, name, pnl_pct: pnl, hold_minutes, token, strategy });
    } catch (e) {
      // profit pattern failure never blocks conviction update
    }
  } else {
    coin.loss_count += 1;
    coin.cumulative_outcome_delta -= Math.min(18, Math.max(6, Math.abs(pnl) / 4));

    // Simpan sidik jari kekalahan — untuk menghindari pola yang sama
    try {
      recordLossPattern({ mint, symbol, pnl_pct: pnl, hold_minutes, exit_reason, token });
    } catch (e) {
      // loss pattern failure never blocks conviction update
    }
  }

  if (isRug) {
    coin.rug_count += 1;
    coin.cumulative_outcome_delta -= 10;
  }

  for (const narrative of narratives) {
    const slot = getOrCreateNarrative(store, narrative);
    if (isWin) {
      slot.win_count += 1;
      slot.cumulative_outcome_delta += Math.min(10, Math.max(4, pnl / 8));
    } else {
      slot.loss_count += 1;
      slot.cumulative_outcome_delta -= Math.min(12, Math.max(4, Math.abs(pnl) / 7));
    }
    if (isRug) {
      slot.rug_count += 1;
      slot.cumulative_outcome_delta -= 8;
    }
    slot.last_seen_at = new Date().toISOString();
  }

  saveStore(store);
  return coin;
  });
}

// ─── Narrative Conviction ─────────────────────────────────────────────────────

export function getNarrativeConviction(narrative, { nowMs = Date.now(), velocity = null, crossBatch = null } = {}) {
  if (!narrative) return { narrative: null, conviction_score: 0, confidence_score: 0, stance: "unknown" };

  const store = loadStore();
  const raw   = store.narratives[narrative];

  let trendingBoost = 0;
  if (velocity?.is_trending) {
    const v = velocity;
    trendingBoost = Math.min(25, Math.round(v.token_count * 6 + (v.buy_ratio > 0.6 ? 10 : 0) + Math.min(v.velocity_score / 5, 8)));
  }

  let sustainedBoost = 0;
  if (crossBatch?.active) {
    const cb = crossBatch.active.find(a => a.narrative === narrative);
    if (cb) {
      sustainedBoost = Math.min(15, Math.round(cb.cross_batch_score * 0.25 + cb.consecutive_cycles * 3));
    }
  }

  if (!raw) {
    const totalBoost = trendingBoost + sustainedBoost;
    const convictionScore = totalBoost > 0 ? clamp(10 + totalBoost, 0, 100) : 0;
    const stance = convictionScore >= 28 ? "building" : convictionScore >= 15 ? "watch" : "unknown";
    return {
      narrative,
      conviction_score: convictionScore,
      confidence_score: totalBoost > 0 ? clamp(totalBoost * 1.2, 0, 50) : 0,
      stance,
      trending_boost:  trendingBoost,
      sustained_boost: sustainedBoost > 0 ? sustainedBoost : undefined,
    };
  }

  const slot       = applyDecay(raw, nowMs);
  const totalBoost = trendingBoost + sustainedBoost;
  const obs        = Math.max(0, slot.observation_count || 0);
  const avgSignal  = obs > 0 ? slot.cumulative_signal_score / obs : 0;
  const convictionScore = clamp(
    10 + avgSignal * 0.42 + Number(slot.cumulative_outcome_delta || 0) + totalBoost,
    0, 100
  );
  const confidenceScore = clamp(
    obs * 10 +
    ((slot.gem_count || 0) + (slot.trash_count || 0) + (slot.rug_count || 0) +
     (slot.win_count || 0) + (slot.loss_count || 0)) * 7 +
    Math.min(totalBoost, 25),
    0, 100
  );

  let stance = "watch";
  if (confidenceScore < 15)                                     stance = "unknown";
  else if (convictionScore >= 68 && confidenceScore >= 40)      stance = "strong";
  else if (convictionScore >= 48)                               stance = "building";
  else if (convictionScore < 28)                                stance = "avoid";

  return {
    narrative,
    conviction_score:  Number(convictionScore.toFixed(1)),
    confidence_score:  Number(confidenceScore.toFixed(1)),
    observation_count: obs,
    gem_count:   slot.gem_count   || 0,
    trash_count: slot.trash_count || 0,
    rug_count:   slot.rug_count   || 0,
    win_count:   slot.win_count   || 0,
    loss_count:  slot.loss_count  || 0,
    avg_signal_score: Number(avgSignal.toFixed(1)),
    decay_factor:     slot.decay_factor,
    stance,
    trending_boost:  trendingBoost  > 0 ? trendingBoost  : undefined,
    sustained_boost: sustainedBoost > 0 ? sustainedBoost : undefined,
  };
}

// ─── Coin Conviction ─────────────────────────────────────────────────────────
// Gabungan: observasi + narasi + pengalaman profit masa lalu.

export function getCoinConviction(mint, token = null, { nowMs = Date.now(), narrativeVelocity = null, crossBatchVelocity = null } = {}) {
  if (!mint) {
    return { mint: null, conviction_score: 0, confidence_score: 0, observation_count: 0, gem_count: 0, trash_count: 0, win_count: 0, loss_count: 0, stance: "unknown" };
  }

  const store          = loadStore();
  const coin           = store.coins[mint];
  const narrativeNames = coin?.narratives?.length ? coin.narratives : extractNarrativeNames(token || {});

  const narrativeConvictions = narrativeNames.map(name => {
    const vel = narrativeVelocity?.velocities?.[name] || null;
    return getNarrativeConviction(name, { nowMs, velocity: vel, crossBatch: crossBatchVelocity });
  });
  const strongestNarrative = narrativeConvictions.sort((a, b) => b.conviction_score - a.conviction_score)[0] || null;

  // Experience score — kemiripan dengan sidik jari profit masa lalu
  const experience  = token ? getExperienceScore(token) : { score: 0, matched_patterns: 0, best_match: null, win_reasons_matched: [] };
  // Loss score — kemiripan dengan sidik jari kekalahan masa lalu (penalty)
  const lossResult  = token ? getLossScore(token) : { penalty: 0, matched_patterns: 0, loss_reasons_matched: [] };
  // Net experience = win similarity dikurangi setengah dari loss similarity
  const netExpScore = Math.max(0, experience.score - Math.round(lossResult.penalty * 0.5));

  if (!coin) {
    const baseScore = (strongestNarrative?.conviction_score || 0) * 0.6 + netExpScore * 0.4;
    return {
      mint,
      conviction_score:  Number(clamp(baseScore, 0, 100).toFixed(1)),
      confidence_score:  strongestNarrative?.confidence_score || 0,
      observation_count: 0,
      gem_count: 0, trash_count: 0, win_count: 0, loss_count: 0,
      stance:            strongestNarrative?.stance || (netExpScore >= 50 ? "building" : "unknown"),
      narratives:        narrativeNames,
      narrative_cluster: strongestNarrative,
      trending_boost:    strongestNarrative?.trending_boost || 0,
      experience_score:  experience.score,
      experience_matches: experience.matched_patterns,
      best_experience_match: experience.best_match,
      win_reasons_matched: experience.win_reasons_matched || [],
      loss_score:         lossResult.penalty,
      loss_matches:       lossResult.matched_patterns,
      loss_reasons_matched: lossResult.loss_reasons_matched || [],
    };
  }

  const decayedCoin = applyDecay(coin, nowMs);
  const obs         = Math.max(0, decayedCoin.observation_count || 0);
  const avgSignal   = obs > 0 ? decayedCoin.cumulative_signal_score / obs : 0;
  const passRate    = obs > 0 ? (decayedCoin.passed_count || 0) / obs : 0;

  // Base conviction dari observasi historis
  let convictionScore = clamp(
    15 +
    avgSignal * 0.45 +
    (passRate - 0.5) * 18 +
    Number(decayedCoin.cumulative_outcome_delta || 0),
    0, 100
  );
  let confidenceScore = clamp(
    obs * 12 +
    ((decayedCoin.gem_count || 0) + (decayedCoin.trash_count || 0) +
     (decayedCoin.rug_count || 0) + (decayedCoin.win_count  || 0) +
     (decayedCoin.loss_count || 0)) * 8,
    0, 100
  );

  // Blend narasi dulu (sama seperti sebelumnya)
  if (strongestNarrative) {
    convictionScore = clamp(convictionScore * 0.75 + strongestNarrative.conviction_score * 0.25, 0, 100);
    confidenceScore = clamp(confidenceScore * 0.80 + strongestNarrative.confidence_score * 0.20, 0, 100);
  }

  // Net experience boost — win similarity dikurangi loss penalty (max +12 pts).
  // Jika coin mirip pola loser → boost berkurang; jika belum ada data → tidak berpengaruh.
  if (netExpScore > 0 && experience.matched_patterns > 0) {
    const expBoost = Math.round((netExpScore / 100) * 12);
    convictionScore = clamp(convictionScore + expBoost, 0, 100);
  }

  let stance = "watch";
  if (confidenceScore < 20)                                   stance = "unknown";
  else if (convictionScore >= 70 && confidenceScore >= 45)    stance = "strong";
  else if (convictionScore >= 50)                             stance = "building";
  else if (convictionScore < 30)                              stance = "avoid";

  return {
    mint,
    symbol:            coin.symbol,
    conviction_score:  Number(convictionScore.toFixed(1)),
    confidence_score:  Number(confidenceScore.toFixed(1)),
    observation_count: obs,
    gem_count:   decayedCoin.gem_count   || 0,
    trash_count: decayedCoin.trash_count || 0,
    rug_count:   decayedCoin.rug_count   || 0,
    win_count:   decayedCoin.win_count   || 0,
    loss_count:  decayedCoin.loss_count  || 0,
    avg_signal_score: Number(avgSignal.toFixed(1)),
    decay_factor:     decayedCoin.decay_factor,
    narratives:        narrativeNames,
    narrative_cluster: strongestNarrative,
    trending_boost:    strongestNarrative?.trending_boost || 0,
    stance,
    // Dimensi pengalaman
    experience_score:       experience.score,
    experience_matches:     experience.matched_patterns,
    best_experience_match:  experience.best_match,
    win_reasons_matched:    experience.win_reasons_matched || [],
    loss_score:             lossResult.penalty,
    loss_matches:           lossResult.matched_patterns,
    loss_reasons_matched:   lossResult.loss_reasons_matched || [],
  };
}

export function getConvictionPromptLine(mint, token = null) {
  const c = getCoinConviction(mint, token);
  const winHints  = (c.win_reasons_matched  || []).slice(0, 3).map(r => r.reason).join(",");
  const lossHints = (c.loss_reasons_matched || []).slice(0, 3).map(r => r.reason).join(",");
  let line = `Conviction: ${c.stance} | score=${c.conviction_score} | confidence=${c.confidence_score} | obs=${c.observation_count} | exp_win=${c.experience_score ?? 0} | exp_loss=${c.loss_score ?? 0}`;
  if (winHints)  line += ` | win_patterns=[${winHints}]`;
  if (lossHints) line += ` | loss_warnings=[${lossHints}]`;
  return line;
}

export function _resetConvictionMemoryForTests() {
  if (fs.existsSync(CONVICTION_FILE))      fs.unlinkSync(CONVICTION_FILE);
  if (fs.existsSync(PROFIT_PATTERNS_FILE)) fs.unlinkSync(PROFIT_PATTERNS_FILE);
  if (fs.existsSync(LOSS_PATTERNS_FILE))   fs.unlinkSync(LOSS_PATTERNS_FILE);
}
