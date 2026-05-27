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
let _injectedGetStrategy = null;     // stored at init — used by no-arg runOrchestratorCycle()
let _injectedGetMarketIntel = null;
const STRATEGY_HISTORY_CAP = 100;     // prevent unbounded growth in long-running bot

// Selector tuning — exported so config.js / tests can override. The values
// below are the audited defaults; raise PRO_INTEL_MAX_AGE_MS if your
// pro-orchestrator cron interval is longer than 30 min.
export const SELECTOR_TUNING = {
  PRO_INTEL_MAX_AGE_MS: 30 * 60_000,     // OA-6: was 10 min — too tight for cron lag
  ACTIVE_WINRATE_FLOOR: 0.45,            // OA-8: minimum win-rate to be considered ACTIVE
  PROVISIONAL_CONVICTION: 0.80,           // unused yet — documented from header
  DEGRADATION_THRESHOLD: 0.75,            // unused yet — documented from header
  AUTO_APPROVE_CONVICTION: 0.95,          // unused yet — documented from header
};

// Strategy selection rules per market regime. `reason` is set on every entry
// so log lines and pause-event payloads never read `undefined`.
const STRATEGY_RULES = {
  EXTREME: { trade: false, reason: "Market extreme — all trading paused" },
  HOT:     { trade: true,  reason: "HOT market — aggressive trading",       preferTypes: ["scalping", "momentum", "narrative"], maxPositions: 3, aggressiveness: "high" },
  NORMAL:  { trade: true,  reason: "NORMAL market — balanced trading",      preferTypes: ["scalping", "fundamental", "conviction"], maxPositions: 2, aggressiveness: "normal" },
  COLD:    { trade: true,  reason: "COLD market — conservative trading",    preferTypes: ["fundamental", "conviction"], maxPositions: 1, aggressiveness: "low" },
  DEAD:    { trade: false, reason: "Market dead — no opportunities" },
};

export function initOrchestratorAgent({ getStrategyFn, getMarketIntelFn } = {}) {
  if (_initialized) {
    // OA-5: silent reinit used to mask startup-order bugs. Warn loudly and
    // refresh injected fns in case caller wants to swap them.
    log("orchestrator", "WARN: initOrchestratorAgent called twice — refreshing injected fns only");
    if (getStrategyFn) _injectedGetStrategy = getStrategyFn;
    if (getMarketIntelFn) _injectedGetMarketIntel = getMarketIntelFn;
    return;
  }
  _initialized = true;
  // OA-3: store injected fns so no-arg cycles work.
  _injectedGetStrategy = getStrategyFn || null;
  _injectedGetMarketIntel = getMarketIntelFn || null;

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
  // OA-3: fall back to injected fns if caller didn't pass them.
  const _getStrategy = getStrategyFn || _injectedGetStrategy;
  const _getMarketIntel = getMarketIntelFn || _injectedGetMarketIntel;

  const marketIntel = _getMarketIntel ? _getMarketIntel() : null;
  const condition = marketIntel?.condition || "NORMAL";
  const rules = STRATEGY_RULES[condition] || STRATEGY_RULES.NORMAL;

  if (!rules.trade) return null;

  // ── Pro intel enrichment ──────────────────────────────────
  // If pro-orchestrator analysis is available, use its strategy
  // recommendations to prefer high-performing strategies and
  // avoid degraded ones for this regime.
  let proPreferred = null;
  let proAvoided = [];
  const intelFresh = _proIntel && (Date.now() - _proIntel._receivedAt) < SELECTOR_TUNING.PRO_INTEL_MAX_AGE_MS;
  if (intelFresh && _proIntel.strategies) {
    const ranked = Object.entries(_proIntel.strategies)
      .filter(([, s]) => s.recommendation === "ACTIVE" && s.winRate >= SELECTOR_TUNING.ACTIVE_WINRATE_FLOOR)
      .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0));
    if (ranked.length > 0) {
      proPreferred = ranked[0][0]; // best performing strategy per pro intel
    }
    proAvoided = Object.entries(_proIntel.strategies)
      .filter(([, s]) => s.recommendation === "DEGRADED")
      .map(([id]) => id);
  }

  // OA-1: when pro-intel has a fresh, ACTIVE-recommended strategy, prefer it
  // over the regime fallback. The previous code computed `proPreferred` then
  // discarded the recommendation by always going through the regime
  // selector or auto-fallback — making the entire pro-orchestrator
  // pipeline decorative.
  let strategy = null;
  try {
    if (_getStrategy) {
      const hint = proPreferred ? { regime: condition, prefer: proPreferred, avoid: proAvoided } : { regime: condition };
      strategy = _getStrategy(null, hint);
    }
  } catch { /* fallback below */ }

  // If the selector returned a strategy in the avoid list, AND we have a
  // pro-preferred alternative, override its `id`. This lets the selector
  // hand us the rich strategy object while ensuring we don't pick something
  // pro flagged as DEGRADED.
  if (strategy && proAvoided.includes(strategy.id) && proPreferred) {
    log("orchestrator", `pro-intel override: ${strategy.id} (DEGRADED) → ${proPreferred} (ACTIVE)`);
    strategy = { ...strategy, id: proPreferred, name: `${strategy.name || proPreferred} [pro]`, _pro_intel_overridden: true };
  }

  if (!strategy) {
    strategy = {
      id: proPreferred || `auto_${condition.toLowerCase()}`,
      name: proPreferred ? `Pro-preferred ${proPreferred}` : `Auto ${condition}`,
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

  // OA-3: fall back to stored injections.
  const _getStrategy = getStrategyFn || _injectedGetStrategy;
  const _getMarketIntel = getMarketIntelFn || _injectedGetMarketIntel;

  try {
    const marketIntel = _getMarketIntel ? _getMarketIntel() : null;
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
    const strategy = getRecommendedStrategy(_getStrategy, _getMarketIntel);
    if (strategy && strategy.id !== _activeStrategy?.id) {
      agentBus.emit("orchestrator:strategy_switch", {
        strategy,
        reason: `market_${condition}`,
        timestamp: Date.now(),
      });
    }

    // Broadcast pipeline adaptation — enriched with pro intel if available
    const intelFresh = _proIntel && (Date.now() - _proIntel._receivedAt) < SELECTOR_TUNING.PRO_INTEL_MAX_AGE_MS;
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
