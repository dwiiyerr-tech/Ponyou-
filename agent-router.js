"use strict";

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

const GEMINI_BIN = "/home/ubuntu/.npm-global/bin/gemini";
const RUFLO_BIN = "./node_modules/.bin/ruflo";
const VALID_AGENTS = new Set(["claude", "gemini", "codex"]);

const KEYWORDS = {
  // Gemini disabled — all research routes to Claude
  gemini: [],
  codex: [
    "write code", "implement", "function", "class", "algorithm",
    "debug", "refactor", "generate code", "create module", "unit test", "fix bug",
  ],
  claude: [
    "market", "trend", "research", "news", "search", "analyze", "sentiment",
    "what is", "explain", "compare", "outlook", "narrative", "hype",
    "community", "social", "twitter", "telegram", "reddit", "viral",
    "momentum", "catalyst",
    "buy", "sell", "trade", "position", "entry", "exit", "signal", "should i",
    "conviction", "decide", "risk", "kelly", "size", "exposure",
    "wallet", "portfolio", "drawdown",
  ],
};

function countMatches(text, keywords) {
  return keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
}

function classifyTask(prompt) {
  const norm = String(prompt || "").toLowerCase();
  const scores = {
    gemini: countMatches(norm, KEYWORDS.gemini),
    codex: countMatches(norm, KEYWORDS.codex),
    claude: countMatches(norm, KEYWORDS.claude),
  };
  const total = scores.gemini + scores.codex + scores.claude || 1;

  if (scores.codex > 0 && scores.codex >= scores.gemini && scores.codex >= scores.claude) {
    return { agent: "codex", confidence: +(scores.codex / total).toFixed(2), reason: "code" };
  }
  if (scores.gemini > scores.claude) {
    return { agent: "gemini", confidence: +(scores.gemini / total).toFixed(2), reason: "research" };
  }
  if (scores.claude > 0) {
    return { agent: "claude", confidence: +Math.min(0.95, 0.65 + scores.claude * 0.08).toFixed(2), reason: "trading" };
  }
  return { agent: "claude", confidence: 0.55, reason: "default" };
}

const MAX_CONSECUTIVE_FAILURES = 3;
const BREAKER_RESET_MS = 30 * 60 * 1000; // 30 min

class AgentRouter {
  #callLLM;
  #geminiBin;
  #rufloEnabled;
  #stats;
  #breaker;

  constructor({ callLLM, geminiBin, rufloEnabled = true } = {}) {
    this.#callLLM = typeof callLLM === "function" ? callLLM : null;
    this.#geminiBin = geminiBin || GEMINI_BIN;
    this.#rufloEnabled = Boolean(rufloEnabled);
    this.#stats = { calls: {}, errors: {}, avgDurationMs: {} };
    this.#breaker = new Map(); // agent → { failures, trippedAt }
  }

  // Legacy accessors for backward compat
  get callLLM() { return this.#callLLM; }
  set callLLM(v) { this.#callLLM = v; }
  get geminiBin() { return this.#geminiBin; }
  get rufloEnabled() { return this.#rufloEnabled; }
  get stats() { return this.#stats; }

  classify(prompt) {
    return classifyTask(prompt);
  }

  selectAgent(prompt, { preferAgent, minConfidence = 0.7, safetySensitive = false } = {}) {
    const cls = this.classify(prompt);
    if (VALID_AGENTS.has(preferAgent)) {
      return { agent: preferAgent, confidence: 1, reason: "override", classified: cls };
    }

    let agent = cls.agent;
    let reason = cls.reason;
    let confidence = cls.confidence;

    // Circuit breaker: if agent has tripped, skip it
    if (this.#isTripped(agent)) {
      reason = `breaker_tripped:${agent}`;
      agent = "claude";
      confidence = 0.90;
    }

    if ((safetySensitive || cls.confidence < minConfidence) && agent !== "claude") {
      agent = "claude";
      reason = safetySensitive ? "safety_sensitive" : "low_confidence_escalation";
      confidence = Math.max(confidence, minConfidence);
    }

    return { agent, confidence, reason, classified: cls };
  }

  #updateStats(agent, durationMs, hadError) {
    const n = (this.#stats.calls[agent] || 0) + 1;
    const prev = this.#stats.avgDurationMs[agent] || 0;
    this.#stats.calls[agent] = n;
    this.#stats.avgDurationMs[agent] = Math.round((prev * (n - 1) + durationMs) / n);
    if (hadError) this.#stats.errors[agent] = (this.#stats.errors[agent] || 0) + 1;
  }

  #isTripped(agent) {
    const b = this.#breaker.get(agent);
    if (!b) return false;
    if (Date.now() - b.trippedAt > BREAKER_RESET_MS) {
      this.#breaker.delete(agent);
      return false;
    }
    return true;
  }

  #recordFailure(agent) {
    let b = this.#breaker.get(agent);
    if (!b) b = { failures: 0, trippedAt: 0 };
    b.failures++;
    if (b.failures >= MAX_CONSECUTIVE_FAILURES) {
      b.trippedAt = Date.now();
      console.warn(`[Router] Circuit breaker TRIPPED for ${agent} after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Blocking ${agent} for ${BREAKER_RESET_MS / 60000}min.`);
    }
    this.#breaker.set(agent, b);
  }

  #recordSuccess(agent) {
    this.#breaker.delete(agent);
  }

  async #callClaude(prompt, systemPrompt) {
    if (!this.#callLLM) throw new Error("callLLM not injected");
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });
    const r = await this.#callLLM(messages);
    return typeof r === "string" ? r.trim() : String(r ?? "").trim();
  }

