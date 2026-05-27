/**
 * Orchestrator Agent — Full Automation Workflow Manager
 *
 * Sits ABOVE all other agents. Coordinates the full pipeline:
 *   Market → Strategy Selection → Hunters → Trash → Screening → Management
 *
 * Responsibilities:
 *   1. Strategy auto-selection based on market regime + performance data
 *   2. Workflow orchestration: when to hunt, when to screen, when to trade
 *   3. Strategy rotation: switch strategies when performance degrades
 *   4. Market-aware pipeline control: aggressive in HOT, conservative in COLD
 *   5. Performance feedback loop: trade outcomes → strategy weight adjustment
 *   6. Full automation mode: no human intervention needed for routine ops
 *
 * Strategy Selection Rules:
 *   - NORMAL/HOT market → aggressive strategies (scalping, momentum)
 *   - COLD market → conservative strategies (fundamental, conviction-based)
 *   - DEAD/EXTREME → no trading, all agents paused
 *   - Switch strategy if win_rate drops below degradationThreshold (0.75)
 *   - Conviction >= 0.80 required for provisional strategies
 *   - Auto-approve strategies with conviction >= 0.95 AND 30+ days data
 *
 * Bus events:
 *   orchestrator:strategy_switch    — Strategy changed
 *   orchestrator:market_adapt      — Pipeline adapted to market
 *   orchestrator:full_cycle        — Complete automation cycle done
 *   orchestrator:emergency_pause   — All trading paused
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth, getDashboardSummary } from "./agent-registry.js";
import { log } from "../logger.js";

const AGENT_NAME = "orchestrator";

let _initialized = false;
let _activeStrategy = null;
let _strategyHistory = [];
let _lastMarketCondition = null;
let _fullAutomationMode = false;
let _proIntel = null; // latest pro-orchestrator intelligence (regimes, narratives, strategies)
let _tradeCount = 0;  // closed trades observed via management:llm_exit_executed
const PRO_INTEL_MAX_AGE_MS = 10 * 60_000; // stale after 10 min
const STRATEGY_HISTORY_CAP = 100;        // prevent unbounded growth in long-running bot

// Strategy selection rules per market regime
const STRATEGY_RULES = {
  EXTREME: { trade: false, reason: "Market extreme — all trading paused" },
  HOT:     { trade: true,  preferTypes: ["scalping", "momentum", "narrative"], maxPositions: 3, aggressiveness: "high" },
  NORMAL:  { trade: true,  preferTypes: ["scalping", "fundamental", "conviction"], maxPositions: 2, aggressiveness: "normal" },
  COLD:    { trade: true,  preferTypes: ["fundamental", "conviction"], maxPositions: 1, aggressiveness: "low" },
  DEAD:    { trade: false, reason: "Market dead — no opportunities" },
};

export function initOrchestratorAgent({ getStrategyFn, getMarketIntelFn } = {}) {
  if (_initialized) return;
  _initialized = true;

  setAgentStatus(AGENT_NAME, "running", "Orchestrator active — full automation workflow manager");

  // ── Listen for market changes → adapt strategy ──
  agentBus.subscribe("market:update", (update) => {
    const condition = update?.condition || "NORMAL";
    if (condition === _lastMarketCondition) return;

    const rules = STRATEGY_RULES[condition] || STRATEGY_RULES.NORMAL;
    _lastMarketCondition = condition;

    if (!rules.trade) {
      log("orchestrator", `Market ${condition}: ${rules.reason} — pausing all agents`);
      agentBus.emit("orchestrator:emergency_pause", {
        condition,
        reason: rules.reason,
        timestamp: Date.now(),
      });
    } else {
      log("orchestrator", `Market ${condition}: trading active — ${rules.preferTypes.join(",")} | ${rules.aggressiveness}`);
      agentBus.emit("orchestrator:market_adapt", {
        condition,
        rules,
        timestamp: Date.now(),
      });
    }
  });

  // ── Listen for strategy switches ──
  agentBus.subscribe("orchestrator:strategy_switch", (payload) => {
    const oldStrategy = _activeStrategy;
    _activeStrategy = payload?.strategy;
    _strategyHistory.push({
      from: oldStrategy?.id || "none",
      to: _activeStrategy?.id || "none",
      reason: payload?.reason || "manual",
      timestamp: Date.now(),
    });
    // Cap history to prevent slow memory bloat in long-running processes.
    if (_strategyHistory.length > STRATEGY_HISTORY_CAP) {
      _strategyHistory.splice(0, _strategyHistory.length - STRATEGY_HISTORY_CAP);
    }

    log("orchestrator", `Strategy switch: ${oldStrategy?.id || "none"} → ${_activeStrategy?.id || "none"} (${payload?.reason || "manual"})`);
    updateAgentHealth(AGENT_NAME, {
      activeStrategy: _activeStrategy?.id,
      strategyHistory: _strategyHistory.slice(-10),
    });
  });

  // ── Listen for trade outcomes → feed back into strategy selection ──
  agentBus.subscribe("management:llm_exit_executed", (payload) => {
    _tradeCount += 1;
    log("orchestrator", `Trade closed: ${payload?.mint?.slice(0, 8)} — ${payload?.reason}`);
    updateAgentHealth(AGENT_NAME, {
      lastTradeOutcome: payload,
      totalTradesTracked: _tradeCount,
    });
  });

  // ── Listen for full automation toggle ──
  agentBus.subscribe("orchestrator:full_automation", (payload) => {
    _fullAutomationMode = payload?.enabled ?? !_fullAutomationMode;
    log("orchestrator", `Full automation: ${_fullAutomationMode ? "ON" : "OFF"}`);
    updateAgentHealth(AGENT_NAME, { fullAutomation: _fullAutomationMode });
  });

  // ── Listen for pro-orchestrator intelligence ──
  agentBus.subscribe("pro:intelligence_ready", (intel) => {
    if (!intel) return;
    _proIntel = { ...intel, _receivedAt: Date.now() };
    const regimeRecs = (intel.recommendations || []).filter(r => r.type === "regime_preference");
    const stratRecs = (intel.recommendations || []).filter(r => r.type === "strategy_preference");
    log("orchestrator",
      `Pro intel received: ${regimeRecs.length} regime + ${stratRecs.length} strategy recommendations`
    );
    if (regimeRecs.length > 0) {
      log("orchestrator", `  Regime: ${regimeRecs.map(r => r.detail).join(" | ")}`);
    }
    if (stratRecs.length > 0) {
      log("orchestrator", `  Strategy: ${stratRecs.map(r => r.detail).join(" | ")}`);
    }
    updateAgentHealth(AGENT_NAME, {
      proIntelAge: 0,
      proRegimeRecs: regimeRecs.map(r => r.detail),
      proStratRecs: stratRecs.map(r => r.detail),
    });
  });
}

/**
 * Get the recommended strategy for the current market regime.
 * Uses strategy runtime selector if available, falls back to rules.
 */
