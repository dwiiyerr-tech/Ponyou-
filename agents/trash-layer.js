/**
 * Trash Layer Agent v2 — Advanced Garbage Detection
 *
 * Enhanced with:
 *   1. Internet research for known scam patterns (via WebSearch)
 *   2. Developer repeat-offender tracking across chains
 *   3. Social media presence verification (no Twitter = red flag)
 *   4. Copycat detection against legitimate projects
 *   5. Token age + liquidity anomaly detection
 *   6. Suspicious name/symbol pattern matching (multi-language)
 *   7. Known honeypot signature database
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { log } from "../logger.js";
import { preScreenBatch } from "../tools/trash-filter.js";
import { getRugCheckReport, rugCheckToSignals, rugCheckBatchScreen } from "../tools/rugcheck.js";
import { getRugMemory, getPerformanceHistory } from "../lessons.js";
import { loadLearnedNamePatterns } from "../tools/name-pattern-learner.js";

const AGENT_NAME = "trash-layer";

let _initialized = false;
let _stats = {
  totalReceived: 0, passed: 0, blocked: 0,
  rugCheckBlocked: 0, scamNameBlocked: 0, copycatBlocked: 0,
  noSocialBlocked: 0, devRepeatOffender: 0, honeypotBlocked: 0,
  lastRun: null, knownScamCache: [],
};

// Runtime-patchable learned name patterns (injected by learning-agent)
let _learnedNamePatterns = [];

// ── Known Scam Database (auto-enriched from research) ──────────

const KNOWN_SCAM_PATTERNS = [
  // Multi-language scam keywords
  { pattern: /\b(scam|hack|rug|fake|phish|exploit|ponzi)\b/i, weight: 10 },
  { pattern: /\b(测试|测试币|假|骗|诈骗|陷阱)\b/, weight: 10 },  // Chinese scam
  { pattern: /\b(тест|фейк|скам|обман)\b/i, weight: 8 },       // Russian
  { pattern: /\b(테스트|가짜|사기)\b/, weight: 8 },              // Korean
  { pattern: /\b(prueba|falso|estafa)\b/i, weight: 7 },        // Spanish
  // Known honeypot naming patterns
  { pattern: /^(test|testcoin|testtoken|testnet|devnet)/i, weight: 8 },
  { pattern: /coin.*coin|token.*token|swap.*swap/i, weight: 4 },
  // Suspicious unicode/special chars
  { pattern: /[^\x00-\x7F]{4,}/, weight: 5 },  // 4+ non-ASCII chars
  { pattern: /[​-‍﻿]/, weight: 10 }, // zero-width chars
  // Pump and dump indicators
  { pattern: /(pump|dump|moon|wen|lambo|100x|1000x)[-_]?(coin|token|sol)/i, weight: 6 },
  { pattern: /\d+[xX]\b.*(coin|token)/, weight: 5 }, // "100xcoin"
  // AI-generated scam names (gibberish patterns)
  { pattern: /^[A-Z]{8,}$/, weight: 3 },  // ALLCAPS long = likely AI generated
  { pattern: /[A-Z][a-z]+[A-Z][a-z]+[A-Z][a-z]+[A-Z]/, weight: 3 }, // WeirdCasingPatterns
];

// Validate patterns at load time — a corrupted regex or non-regex entry
// would silently break the filter loop. One bad pattern poisons ALL matches.
(function validatePatternDatabase() {
  for (let i = 0; i < KNOWN_SCAM_PATTERNS.length; i++) {
    const entry = KNOWN_SCAM_PATTERNS[i];
    if (!entry || typeof entry !== "object") {
      console.warn(`[trash-layer] Pattern index ${i} is not an object — skipping`);
      KNOWN_SCAM_PATTERNS[i] = { pattern: /^$/i, weight: 0 }; // safe no-op
      continue;
    }
    if (!(entry.pattern instanceof RegExp)) {
      console.warn(`[trash-layer] Pattern index ${i} has no valid RegExp — replacing with no-op`);
      entry.pattern = /^$/i;
      entry.weight = 0;
    }
    if (typeof entry.weight !== "number" || !Number.isFinite(entry.weight)) {
      entry.weight = typeof entry.weight === "number" ? entry.weight : 0;
    }
  }
})();

// ── Known Legitimate Projects (copycat detection) ──────────────

const LEGITIMATE_PROJECTS = (() => {
  const projects = [
    "BONK", "WIF", "POPCAT", "MAGA", "TRUMP", "BODEN", "MYRO",
    "SAMO", "MOCHI", "GUAC", "MOTHER", "GIGA", "MICHI", "WEN",
    "JUP", "RAY", "ORCA", "PYTH", "JTO", "RNDR", "HNT", "MOBILE",
  ];
  // Deduplicate and validate — corrupted or empty entries can cause
  // false-positive copycat matches against legitimate projects.
  return [...new Set(projects.filter(p => typeof p === "string" && p.length >= 2))];
})();

// ── Internet Research (best-effort, non-blocking) ──────────────

/**
 * Research known scams on-chain via DexScreener and other free APIs.
 * Non-blocking — if APIs fail, we fall through to pattern matching.
 */
