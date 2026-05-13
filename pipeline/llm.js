/**
 * Pipeline LLM Screening
 * Inspired by Charon (yunus-0x/charon) pipeline/llm.js
 *
 * Batch-screens up to 10 candidates in a single LLM call.
 * Returns: { verdict: BUY|WATCH|PASS, confidence, tp_pct, sl_pct, reason }
 */

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { config } from "../config.js";
import { compactCandidateForLlm } from "./candidateBuilder.js";
import { getActiveStrategyName, getActiveStrategy } from "../strategy.js";
import { getLessonsForPrompt } from "../lessons.js";
import { log } from "../logger.js";

const DEFAULT_LLM_TIMEOUT = 60_000;

function buildClient() {
  return new OpenAI({
    baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
    timeout: DEFAULT_LLM_TIMEOUT,
  });
}

// ─── Normalize Decision ───────────────────────────────────────

function normalizeDecision(raw) {
  const safe = {
    verdict: "WATCH",
    confidence: 0,
    tp_pct: null,
    sl_pct: null,
    reason: "No reason provided.",
  };

  if (!raw || typeof raw !== "object") return safe;

  const verdict = String(raw.verdict || raw.action || "WATCH").toUpperCase();
  safe.verdict = ["BUY", "WATCH", "PASS"].includes(verdict) ? verdict : "WATCH";
  safe.confidence = Math.min(100, Math.max(0, Number(raw.confidence || raw.score || 0)));
  safe.tp_pct = raw.tp_pct != null ? Number(raw.tp_pct) : null;
  safe.sl_pct = raw.sl_pct != null ? Number(raw.sl_pct) : null;
  safe.reason = String(raw.reason || raw.explanation || "").slice(0, 500) || "No reason.";

  return safe;
}

// ─── Batch Decision ───────────────────────────────────────────

/**
 * Decide on a batch of up to 10 candidates.
 * Returns array of { mint, ...decision } or null if LLM disabled.
 */
export async function decideCandidateBatch(candidates) {
  if (!candidates || candidates.length === 0) return [];

  const model = config.llm?.screeningModel || process.env.LLM_MODEL || "minimax/minimax-m2.5";
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    log("pipeline_llm", "LLM disabled (no API key) — defaulting WATCH for all");
    return candidates.map(c => ({ mint: c.mint, symbol: c.symbol, verdict: "WATCH", confidence: 0, reason: "LLM disabled." }));
  }

  const strategyName = getActiveStrategyName();
  const stratConfig = getActiveStrategy();
  const lessons = getLessonsForPrompt({ agentType: "SCREENER" });
  const lessonsText = lessons?.slice(0, 800) || "";

  const compacted = candidates.slice(0, 10).map(c => compactCandidateForLlm(c));

  const systemPrompt = [
    `You are a Solana meme coin trench analyst.`,
    `Active strategy: ${strategyName} — ${stratConfig.name}: ${stratConfig.description}`,
    `Stoploss: ${(stratConfig.stoploss * 100).toFixed(0)}%, Max flags: ${stratConfig.filters.maxAllowedFlags}`,
    lessonsText ? `\nLessons learned:\n${lessonsText}` : "",
    `\nReview the candidates and return JSON array with one object per candidate:`,
    `[{ "mint": "...", "verdict": "BUY|WATCH|PASS", "confidence": 0-100, "tp_pct": number|null, "sl_pct": number|null, "reason": "..." }]`,
    `Rules:`,
    `- Only ONE candidate can have verdict BUY. Pick the single best opportunity, or WATCH/PASS all if none qualify.`,
    `- BUY requires confidence >= 65.`,
    `- PASS = definitely avoid. WATCH = interesting but don't buy now.`,
    `- tp_pct/sl_pct are your suggested take-profit/stop-loss percentages.`,
    `- Be brief in reason (max 80 chars).`,
    `- Return ONLY valid JSON array. No markdown, no explanation.`,
  ].filter(Boolean).join("\n");

  const userPrompt = `Candidates:\n${JSON.stringify(compacted, null, 2)}`;

  try {
    const client = buildClient();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    const text = response.choices?.[0]?.message?.content || "[]";
    const repaired = jsonrepair(text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
    const raw = JSON.parse(repaired);

    if (!Array.isArray(raw)) {
      log("pipeline_llm", "LLM returned non-array — defaulting WATCH");
      return candidates.map(c => ({ mint: c.mint, symbol: c.symbol, ...normalizeDecision(null) }));
    }

    // Merge decisions back with candidates, enforce single BUY
    let buyCount = 0;
    return candidates.map(c => {
      const decision = raw.find(d => d.mint === c.mint) || {};
      const normalized = normalizeDecision(decision);
      if (normalized.verdict === "BUY") {
        buyCount++;
        if (buyCount > 1) normalized.verdict = "WATCH"; // Only allow 1 BUY
      }
      return { mint: c.mint, symbol: c.symbol, ...normalized };
    });
  } catch (err) {
    log("pipeline_llm", `Batch LLM failed: ${err.message} — defaulting WATCH`);
    return candidates.map(c => ({ mint: c.mint, symbol: c.symbol, verdict: "WATCH", confidence: 0, reason: `LLM error: ${err.message.slice(0, 60)}` }));
  }
}

/**
 * Decide on a single candidate (wraps batch).
 */
export async function decideCandidate(candidate) {
  const results = await decideCandidateBatch([candidate]);
  return results[0] || { mint: candidate.mint, symbol: candidate.symbol, verdict: "WATCH", confidence: 0, reason: "No decision." };
}