export function getRecommendedStrategy(getStrategyFn, getMarketIntelFn) {
  const marketIntel = getMarketIntelFn ? getMarketIntelFn() : null;
  const condition = marketIntel?.condition || "NORMAL";
  const rules = STRATEGY_RULES[condition] || STRATEGY_RULES.NORMAL;

  if (!rules.trade) return null;

  // ── Pro intel enrichment ──────────────────────────────────
  // If pro-orchestrator analysis is available, use its strategy
  // recommendations to prefer high-performing strategies and
  // avoid degraded ones for this regime.
  let proPreferred = null;
  let proAvoided = [];
  const intelFresh = _proIntel && (Date.now() - _proIntel._receivedAt) < PRO_INTEL_MAX_AGE_MS;
  if (intelFresh && _proIntel.strategies) {
    const ranked = Object.entries(_proIntel.strategies)
      .filter(([, s]) => s.recommendation === "ACTIVE" && s.winRate >= 0.45)
      .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0));
    if (ranked.length > 0) {
      proPreferred = ranked[0][0]; // best performing strategy per pro intel
    }
    proAvoided = Object.entries(_proIntel.strategies)
      .filter(([, s]) => s.recommendation === "DEGRADED")
      .map(([id]) => id);
  }

  // Delegate to existing StrategyRuntimeSelector if available
  let strategy = null;
  try {
    if (getStrategyFn) {
      strategy = getStrategyFn(null, { regime: condition });
    }
  } catch { /* fallback below */ }

  if (!strategy) {
    strategy = {
      id: `auto_${condition.toLowerCase()}`,
      name: `Auto ${condition}`,
      regime: condition,
      preferTypes: rules.preferTypes,
      maxPositions: rules.maxPositions,
      aggressiveness: rules.aggressiveness,
    };
  }

  // Attach pro intel metadata for downstream consumers
  if (intelFresh) {
    strategy._pro_intel = {
      preferred: proPreferred,
      avoided: proAvoided,
      regime_recommendations: (_proIntel.recommendations || [])
        .filter(r => r.type === "regime_preference")
        .map(r => r.detail),
    };
  }

  return strategy;
}