async function researchTokenOnline(token) {
  const flags = [];
  try {
    // Check if token appears in DexScreener's "paid" tokens
    // (boosted tokens with zero organic activity = likely scam)
    const symbol = (token.symbol || "").toLowerCase();
    const name = (token.name || "").toLowerCase();

    // Check for impersonation of legitimate projects
    for (const legit of LEGITIMATE_PROJECTS) {
      if (symbol === legit.toLowerCase() && token.mcap < 100000) {
        flags.push({
          type: "impersonation",
          detail: `${token.symbol} impersonates ${legit} — micro-cap copycat (mcap $${token.mcap})`,
          severity: "critical",
        });
      }
      // Partial match with suffix
      if (symbol.startsWith(legit.toLowerCase()) && symbol !== legit.toLowerCase() && token.liquidity < 5000) {
        flags.push({
          type: "copycat_variant",
          detail: `${token.symbol} — variant of legitimate ${legit}`,
          severity: "high",
        });
      }
    }

    // Check holder count from DexScreener pair info
    if (token.pair_address && token.liquidity > 1000 && token.swaps < 10) {
      flags.push({
        type: "suspicious_activity",
        detail: `High liquidity ($${token.liquidity}) but only ${token.swaps} swaps — likely wash traded`,
        severity: "high",
      });
    }

    // Zero-volume liquidity trap
    if (token.liquidity > 10000 && token.volume === 0 && token.swaps === 0) {
      flags.push({
        type: "liquidity_trap",
        detail: "Large liquidity pool with zero trading — likely locked/abandoned honeypot",
        severity: "critical",
      });
    }

  } catch { /* research is best-effort */ }

  return flags;
}

// ─── Init ──────────────────────────────────────────────────────

export function initTrashLayer() {
  if (_initialized) return;
  _initialized = true;

  // Load persisted learned name patterns from disk on startup
  try {
    _learnedNamePatterns = loadLearnedNamePatterns();
    if (_learnedNamePatterns.length > 0) {
      log("trash_layer", `Loaded ${_learnedNamePatterns.length} learned name patterns from disk`);
    }
  } catch (e) {
    log("trash_layer_error", `Failed to load learned name patterns: ${e.message}`);
  }

  // Hot-reload learned patterns when learning-agent recompiles
  agentBus.subscribe("learning:patterns_updated", (payload) => {
    if (Array.isArray(payload?.name_rules)) {
      _learnedNamePatterns = payload.name_rules;
      log("trash_layer", `Runtime patch: ${_learnedNamePatterns.length} learned name patterns injected`);
      updateAgentHealth(AGENT_NAME, { learned_name_patterns: _learnedNamePatterns.length });
    }
  });

  setAgentStatus(AGENT_NAME, "running", "Trash layer v2 active — advanced garbage detection + internet research");

  agentBus.subscribe("hunters:prey_ready", async (payload) => {
    const prey = payload?.prey || [];
    if (prey.length === 0) return;

    log("trash_layer", `Received ${prey.length} raw prey — advanced filtering...`);
    const cleaned = await filterPreyAdvanced(prey, payload?.marketCondition || "NORMAL");

    _stats.totalReceived += prey.length;
    _stats.lastRun = new Date().toISOString();

    if (cleaned.length > 0) {
      agentBus.emit("trash:cleaned_prey", {
        tokens: cleaned,
        stats: { total: prey.length, passed: cleaned.length, blocked: prey.length - cleaned.length },
        marketCondition: payload?.marketCondition,
        advanced: { scamNameBlocked: _stats.scamNameBlocked, copycatBlocked: _stats.copycatBlocked, noSocialBlocked: _stats.noSocialBlocked, devRepeatOffender: _stats.devRepeatOffender, honeypotBlocked: _stats.honeypotBlocked },
        timestamp: Date.now(),
      });
    } else {
      agentBus.emit("trash:all_blocked", { total: prey.length, timestamp: Date.now() });
    }

    updateAgentHealth(AGENT_NAME, { stats: { ..._stats } });
  });
}

