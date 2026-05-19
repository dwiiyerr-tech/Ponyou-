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
    return { agent: "claude", confidence: +(0.65 + scores.claude * 0.08).toFixed(2), reason: "trading" };
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

  async _callGemini(prompt, timeoutMs = 90_000) {
    const { stdout } = await execFile(this.geminiBin, ["-p", prompt], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(stdout || "").trim();
  }

  async _callCodex(prompt, timeoutMs = 120_000) {
    const bins = ["/home/ubuntu/.npm-global/bin/codex", "codex"].filter(Boolean);
    let lastErr;
    for (const bin of bins) {
      try {
        const { stdout } = await execFile(bin, [prompt], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
        return String(stdout || "").trim();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Codex binary not found");
  }

  async invoke(prompt, { preferAgent, systemPrompt, timeoutMs } = {}) {
    const cls = this.classify(prompt);
    const agent = VALID_AGENTS.has(preferAgent) ? preferAgent : cls.agent;
    const reason = VALID_AGENTS.has(preferAgent) ? "override" : cls.reason;
    const confidence = VALID_AGENTS.has(preferAgent) ? 1 : cls.confidence;
    const t0 = Date.now();
    try {
      let result = "";
      if (agent === "gemini") result = await this._callGemini(prompt, timeoutMs);
      else if (agent === "codex") result = await this._callCodex(prompt, timeoutMs);
      else result = await this._callClaude(prompt, systemPrompt);

      const durationMs = Date.now() - t0;
      this._updateStats(agent, durationMs, false);
      console.log(`[Router] → ${agent} (${reason}: ${confidence}) [${durationMs}ms]`);
      return { result, agent, durationMs, error: null };
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
