/**
 * General Agent — Full Ponyou Assistant & Chat Interface
 *
 * Handles ALL non-trading tasks in Ponyou:
 *   - Telegram chat & inbox replies
 *   - Dashboard queries (/pnl, /status, /help, /agents, /rules, /features)
 *   - Market analysis requests ("how's the market?", "trending?")
 *   - Feature explanations ("what is conviction?", "how does trash filter work?")
 *   - Debug assistance ("why didn't this trade execute?", "check logs")
 *   - Documentation lookup (reads CLAUDE.md, operator-checklist, etc.)
 *   - Agent status queries
 *   - Performance reporting
 *   - Operator assistance ("what should I do about X?")
 *
 * Does NOT make BUY/SELL decisions — those are owned by Management Agent.
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth, getAllAgentStatuses } from "./agent-registry.js";
import { log } from "../logger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const AGENT_NAME = "general";

let _agentLoop = null;
let _config = null;
let _initialized = false;
let _chatHistory = [];

// ── Built-in Knowledge Base ────────────────────────────────────

function loadKnowledgeBase() {
  const docs = {};
  const docFiles = [
    "CLAUDE.md",
    "docs/operator-checklist.md",
    "docs/model-routing.md",
  ];

  for (const file of docFiles) {
    try {
      const fp = path.join(PROJECT_ROOT, file);
      if (fs.existsSync(fp)) {
        docs[file] = fs.readFileSync(fp, "utf8").slice(0, 3000); // first 3KB
      }
    } catch {}
  }

  return docs;
}

// ── Quick Response Templates ───────────────────────────────────

const QUICK_RESPONSES = {
  help: `Ponyou Commands:
/status — Bot status & market
/pnl — Recent P&L
/automation_status — Full automation status
/qualification — Automation requirements progress
/agents — Agent system status
/rules — Active strategy rules
/features — Feature registry status
/help — This message`,

  features: () => {
    try {
      const summary = "Feature Registry: conviction (0.30), narrative_velocity (0.20), cross_batch_velocity (0.12), kelly_edge (0.15), technicals (0.10), rug_risk (0.15), workflow_verdict (0.05), cabal_risk (0.10)";
      return summary;
    } catch { return "Feature registry unavailable."; }
  },

  agents: () => {
    try {
      const agents = getAllAgentStatuses();
      return `Agent System (${agents.length} agents):\n${agents.map(a => `  ${a.name} [${a.role}]: ${a.status}`).join("\n")}`;
    } catch { return "Agent status unavailable."; }
  },

  rules: () => {
    return "Strategy rules: Use /strategy to view active strategy. Use /strategies to list all. Switch: /strategy <id>";
  },
};

// ─── Init ──────────────────────────────────────────────────────

export function initGeneralAgent({ agentLoop, config }) {
  if (_initialized) return;
  _initialized = true;

  _agentLoop = agentLoop;
  _config = config;

  setAgentStatus(AGENT_NAME, "running", "General agent — full Ponyou assistant");

  // ── Telegram messages → smart routing ──
  agentBus.on("general:telegram", async (payload) => {
    const reqId = payload?._reqId;
    if (!reqId) return;

    const text = payload?.text?.trim() || "";
    log("general", `Message: ${text.slice(0, 60)}...`);

    // Check for quick commands first
    const quickResponse = handleQuickCommand(text);
    if (quickResponse) {
      updateAgentHealth(AGENT_NAME, { lastResponse: new Date().toISOString(), responseType: "quick" });
      agentBus.respond(reqId, { response: quickResponse });
      return;
    }

    // Route to LLM for complex queries
    try {
      const kb = loadKnowledgeBase();
      const enrichedPrompt = `You are Ponyou, a Solana memecoin trading bot assistant.

CONTEXT (Ponyou documentation):
${kb["CLAUDE.md"]?.slice(0, 1000) || ""}

USER: ${text}

Answer concisely. If the user asks about Ponyou features, explain using the documentation above.
If asked to execute a trade, remind them that BUY/SELL decisions are made by the Management Agent.`;

      const { content } = await _agentLoop(
        enrichedPrompt,
        _config?.llm?.maxSteps || 5,
        [],
        "GENERAL",
        _config?.llm?.generalModel,
        1024
      );

      updateAgentHealth(AGENT_NAME, {
        lastResponse: new Date().toISOString(),
        responseType: "llm",
      });

      agentBus.respond(reqId, { response: content });
    } catch (e) {
      log("general_error", `LLM response failed: ${e.message}`);
      agentBus.respond(reqId, {
        response: `I understand you're asking about "${text.slice(0, 50)}...". My LLM is currently unavailable. Try /help for available commands.`
      });
    }
  });

  // ── Dashboard queries ──
  agentBus.on("general:dashboard_query", async (payload) => {
    const reqId = payload?._reqId;
    if (!reqId) return;
    const query = payload?.query || "";
    const response = handleQuickCommand(query) || `Query received: ${query}`;
    agentBus.respond(reqId, { response });
  });
}

// ─── Quick Command Handler ─────────────────────────────────────

function handleQuickCommand(text) {
  const cmd = text.toLowerCase().trim();

  if (cmd === "/help" || cmd === "help") return QUICK_RESPONSES.help;
  if (cmd === "/agents" || cmd === "agents") return QUICK_RESPONSES.agents();
  if (cmd === "/rules" || cmd === "rules") return QUICK_RESPONSES.rules();

  // Feature explanations (no LLM needed)
  if (cmd.includes("conviction")) {
    return "Conviction is Ponyou's belief score (0-100) for coins/narratives, built from repeated observations and trade outcomes. It gates entry (shadow/probe/active), sizes positions (Kelly mode), and decays 12%/day. Strong conviction (>=70) can reduce caution by 12 points.";
  }
  if (cmd.includes("trash") || cmd.includes("filter")) {
    return "Trash Filter is Ponyou's first defense layer. It checks: minimum liquidity ($500), swaps (>0), market cap (>$1k), Token-2022 extensions, scam name patterns, and RugCheck.xyz score. Market condition multipliers make it stricter in DEAD/COLD markets.";
  }
  if (cmd.includes("kelly")) {
    return "Kelly Criterion sizes positions based on edge probability. Mode 1 (Conservative): bankroll/slots. Mode 2 (Adaptive, requires conviction >=0.70). Mode 3 (Full Kelly, requires conviction >=0.99). Fractional Kelly (0.5) limits exposure.";
  }
  if (cmd.includes("hunter") || cmd.includes("hunters")) {
    return "Hunters Agent searches for tokens across: DexScreener (15 query keywords), pump.fun ecosystem, and Jupiter active pairs. No LLM — pure API calls + 5-dimension scoring (liquidity, volume, flow, age, mcap). Controlled by Screening Agent based on market conditions.";
  }
  if (cmd.includes("orchestrator") || cmd.includes("automation")) {
    return "Pro Orchestrator is the elite automation layer. Locked until: 1000h market exposure, 500+ trades, 100+ conviction samples, 50+ lessons, 30+ rug patterns, 4 regimes observed, >=45% WR, 3+ evolved strategies. Check progress: /qualification";
  }

  return null; // No quick match — route to LLM
}

// ─── Export ────────────────────────────────────────────────────

export function isGeneralAgentReady() {
  return _initialized && !!_agentLoop;
}

export function getGeneralAgentStatus() {
  return {
    name: AGENT_NAME,
    role: "general",
    initialized: _initialized,
    llmReady: !!_agentLoop,
    description: "Full Ponyou assistant — chat, Telegram, help, feature explanations",
    quickCommands: Object.keys(QUICK_RESPONSES).length,
  };
}

export default { initGeneralAgent, isGeneralAgentReady, getGeneralAgentStatus };