/**
 * Run a full automation orchestration cycle.
 * Called by orchestrator cron.
 */
export async function runOrchestratorCycle({ getStrategyFn, getMarketIntelFn } = {}) {
  if (!_initialized || !_fullAutomationMode) return null;

  try {
    const marketIntel = getMarketIntelFn ? getMarketIntelFn() : null;
    const condition = marketIntel?.condition || "NORMAL";
    const rules = STRATEGY_RULES[condition] || STRATEGY_RULES.NORMAL;

    if (!rules.trade) {
      agentBus.emit("orchestrator:cycle_skip", {
        reason: rules.reason,
        condition,
        timestamp: Date.now(),
      });
      return null;
    }

    // Select strategy for current regime — only emit if it actually changed
    const strategy = getRecommendedStrategy(getStrategyFn, getMarketIntelFn);
    if (strategy && strategy.id !== _activeStrategy?.id) {
      agentBus.emit("orchestrator:strategy_switch", {
        strategy,
        reason: `market_${condition}`,
        timestamp: Date.now(),
      });
    }

    // Broadcast pipeline adaptation — enriched with pro intel if available
    const intelFresh = _proIntel && (Date.now() - _proIntel._receivedAt) < PRO_INTEL_MAX_AGE_MS;
    const adaptPayload = {
      condition,
      strategy: strategy?.id,
      rules,
      timestamp: Date.now(),
    };
    if (intelFresh && strategy?._pro_intel) {
      adaptPayload.pro_intel = {
        preferred_strategy: strategy._pro_intel.preferred,
        avoided_strategies: strategy._pro_intel.avoided,
        regime_recommendations: strategy._pro_intel.regime_recommendations,
      };
    }
    agentBus.emit("orchestrator:market_adapt", adaptPayload);

    updateAgentHealth(AGENT_NAME, {
      lastCycle: new Date().toISOString(),
      activeStrategy: strategy?.id,
      fullAutomation: _fullAutomationMode,
    });

    return { strategy, rules, condition };
  } catch (e) {
    log("orchestrator_error", e.message);
    return null;
  }
}

export function setFullAutomationMode(enabled) {
  _fullAutomationMode = !!enabled;
  agentBus.emit("orchestrator:full_automation", { enabled: _fullAutomationMode });
  log("orchestrator", `Full automation ${_fullAutomationMode ? "enabled" : "disabled"}`);
}

export function getOrchestratorDashboard() {
  return {
    agent: {
      name: AGENT_NAME,
      role: "orchestrator",
      initialized: _initialized,
    },
    fullAutomation: _fullAutomationMode,
    activeStrategy: _activeStrategy,
    marketCondition: _lastMarketCondition,
    strategyHistory: _strategyHistory.slice(-5),
    rules: STRATEGY_RULES,
  };
}

export { STRATEGY_RULES };
export default {
  initOrchestratorAgent,
  runOrchestratorCycle,
  getRecommendedStrategy,
  setFullAutomationMode,
  getOrchestratorDashboard,
  STRATEGY_RULES,
};
