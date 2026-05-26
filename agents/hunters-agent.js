/**
 * Hunters Agent — No-LLM Token Discovery Workers ("kuli")
 *
 * Multiple hunting specializations, all deterministic:
 *   - Newest tokens (5m, 1h, 6h, 24h windows)
 *   - Trending tokens (multi-timeframe momentum)
 *   - Top volume tokens
 *   - Most transactions tokens
 *   - Top gainers (1m, 6h, 24h)
 *   - Ticker/narrative search
 *   - pump.fun ecosystem launches
 *
 * Zero LLM usage. Communicates via agent bus.
 * Can be commanded by Screening Agent based on market conditions.
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { runHunterExpedition, getCachedPrey, getHunterStats } from "../tools/hunter-agent.js";
import { log } from "../logger.js";

const AGENT_NAME = "hunters";

// Market-aware hunting schedule
const HUNTER_SCHEDULE = {
  EXTREME: { active: false, sources: [],            minScore: 0,  maxTokens: 0,  reason: "Market extreme" },
  HOT:     { active: true,  sources: ["all"],       minScore: 25, maxTokens: 25, reason: "Cast wide net" },
  NORMAL:  { active: true,  sources: ["all"],       minScore: 30, maxTokens: 15, reason: "Standard hunting" },
  COLD:    { active: true,  sources: ["pumpfun"],   minScore: 45, maxTokens: 8,  reason: "Tight filters — only pump.fun" },
  DEAD:    { active: false, sources: [],            minScore: 0,  maxTokens: 0,  reason: "No opportunities" },
};

let _currentSchedule = null;
let _initialized = false;

export function initHuntersAgent() {
  if (_initialized) return;
  _initialized = true;

  setAgentStatus(AGENT_NAME, "running", "Hunters agent initialized");

  // Listen for Screening Agent commands
  agentBus.subscribe("hunters:command", (cmd) => {
    log("hunters", `Command received: active=${cmd.active} sources=${cmd.sources} market=${cmd.marketCondition}`);
    _currentSchedule = cmd;
    updateAgentHealth(AGENT_NAME, {
      lastCommand: cmd,
      commandedAt: new Date().toISOString(),
    });
  });

  // Listen for market updates to adjust hunting
  agentBus.subscribe("market:update", (update) => {
    const condition = update?.condition || "NORMAL";
    const schedule = HUNTER_SCHEDULE[condition] || HUNTER_SCHEDULE.NORMAL;
    _currentSchedule = {
      active: schedule.active,
      sources: schedule.sources,
      minScore: schedule.minScore,
      maxTokens: schedule.maxTokens,
      marketCondition: condition,
      reason: schedule.reason,
    };
    log("hunters", `Market ${condition}: ${schedule.active ? `hunting (${schedule.sources.join(",")})` : `paused — ${schedule.reason}`}`);
  });

  // Listen for gate blocks — stop hunting immediately if kill switch or rug breaker trips
  agentBus.subscribe("hunters:gate_blocked", (payload) => {
    log("hunters", `Gate blocked — pausing: ${payload?.reason}`);
    _currentSchedule = { active: false, sources: [], reason: payload?.reason || "gate_blocked" };
    updateAgentHealth(AGENT_NAME, { lastGateBlock: payload?.reason, gateBlockedAt: new Date().toISOString() });
  });
}

export async function runHuntersExpedition({ strategy = null } = {}) {
  if (!_initialized) initHuntersAgent();

  // If screening agent explicitly deactivated hunting, skip
  if (_currentSchedule && _currentSchedule.active === false) {
    log("hunters", `Skipping — hunting deactivated (${_currentSchedule.reason || "no command"})`);
    return [];
  }

  // Build strategy from schedule if no explicit strategy provided
  const huntingStrategy = strategy || {
    minScore: _currentSchedule?.minScore || 30,
    maxTokens: _currentSchedule?.maxTokens || 15,
    sources: _currentSchedule?.sources || ["all"],
  };

  setAgentStatus(AGENT_NAME, "running");
  const startTime = Date.now();

  try {
    const prey = await runHunterExpedition({ strategy: huntingStrategy });

    if (prey.length > 0) {
      // Emit prey to bus for Screening Agent
      agentBus.emit("hunters:prey_ready", {
        prey,
        source: huntingStrategy.sources,
        marketCondition: _currentSchedule?.marketCondition || "UNKNOWN",
        timestamp: Date.now(),
      });

      const priority = prey.filter(p => p._hunter_score >= 50).length;
      log("hunters", `Prey dispatched: ${prey.length} tokens (${priority} priority) → bus`);
    }

    updateAgentHealth(AGENT_NAME, {
      lastExpedition: new Date().toISOString(),
      lastPreyCount: prey.length,
      lastDurationMs: Date.now() - startTime,
      hunterStats: getHunterStats(),
    });

    return prey;
  } catch (e) {
    log("hunters_error", `Expedition failed: ${e.message}`);
    updateAgentHealth(AGENT_NAME, { lastError: e.message });
    return [];
  }
}

export function getHuntersPrey() {
  return getCachedPrey();
}

export function getHuntersDashboard() {
  return {
    agent: {
      name: AGENT_NAME,
      role: "hunters",
      initialized: _initialized,
      schedule: _currentSchedule,
    },
    stats: getHunterStats(),
    schedule: HUNTER_SCHEDULE,
  };
}

export { HUNTER_SCHEDULE };
export default { initHuntersAgent, runHuntersExpedition, getHuntersPrey, getHuntersDashboard, HUNTER_SCHEDULE };
