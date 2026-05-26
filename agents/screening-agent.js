/**
 * Screening Agent — Pipeline Orchestrator (minimal LLM)
 *
 * Orchestrates Hunters based on market conditions, runs the
 * screening pipeline (trash filter → rug signals → conviction →
 * Kelly → decision), and delegates final ambiguous decisions
 * to the General Agent via the bus.
 *
 * Market-aware: commands Hunters to hunt more aggressively
 * in HOT markets, pulls back in COLD/DEAD.
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { log } from "../logger.js";

const AGENT_NAME = "screening";

let _runScreeningCycle = null;
let _checkAllGates = null;
let _initialized = false;

// Market-aware hunter command thresholds
const HUNTER_TRIGGER = {
  EXTREME: { command: false },
  HOT:     { command: true, sources: ["search", "pumpfun", "jupiter"], minScore: 25, maxTokens: 25 },
  NORMAL:  { command: true, sources: ["search", "pumpfun"],           minScore: 30, maxTokens: 15 },
  COLD:    { command: true, sources: ["pumpfun"],                      minScore: 45, maxTokens: 8 },
  DEAD:    { command: false },
};

let _lastMarketCondition = null;

export function initScreeningAgent({ runScreeningCycle, checkAllGates }) {
  if (_initialized) return;
  _initialized = true;

  _runScreeningCycle = runScreeningCycle;
  _checkAllGates = checkAllGates;

  setAgentStatus(AGENT_NAME, "running", "Screening agent initialized");

  // Listen for cleaned prey from Trash Layer → inject into pipeline
  // Trash Layer already filtered: no supply_invalid, no dust, no RugCheck blocks
  agentBus.subscribe("trash:cleaned_prey", (payload) => {
    const tokens = payload?.tokens || [];
    const stats = payload?.stats || {};
    updateAgentHealth(AGENT_NAME, {
      lastPreyReceived: new Date().toISOString(),
      preyCount: tokens.length,
      trashStats: stats,
    });
    log("screening", `Received ${tokens.length} cleaned tokens from Trash Layer (${stats.passed}/${stats.total} passed)`);
  });

  // Listen for market changes
  agentBus.subscribe("market:update", (update) => {
    onMarketUpdate(update);
  });

  // Listen for gate blocks — stop pipeline if blocked
  agentBus.subscribe("screening:gate_blocked", (payload) => {
    log("screening", `Gate blocked — pipeline paused: ${payload?.reason}`);
    updateAgentHealth(AGENT_NAME, {
      lastGateBlock: payload?.reason,
      gateBlockedAt: new Date().toISOString(),
    });
  });
}

function onMarketUpdate(update) {
  const condition = update?.condition || "NORMAL";

  // Only command hunters when market actually changes
  if (condition === _lastMarketCondition) return;
  _lastMarketCondition = condition;

  const trigger = HUNTER_TRIGGER[condition] || HUNTER_TRIGGER.NORMAL;

  if (trigger.command) {
    log("screening", `Market ${condition}: commanding Hunters (${trigger.sources.join(",")})`);
    agentBus.emit("hunters:command", {
      active: true,
      sources: trigger.sources,
      minScore: trigger.minScore,
      maxTokens: trigger.maxTokens,
      marketCondition: condition,
    });
  } else {
    log("screening", `Market ${condition}: pausing Hunters`);
    agentBus.emit("hunters:command", {
      active: false,
      reason: `Market ${condition} — no hunting`,
      marketCondition: condition,
    });
  }
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (!_runScreeningCycle) {
    log("screening_error", "Screening agent not initialized");
    return "Screening agent not initialized";
  }

  const gate = await _checkAllGates("screening");
  if (gate.blocked) {
    updateAgentHealth(AGENT_NAME, { lastGateBlock: gate.reason });
    return gate.reason;
  }

  setAgentStatus(AGENT_NAME, "running");

  try {
    // Emit candidate broadcast before running
    agentBus.emit("screening:cycle_start", { silent, timestamp: Date.now() });

    const result = await _runScreeningCycle({ silent });

    updateAgentHealth(AGENT_NAME, {
      lastRun: new Date().toISOString(),
      lastResult: typeof result === "string" ? result.slice(0, 100) : "ok",
    });

    return result;
  } catch (e) {
    log("screening_error", e.message);
    updateAgentHealth(AGENT_NAME, { lastError: e.message });
    return `Error: ${e.message}`;
  }
}

export function getScreeningDashboard() {
  return {
    agent: {
      name: AGENT_NAME,
      role: "screening",
      initialized: _initialized,
    },
    marketCondition: _lastMarketCondition,
    hunterTriggers: HUNTER_TRIGGER,
  };
}

export { HUNTER_TRIGGER };
export default { initScreeningAgent, runScreeningCycle, getScreeningDashboard, HUNTER_TRIGGER };