  async #callGemini(prompt, timeoutMs = 60_000) {
    const { stdout, stderr } = await execFile(this.#geminiBin, ["-p", prompt], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    // Log stderr for diagnostics — Gemini CLI errors appear here.
    // AR-5: ignore well-known quota / unactionable noise; everything else
    // surfaces so a misconfigured CLI / auth failure is visible.
    if (stderr && String(stderr).trim()) {
      const stderrTrimmed = String(stderr).slice(0, 300);
      const lower = stderrTrimmed.toLowerCase();
      const isNoise = lower.includes("quota") || lower.includes("429");
      if (!isNoise) {
        console.warn(`[Router] Gemini stderr: ${stderrTrimmed}`);
      }
    }
    const result = String(stdout || "").trim();
    if (!result) throw new Error("Empty response from gemini agent");
    return result;
  }

  async #callCodex(prompt, timeoutMs = 90_000) {
    // AR-7: try several locations so we work on dev boxes, shared hosts, and
    // CI without hardcoding a single homedir. The PATH-resolved "codex"
    // entry handles the case where the bin is on the system PATH (npm
    // install -g, brew, apt, etc.).
    const env = process.env;
    const candidates = [
      env.PONYOU_CODEX_BIN,
      env.CODEX_BIN,
      env.HOME ? `${env.HOME}/.npm-global/bin/codex` : null,
      "/usr/local/bin/codex",
      "codex",                  // last resort: rely on PATH
    ].filter(Boolean);
    let lastErr;
    for (const bin of candidates) {
      try {
        const { stdout } = await execFile(bin, [prompt], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
        const result = String(stdout || "").trim();
        if (!result) throw new Error("Empty response from codex agent");
        return result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Codex binary not found (set PONYOU_CODEX_BIN or install codex on PATH)");
  }

  async invoke(prompt, { preferAgent, systemPrompt, timeoutMs, confidenceGate = {} } = {}) {
    const selection = this.selectAgent(prompt, {
      preferAgent,
      minConfidence: confidenceGate.minConfidence ?? 0.7,
      safetySensitive: confidenceGate.safetySensitive ?? false,
    });
    const { agent, confidence, reason } = selection;
    const t0 = Date.now();
    try {
      let result = "";
      let lastError = null;
      let terminalError = false;
      for (let attempt = 0; attempt < 2 && !terminalError; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
          if (agent === "gemini") result = await this.#callGemini(prompt, timeoutMs);
          else if (agent === "codex") result = await this.#callCodex(prompt, timeoutMs);
          else result = await this.#callClaude(prompt, systemPrompt);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
          // Don't retry on quota/limit errors — they won't resolve in 2 seconds
          if (msg.includes("quota") || msg.includes("exhausted") || msg.includes("capacity")) {
            terminalError = true;
          }
        }
      }
      // Jika retry fail dan agent bukan claude, coba fallback ke claude
      if (lastError && agent !== "claude" && this.#callLLM) {
        const primaryErr = lastError;
        try {
          result = await this.#callClaude(prompt, systemPrompt);
          const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
          console.warn(`[Router] Fallback to claude after ${agent} failed: ${errMsg.slice(0, 120)}`);
          lastError = null;
        } catch (fallbackErr) {
          // AR-10: preserve the primary agent's error too — without this,
          // the operator only saw the fallback's error message and the
          // root cause from the primary agent was silently lost.
          const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          const composed = new Error(
            `Both ${agent} and claude failed. ${agent}: ${primaryMsg.slice(0, 120)} | claude: ${fallbackMsg.slice(0, 120)}`,
          );
          composed.primaryAgent = agent;
          composed.primaryError = primaryErr;
          composed.fallbackError = fallbackErr;
          lastError = composed;
        }
      } else if (lastError && agent !== "claude" && !this.#callLLM) {
        console.warn("[Router] Fallback to claude skipped: callLLM not injected");
      }
      if (lastError) {
        this.#recordFailure(agent);
        throw lastError;
      }

      this.#recordSuccess(agent);
      const durationMs = Date.now() - t0;
      this.#updateStats(agent, durationMs, false);
      console.log(`[Router] → ${agent} (${reason}: ${confidence}) [${durationMs}ms]`);
      return { result, agent, durationMs, error: null, classified: selection.classified, selected: selection };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      this.#updateStats(agent, durationMs, true);
      // Truncate error message to avoid log spam
      console.error(`[Router] → ${agent} ERROR: ${message.slice(0, 200)}`);
      return { result: "", agent, durationMs, error: message };
    }
  }

  async feedback(agent, taskType, success) {
    if (!this.rufloEnabled) return;
    try {
      await execFile(
        RUFLO_BIN,
        ["route", "feedback", "--agent", String(agent), "--task-type", String(taskType), "--success", String(Boolean(success))],
        { timeout: 15_000 },
      );
    } catch { /* silent */ }
  }

  getStats() {
    return {
      calls: { ...this.stats.calls },
      errors: { ...this.stats.errors },
      avgDurationMs: { ...this.stats.avgDurationMs },
    };
  }
}

export default AgentRouter;
export { AgentRouter };