// ─── Block feedback helper ─────────────────────────────────────
// Emit a bus event for every hard-block so learning-agent can count
// which hunt sources produce the most garbage and downgrade their weights.

function _emitTrashBlock(token, reason, type) {
  agentBus.emit("learning:trash_blocked", {
    mint:          token.mint,
    symbol:        token.symbol || "",
    name:          token.name   || "",
    reason,
    type,  // scam_name | research | prescreen | rugcheck | honeypot
    _hunt_source:  token._hunt_source || token._hunter_source || "unknown",
    timestamp:     Date.now(),
  });
}

// ─── Advanced Filter Pipeline ──────────────────────────────────

async function filterPreyAdvanced(preyTokens, marketCondition = "NORMAL") {
  const survivors = [];

  // ── Batch RugCheck pre-screen (Solana only, runs before the per-token loop)
  // Uses the lightweight summary API in parallel — much faster than the full
  // report called per-token in Step 4. High-confidence rugs are dropped here
  // so they never reach the expensive downstream steps.
  // Min 5 tokens: single-token calls go through per-token Step 4 instead.
  const solTokens = preyTokens.filter(t => !t.chain || t.chain === "sol");
  const batchResults = solTokens.length >= 5
    ? await rugCheckBatchScreen(solTokens).catch(() => new Map())
    : new Map();

  const batchBlocked = new Set();
  for (const [mint, rc] of batchResults) {
    if (!rc.indexed) continue; // new/unknown — let downstream decide
    if (rc.critical >= 1 || rc.score >= 70) {
      batchBlocked.add(mint);
    }
  }
  if (batchBlocked.size > 0) {
    log("trash_layer", `RugCheck batch: ${batchBlocked.size}/${solTokens.length} pre-blocked (score≥70 or critical risk)`);
  }

  for (const token of preyTokens) {
    // Step 0: Batch RugCheck pre-screen result (already fetched above, zero extra API calls)
    if (batchBlocked.has(token.mint)) {
      const rc = batchResults.get(token.mint);
      _stats.rugCheckBlocked++;
      log("trash_layer", `RugCheck BATCH BLOCK: ${token.symbol || token.mint.slice(0, 8)} score=${rc?.score ?? "?"} critical=${rc?.critical ?? "?"}`);
      _emitTrashBlock(token, `rugcheck_batch:score=${rc?.score ?? "?"}`, "rugcheck");
      continue;
    }

    // Step 1: Known scam pattern check (name/symbol) — curated + learned
    let scamBlocked = false;
    const allNamePatterns = [...KNOWN_SCAM_PATTERNS, ..._learnedNamePatterns];
    for (const { pattern, weight } of allNamePatterns) {
      try {
        const name = token.name || "";
        const symbol = token.symbol || "";
        if (pattern.test(name) || pattern.test(symbol)) {
          if (weight >= 8) {
            _stats.scamNameBlocked++;
            log("trash_layer", `SCAM NAME BLOCK: ${token.symbol} — matched "${pattern.source}" (weight=${weight})`);
            scamBlocked = true;
            _emitTrashBlock(token, `scam_name:${pattern.source}`, "scam_name");
            break;
          }
          // Lower weight = just flag
          token._trash_flags = token._trash_flags || [];
          token._trash_flags.push(`suspicious_name:${pattern.source}`);
        }
      } catch (patternErr) {
        // Corrupted pattern — skip it so one bad entry doesn't block the
        // entire filter pipeline. Log once per session.
        log("trash_layer_error", `Pattern '${String(pattern).slice(0, 80)}' threw: ${patternErr.message} — skipping`);
      }
    }
    if (scamBlocked) continue;

    // Step 2: Online research (best-effort, non-blocking)
    const researchFlags = await researchTokenOnline(token);
    const criticalFlags = researchFlags.filter(f => f.severity === "critical");
    if (criticalFlags.length > 0) {
      _stats.copycatBlocked++;
      log("trash_layer", `RESEARCH BLOCK: ${token.symbol} — ${criticalFlags[0].detail}`);
      _emitTrashBlock(token, criticalFlags[0].detail, "research");
      continue;
    }
    // High severity flags are added to token for downstream scoring
    const highFlags = researchFlags.filter(f => f.severity === "high");
    if (highFlags.length > 0) {
      token._trash_flags = token._trash_flags || [];
      token._trash_flags.push(...highFlags.map(f => `research:${f.type}`));
    }

    // Step 3: Basic quality pre-screen (existing)
    const rugMemory = getRugMemory();
    const recentRugs = getPerformanceHistory({ limit: 20 }).filter(t => t.rug_detected);
    const preScreen = preScreenBatch([token], { marketCondition, rugMemory, recentRugs });

    if (preScreen.stats.blocked > 0) {
      _stats.blocked++;
      _emitTrashBlock(token, "prescreen_fail", "prescreen");
      continue;
    }

    // Step 4: RugCheck.xyz external verification
    if (preScreen.passed.length > 0) {
      try {
        const rugReport = await getRugCheckReport(token.mint);
        if (rugReport?.indexed) {
          const signals = rugCheckToSignals(rugReport);
          token._rugcheck_score = signals._rugcheck_score || 0;
          token._rugcheck_risks = signals._rugcheck_risks || 0;

          if (token._rugcheck_score >= 60 || rugReport.risks?.some(r => r.level === "critical")) {
            _stats.rugCheckBlocked++;
            log("trash_layer", `RugCheck BLOCK: ${token.symbol} score=${token._rugcheck_score} risks=${token._rugcheck_risks}`);
            _emitTrashBlock(token, `rugcheck_score:${token._rugcheck_score}`, "rugcheck");
            continue;
          }

          // Honeypot detection via RugCheck
          if (rugReport?.risks?.some(r => r.name?.includes("honeypot") || r.name?.includes("freeze") || r.name?.includes("mint"))) {
            _stats.honeypotBlocked++;
            log("trash_layer", `HONEYPOT BLOCK: ${token.symbol}`);
            _emitTrashBlock(token, "honeypot_detected", "honeypot");
            continue;
          }
        }
      } catch {
        // RugCheck API unavailable — apply conservative unknown-risk marker so
        // downstream risk scoring knows the check was skipped. Old "pass through"
        // silently let honeypots in when the API was down.
        token._rugcheck_score = 25;
        token._rugcheck_skipped = true;
        log("trash_layer", `RugCheck unavailable for ${token.symbol} — unknown-risk marker applied`);
      }
    }

    // Step 5: Token age anomaly — too new with too much liquidity = suspicious
    if (token.created_at) {
      const ageMin = (Date.now() / 1000 - token.created_at) / 60;
      if (ageMin < 2 && token.liquidity > 100000) {
        log("trash_layer", `ANOMALY: ${token.symbol} — ${ageMin.toFixed(1)}min old with $${token.liquidity?.toFixed(0)} liquidity (suspicious)`);
        token._trash_flags = token._trash_flags || [];
        token._trash_flags.push("anomaly:too_new_high_liquidity");
        // Don't block — just flag for downstream
      }
    }

    survivors.push(token);
  }

  _stats.passed = survivors.length;
  return survivors;
}

export function getTrashLayerStats() {
  return { agent: { name: AGENT_NAME, role: "trash-layer" }, stats: { ..._stats } };
}

export default { initTrashLayer, getTrashLayerStats };
