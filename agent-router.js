"use strict";

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

const GEMINI_BIN = "/home/ubuntu/.npm-global/bin/gemini";
const RUFLO_BIN = "./node_modules/.bin/ruflo";
const VALID_AGENTS = new Set(["claude", "gemini", "codex"]);

const KEYWORDS = {
  gemini: [
    "market", "trend", "research", "news", "search", "analyze", "sentiment",
    "what is", "explain", "compare", "outlook", "narrative", "hype",
    "community", "social", "twitter", "telegram", "reddit", "viral",
    "momentum", "catalyst",
  ],
  codex: [
    "write code", "implement", "function", "class", "algorithm",
    "debug", "refactor", "generate code", "create module", "unit test", "fix bug",
  ],
  claude: [
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

class AgentRouter {
  constructor({ callLLM, geminiBin, rufloEnabled = true } = {}) {
    this.callLLM = typeof callLLM === "function" ? callLLM : null;
    this.geminiBin = geminiBin || GEMINI_BIN;
    this.rufloEnabled = Boolean(rufloEnabled);
    this.stats = { calls: {}, errors: {}, avgDurationMs: {} };
  }

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

    if ((safetySensitive || cls.confidence < minConfidence) && cls.agent !== "claude") {
      agent = "claude";
      reason = safetySensitive ? "safety_sensitive" : "low_confidence_escalation";
      confidence = Math.max(confidence, minConfidence);
    }

    return { agent, confidence, reason, classified: cls };
  }

  _updateStats(agent, durationMs, hadError) {
    const n = (this.stats.calls[agent] || 0) + 1;
    const prev = this.stats.avgDurationMs[agent] || 0;
    this.stats.calls[agent] = n;
    this.stats.avgDurationMs[agent] = Math.round((prev * (n - 1) + durationMs) / n);
    if (hadError) this.stats.errors[agent] = (this.stats.errors[agent] || 0) + 1;
  }

  async _callClaude(prompt, systemPrompt) {
    if (!this.callLLM) throw new Error("callLLM not injected");
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });
    const r = await this.callLLM(messages);
    return typeof r === "string" ? r.trim() : String(r ?? "").trim();
  }

  async _callGemini(prompt, timeoutMs = 60_000) {
    const { stdout } = await execFile(this.geminiBin, ["-p", prompt], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = String(stdout || "").trim();
    if (!result) throw new Error("Empty response from agent");
    return result;
  }

  async _callCodex(prompt, timeoutMs = 90_000) {
    const bins = ["/home/ubuntu/.npm-global/bin/codex", "codex"].filter(Boolean);
    let lastErr;
    for (const bin of bins) {
      try {
        const { stdout } = await execFile(bin, [prompt], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
        const result = String(stdout || "").trim();
        if (!result) throw new Error("Empty response from agent");
        return result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Codex binary not found");
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
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
          if (agent === "gemini") result = await this._callGemini(prompt, timeoutMs);
          else if (agent === "codex") result = await this._callCodex(prompt, timeoutMs);
          else result = await this._callClaude(prompt, systemPrompt);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      // Jika retry fail dan agent bukan claude, coba fallback ke claude
      if (lastError && agent !== "claude" && this.callLLM) {
        try {
          result = await this._callClaude(prompt, systemPrompt);
          console.warn(`[Router] Fallback to claude after ${agent} failed: ${lastError.message}`);
          lastError = null;
        } catch (fallbackErr) {
          lastError = fallbackErr;
        }
      } else if (lastError && agent !== "claude" && !this.callLLM) {
        console.warn("[Router] Fallback to claude skipped: callLLM not injected");
      }
      if (lastError) throw lastError;

      const durationMs = Date.now() - t0;
      this._updateStats(agent, durationMs, false);
      console.log(`[Router] → ${agent} (${reason}: ${confidence}) [${durationMs}ms]`);
      return { result, agent, durationMs, error: null, classified: selection.classified, selected: selection };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      this._updateStats(agent, durationMs, true);
      console.error(`[Router] → ${agent} ERROR: ${message}`);
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
