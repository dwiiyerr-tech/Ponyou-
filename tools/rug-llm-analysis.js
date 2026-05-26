/**
 * LLM-based Rug Analysis — for tokens in the ambiguous zone (rug score 25–55).
 *
 * Instead of a blind pass/fail, these tokens get a focused single-turn LLM analysis
 * that classifies risk and returns a confidence adjustment.
 *
 * Design:
 *   - Only fires when rug-memory has enough data (≥10 known rugs)
 *   - Single-turn completion, not multi-step agent loop
 *   - Timeout at 8 seconds — never block the screening cycle
 *   - Returns adjustment: positive → increase rug score, negative → decrease
 */

import { getLLMClient } from "../agent.js";
import { log } from "../logger.js";

const TIMEOUT_MS = 8000;
const MIN_RUG_CORPUS = 25; // 25+ known rugs before LLM analysis activates

/**
 * Build a concise prompt for the LLM to classify rug risk.
 */
function buildRugAnalysisPrompt(token, signals, anomaly) {
  const flags = [
    signals.freeze_authority && "freeze_authority",
    signals.mint_authority && "mint_authority",
    signals.transfer_hook && "transfer_hook",
    signals.permanent_delegate && "permanent_delegate",
    signals.non_transferable && "non_transferable",
    signals.lp_locked === false && "lp_unlocked",
    (signals.bundle_buyers_pct || 0) > 30 && `bundle_buyers_${signals.bundle_buyers_pct}%`,
    (signals.same_funder_holders || 0) >= 3 && `same_funder_${signals.same_funder_holders}`,
    (signals.fresh_funded_holders || 0) >= 5 && `fresh_holders_${signals.fresh_funded_holders}`,
    signals.supply_concentrated && `supply_concentrated_top20_${signals.top20_pct}%`,
    (signals.wash_score || 0) >= 30 && `wash_trade_${signals.wash_score}`,
    (signals.creator_pct || 0) > 20 && `creator_pct_${signals.creator_pct}%`,
  ].filter(Boolean);

  const anomalyLine = anomaly?.anomaly_detected
    ? `\n- ANOMALY: ${anomaly.anomaly_score}/100 similarity to known rugs. Closest: ${anomaly.closest_matches?.map(m => `${m.symbol}(${m.similarity})`).join(", ")}`
    : "";

  const top10 = signals.top10_concentration_pct || 0;
  const transferFee = signals.transfer_fee_bps || 0;

  return `Classify this Solana memecoin as SAFE, SUSPICIOUS, or RUG. One word answer then brief reason.

Token: ${token.symbol || "?"} (${token.mint?.slice(0, 8)})
MCap: $${(token.mcap || 0).toFixed(0)} | Liq: $${(token.liquidity || 0).toFixed(0)} | Age: ${token.age_minutes || "?"}min
Launchpad: ${token.launchpad || "unknown"}
Top10 holders: ${top10}% | Creator bag: ${signals.creator_pct || 0}%
Transfer fee: ${transferFee / 100}%
Active flags: ${flags.length > 0 ? flags.join(", ") : "none"}${anomalyLine}

Classification:`;
}

/**
 * Parse the LLM response into a numeric adjustment.
 */
function parseRugVerdict(text) {
  if (!text) return { verdict: "unknown", adjustment: 0 };
  const upper = text.toUpperCase();
  if (upper.includes("RUG") && !upper.includes("NOT RUG") && !upper.includes("ANTI-RUG")) {
    return { verdict: "rug", adjustment: 20 };
  }
  if (upper.includes("SUSPICIOUS")) {
    return { verdict: "suspicious", adjustment: 8 };
  }
  if (upper.includes("SAFE")) {
    return { verdict: "safe", adjustment: -5 };
  }
  return { verdict: "unknown", adjustment: 0 };
}

/**
 * Run LLM rug analysis on an ambiguous token.
 *
 * @param {Object} token — Token candidate with rug_signals attached
 * @param {Object} signals — rug_signals from gatherRugSignals()
 * @param {Object} anomaly — result from detectAnomaly()
 * @param {number} rugCorpusSize — how many known rugs exist
 * @returns {{ verdict: string, adjustment: number, reason: string, skipped: boolean }}
 */
export async function analyzeRugWithLLM(token, signals = {}, anomaly = null, rugCorpusSize = 0) {
  // Only fire when we have enough history for comparison
  if (rugCorpusSize < MIN_RUG_CORPUS) {
    return { verdict: "skipped", adjustment: 0, reason: "insufficient_rug_corpus", skipped: true };
  }

  const client = getLLMClient();
  if (!client) {
    return { verdict: "skipped", adjustment: 0, reason: "llm_client_unavailable", skipped: true };
  }

  const prompt = buildRugAnalysisPrompt(token, signals, anomaly);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "openrouter/auto",
      messages: [
        { role: "system", content: "You are a Solana memecoin rug detector. Analyze the token data and classify as SAFE, SUSPICIOUS, or RUG. Be concise. Prefer SUSPICIOUS when uncertain." },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 80,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const content = response?.choices?.[0]?.message?.content || "";
    const parsed = parseRugVerdict(content);
    log("rug_llm", `${token.symbol || token.mint?.slice(0, 8)}: LLM → ${parsed.verdict} (adj=${parsed.adjustment}) — "${content.slice(0, 60)}"`);
    return { ...parsed, reason: content.slice(0, 120), skipped: false };
  } catch (e) {
    log("rug_llm_warn", `${token.symbol || token.mint?.slice(0, 8)}: LLM analysis failed — ${e.message}`);
    return { verdict: "error", adjustment: 0, reason: e.message, skipped: true };
  }
}
