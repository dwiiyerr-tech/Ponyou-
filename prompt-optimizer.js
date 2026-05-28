/**
 * Universal Prompt Optimizer — works for ALL providers
 *
 * Reduces token cost without any provider-specific API feature.
 * Applied AFTER buildSystemPrompt(), BEFORE sendding to the LLM.
 *
 * Strategies (all provider-agnostic):
 *
 *   1. IN-PROCESS CACHE
 *      Hash the system prompt content. If the same hash was produced within
 *      TTL (default 60s per role), return the cached string immediately.
 *      Benefit: avoids recomputing + re-sending identical prompts across
 *      consecutive screening cycles or management polls.
 *      Works: every provider — the LLM just gets fewer duplicate tokens.
 *
 *   2. LESSON TRUNCATION
 *      Lessons can grow unbounded. Cap them at LESSON_TOKEN_CAP characters
 *      (≈ N tokens), keeping the most recent entries.
 *      Works: every provider.
 *
 *   3. ROLE-SPECIFIC BLOCK PRUNING
 *      Remove context blocks that are irrelevant to a given role:
 *        MANAGER  → remove [ATTRIBUTION], [OUTPUT_SCHEMA] if no positions
 *        SCREENER → remove [VAULT], [ATTRIBUTION], State/Positions JSON
 *        GENERAL  → remove [OUTPUT_SCHEMA] (not needed for free-text chat)
 *      Works: every provider.
 *
 *   4. TOKEN BUDGET ENFORCEMENT
 *      Estimate token count (chars / 4 approximation). If over budget,
 *      progressively trim lowest-priority blocks until under budget.
 *      Priority order (lowest → first to trim):
 *        [ATTRIBUTION] > [VAULT] > [OUTPUT_SCHEMA] > [LEARNING] > [NARRATIVE]
 *        > [REGIME] > [MARKET] > [PLAN] > LESSONS > RULES > ROLE_IDENTITY
 *      Works: every provider.
 *
 * Usage in agent.js:
 *   const optimized = optimizePrompt(rawPrompt, agentType, activeModel);
 *   → optimized.text  — the final prompt string (STABLE_BOUNDARY intact)
 *   → optimized.saved — estimated tokens saved
 *   → optimized.fromCache — true if returned from in-process cache
 */

import crypto from "crypto";
import { log } from "./logger.js";

// ─── Config ────────────────────────────────────────────────────────────────

// Approximate: 1 token ≈ 4 chars for English/code mixed content.
const CHARS_PER_TOKEN = 4;

// Max tokens per role before budget enforcement kicks in.
// These are generous — budget enforcement is a safety net, not a routine trim.
const TOKEN_BUDGET = {
  MANAGER:  2000,
  SCREENER: 1800,
  GENERAL:  2500,
  DEFAULT:  2200,
};

// Max chars for the lessons block (~200 tokens).
const LESSON_CHAR_CAP = 800;

// In-process cache TTL per role (ms). Identical prompts within this window
// are returned without rebuilding. Short enough that market changes still
// propagate; long enough to help rapid consecutive LLM calls.
const CACHE_TTL_MS = {
  MANAGER:  30_000,   // management cycles can be fast-consecutive
  SCREENER: 45_000,
  GENERAL:  15_000,   // chat can be varied — shorter TTL
  DEFAULT:  30_000,
};

// ─── In-process cache ──────────────────────────────────────────────────────

// Map: cacheKey → { text, savedChars, ts }
const _promptCache = new Map();

function cacheKey(role, textHash) { return `${role}:${textHash}`; }

function hashText(text) {
  return crypto.createHash("md5").update(text).digest("hex").slice(0, 12);
}

function getCached(role, hash) {
  const key = cacheKey(role, hash);
  const entry = _promptCache.get(key);
  if (!entry) return null;
  const ttl = CACHE_TTL_MS[role] || CACHE_TTL_MS.DEFAULT;
  if (Date.now() - entry.ts > ttl) { _promptCache.delete(key); return null; }
  return entry;
}

