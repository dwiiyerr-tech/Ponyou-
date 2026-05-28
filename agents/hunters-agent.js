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

// Source-level minScore overrides from learning agent.
// Key = source string (e.g. "social", "pumpfun"), value = adjusted minScore.
// High rug-rate sources get their threshold raised; low-rug sources stay at base.
const _sourceThresholds = {};

// Cap how much learning can raise/lower a source threshold vs the base schedule
const THRESHOLD_RAISE_CAP = 25; // max +25 on top of base minScore for bad sources
const THRESHOLD_LOWER_CAP = 10; // max -10 below base minScore for good sources

export function getSourceMinScore(source, baseMinScore) {
  // HA-1: _sourceThresholds now stores offsets, not absolute thresholds.
  // Apply the offset against the CURRENT regime baseline so changing
  // market conditions still tightens / loosens the source uniformly.
  const offset = _sourceThresholds[source];
  if (offset === undefined) return baseMinScore;
  const proposed = baseMinScore + offset;
  return Math.max(baseMinScore - THRESHOLD_LOWER_CAP, Math.min(baseMinScore + THRESHOLD_RAISE_CAP, proposed));
}

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

  // ── Learning feedback loop — adjust per-source minScore based on rug rates ──
  // High rug-rate source → raise threshold (harder to pass)
  // High win-rate source → lower threshold slightly (easier to pass)
  agentBus.subscribe("learning:hunter_weights", ({ ranking } = {}) => {
    if (!Array.isArray(ranking) || ranking.length === 0) return;

    // HA-1: previously cached `baseMinScore` from whatever `_currentSchedule`
    // happened to hold at this moment. If learning fired before any
    // `market:update` (cold start) baseMinScore was the fallback 30, and
    // `_sourceThresholds` got pinned to that floor even though the regime
    // might later be COLD (base 45). Store raw OFFSETS instead so they
    // can be re-applied against the CURRENT regime base whenever a token
    // is filtered.
    let changed = 0;

    for (const entry of ranking) {
      const src = entry.source;
      if (!src || src === "unknown") continue;

      // Need at least 5 closed trades from this source to trust the stats
      const closed = (entry.won || 0) + (entry.lost || 0) + (entry.rugged || 0);
      if (closed < 5) continue;

      const rugRate = entry.rug_rate || 0;
      const winRate = entry.win_rate || 0;

      // HA-1: compute OFFSET from baseline rather than an absolute threshold.
      // The offset gets applied to whatever regime base is current when
      // getSourceMinScore() is called, so changing regimes doesn't strand
      // the old learned rule at a stale baseline.
      let offset = 0;
      if (rugRate >= 0.60)      offset = 25;   // very bad — choke hard
      else if (rugRate >= 0.45) offset = 18;
      else if (rugRate >= 0.30) offset = 10;
      else if (rugRate >= 0.20) offset = 5;
      else if (winRate >= 0.55) offset = -8;   // great source — open up
      else if (winRate >= 0.40) offset = -4;

      if (_sourceThresholds[src] !== offset) {
        _sourceThresholds[src] = offset;
        log("hunters", `Learning: source "${src}" offset → ${offset >= 0 ? "+" + offset : offset} (rug=${(rugRate * 100).toFixed(0)}% win=${(winRate * 100).toFixed(0)}% n=${closed})`);
        changed++;
      }
    }

    if (changed > 0) {
      updateAgentHealth(AGENT_NAME, {
        source_thresholds: { ..._sourceThresholds },
        thresholds_updated_at: new Date().toISOString(),
      });
    }
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

    // Tag each token with its hunt source for learning-agent attribution
    for (const token of prey) {
      if (!token._hunt_source) {
        token._hunt_source = token._source || huntingStrategy.sources?.[0] || "hunters";
      }
    }

    // Apply per-source learned thresholds — filter out tokens from high-rug sources
    const baseMinScore = huntingStrategy.minScore || 30;
    const filteredPrey = prey.filter(token => {
      const src = token._hunt_source;
      const effectiveMin = getSourceMinScore(src, baseMinScore);
      const score = token._hunter_score ?? token.score ?? 0;
      if (score < effectiveMin) {
        log("hunters", `Source filter: ${token.symbol || token.mint?.slice(0, 8)} from "${src}" score=${score} < threshold=${effectiveMin} — dropped`);
        return false;
      }
      return true;
    });

    if (filteredPrey.length < prey.length) {
      log("hunters", `Source thresholds dropped ${prey.length - filteredPrey.length}/${prey.length} tokens`);
    }

    if (filteredPrey.length > 0) {
      agentBus.emit("hunters:prey_ready", {
        prey: filteredPrey,
        source: huntingStrategy.sources,
        marketCondition: _currentSchedule?.marketCondition || "UNKNOWN",
        timestamp: Date.now(),
      });

      const priority = filteredPrey.filter(p => p._hunter_score >= 50).length;
      log("hunters", `Prey dispatched: ${filteredPrey.length} tokens (${priority} priority) → bus`);
    }

    updateAgentHealth(AGENT_NAME, {
      lastExpedition: new Date().toISOString(),
      lastPreyCount: filteredPrey.length,
      lastDurationMs: Date.now() - startTime,
      hunterStats: getHunterStats(),
      source_thresholds: Object.keys(_sourceThresholds).length > 0 ? { ..._sourceThresholds } : undefined,
    });

    return filteredPrey;
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