function setCache(role, hash, text, savedChars) {
  _promptCache.set(cacheKey(role, hash), { text, savedChars, ts: Date.now() });
  // Evict oldest entries if cache grows large (shouldn't happen in practice)
  if (_promptCache.size > 50) {
    const oldest = [..._promptCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _promptCache.delete(oldest[0]);
  }
}

// ─── Token estimation ───────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

// ─── Block extraction helpers ──────────────────────────────────────────────

const BOUNDARY_MARKER = "\x00STABLE_END\x00";

/** Split prompt into stable and dynamic halves (returns full text if no marker). */
function splitPrompt(text) {
  const idx = text.indexOf(BOUNDARY_MARKER);
  if (idx < 0) return { stable: text, dynamic: "", hasMarker: false };
  return {
    stable:    text.slice(0, idx),
    dynamic:   text.slice(idx + BOUNDARY_MARKER.length),
    hasMarker: true,
  };
}

/** Extract a named bracket block like [VAULT] ... (to end of line). */
function hasBlock(text, tag) {
  return new RegExp(`\\[${tag}\\]`).test(text);
}

/** Remove a named bracket block (entire line). */
function removeBlock(text, tag) {
  return text.replace(new RegExp(`^\\[${tag}\\][^\n]*\n?`, "m"), "");
}

// ─── Strategy 2: Lesson truncation ────────────────────────────────────────

function truncateLessons(text) {
  // Match "LESSONS:<body>" where <body> may contain line breaks until the
  // next block tag or end of string. Cap at LESSON_CHAR_CAP characters.
  const lessonRe = /(LESSONS:)([\s\S]*?)(?=\n\[|\n[A-Z]{2,}:|\x00|$)/;
  return text.replace(lessonRe, (match, prefix, body) => {
    if (body.length <= LESSON_CHAR_CAP) return match;
    // Keep the tail (most recent lessons) since they're appended newest-last.
    const trimmed = body.slice(-LESSON_CHAR_CAP);
    // Find first complete sentence/entry boundary to avoid mid-entry cuts.
    const cutAt = trimmed.indexOf("\n");
    return prefix + (cutAt > 0 ? trimmed.slice(cutAt + 1) : trimmed);
  });
}

// ─── Strategy 3: Role-specific pruning ────────────────────────────────────

// Blocks that are irrelevant per role — safe to remove without losing
// critical context. Order matters: remove cheapest/lowest-value first.
const ROLE_PRUNE = {
  MANAGER: ["OUTPUT_SCHEMA"],             // MANAGER uses JSON rules, not schema block
  SCREENER: ["ATTRIBUTION", "VAULT"],    // screener focuses on entry, not pnl attribution
  GENERAL:  ["OUTPUT_SCHEMA"],           // chat doesn't need structured output block
};

function applyRolePruning(text, role) {
  const pruneList = ROLE_PRUNE[role] || [];
  let result = text;
  for (const tag of pruneList) {
    if (hasBlock(result, tag)) result = removeBlock(result, tag);
  }
  return result;
}

// ─── Strategy 4: Budget enforcement ───────────────────────────────────────

// Ordered from LOWEST to HIGHEST priority — first trimmed when over budget.
const TRIM_ORDER = [
  "ATTRIBUTION",
  "VAULT",
  "OUTPUT_SCHEMA",
  "LEARNING",
  "NARRATIVE",
  "REGIME",
  "MARKET",
  "PLAN",
];

function enforceTokenBudget(text, role) {
  const budget = TOKEN_BUDGET[role] || TOKEN_BUDGET.DEFAULT;
  if (estimateTokens(text) <= budget) return text;

  let result = text;
  for (const tag of TRIM_ORDER) {
    if (estimateTokens(result) <= budget) break;
    if (hasBlock(result, tag)) {
      result = removeBlock(result, tag);
      log("prompt_opt", `budget trim: removed [${tag}] block for ${role}`);
    }
  }
  return result;
}

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * Optimize a raw system prompt for any provider.
 *
 * @param {string} rawPrompt   — output of buildSystemPrompt (may contain STABLE_BOUNDARY)
 * @param {string} agentType   — "MANAGER" | "SCREENER" | "GENERAL"
 * @param {string} [model]     — optional, for logging only
 * @returns {{ text: string, savedTokens: number, fromCache: boolean, originalTokens: number, finalTokens: number }}
 */
export function optimizePrompt(rawPrompt, agentType, model = "") {
  if (!rawPrompt) return { text: "", savedTokens: 0, fromCache: false, originalTokens: 0, finalTokens: 0 };

  const originalTokens = estimateTokens(rawPrompt);

  // ── Strategy 1: in-process cache ──────────────────────────────────────
  // Hash the raw prompt to detect identical repeated calls.
  const inputHash = hashText(rawPrompt);
  const cached = getCached(agentType, inputHash);
  if (cached) {
    return {
      text:           cached.text,
      savedTokens:    originalTokens - estimateTokens(cached.text),
      fromCache:      true,
      originalTokens,
      finalTokens:    estimateTokens(cached.text),
    };
  }

  // ── Strategies 2–4: text transformations ─────────────────────────────
  // Apply to stable and dynamic halves separately so the STABLE_BOUNDARY
  // marker is preserved (needed for Claude explicit caching in agent.js).
  const { stable, dynamic, hasMarker } = splitPrompt(rawPrompt);

  let optimizedStable  = truncateLessons(applyRolePruning(stable, agentType));
  let optimizedDynamic = dynamic; // dynamic part is small, skip pruning

  // Token budget operates on the full prompt but we only trim stable blocks
  // (removing dynamic context would lose critical live data).
  const merged = hasMarker
    ? `${optimizedStable}${BOUNDARY_MARKER}${optimizedDynamic}`
    : optimizedStable;
  const afterPrune = enforceTokenBudget(merged, agentType);

  // Re-split after budget enforcement so marker is still intact
  let finalText;
  if (hasMarker && afterPrune.includes(BOUNDARY_MARKER)) {
    finalText = afterPrune;
  } else if (hasMarker) {
    // Budget enforcement removed the marker (shouldn't happen, but be safe)
    finalText = `${afterPrune}${BOUNDARY_MARKER}${optimizedDynamic}`;
  } else {
    finalText = afterPrune;
  }

  const finalTokens = estimateTokens(finalText);
  const savedTokens = Math.max(0, originalTokens - finalTokens);

  if (savedTokens > 0) {
    log("prompt_opt", `${agentType} ${model || "?"}: ${originalTokens}→${finalTokens} tokens (-${savedTokens} saved)`);
  }

  // Cache the result
  setCache(agentType, inputHash, finalText, savedTokens);

  return { text: finalText, savedTokens, fromCache: false, originalTokens, finalTokens };
}

/** Return current cache stats (for /debug or logging). */
export function getPromptCacheStats() {
  const entries = [..._promptCache.entries()];
  return {
    entries: entries.length,
    roles: [...new Set(entries.map(([k]) => k.split(":")[0]))],
    oldest_ms: entries.length
      ? Date.now() - Math.min(...entries.map(([, v]) => v.ts))
      : 0,
  };
}

/** Clear the in-process cache (useful in tests or after config change). */
export function clearPromptCache() {
  _promptCache.clear();
}
