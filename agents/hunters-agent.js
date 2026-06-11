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
  NORMAL:  { active: true,  sources: ["all"],       minScore: 25, maxTokens: 20, reason: "Standard hunting" },
  COLD:    { active: true,  sources: ["pumpfun"],   minScore: 45, maxTokens: 8,  reason: "Tight filters — only pump.fun" },
  DEAD:    { active: false, sources: [],            minScore: 0,  maxTokens: 0,  reason: "No opportunities" },
};

let _currentSchedule = null;
// Remembered so a gate recovery can rebuild the schedule for the regime that
// was current when the block landed (market:update may not fire again soon).
let _lastMarketCondition = "NORMAL";
let _initialized = false;
// T3-12: unsubscribe refs for safe re-init cleanup.
let _unsubscribers = [];

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

// Build a fresh schedule for a market condition — single source of truth for
// the market:update handler and gate recovery.
function scheduleForCondition(condition) {
  const c = HUNTER_SCHEDULE[condition] ? condition : "NORMAL";
  const s = HUNTER_SCHEDULE[c];
  return {
    active: s.active,
    sources: s.sources,
    minScore: s.minScore,
    maxTokens: s.maxTokens,
    marketCondition: c,
    reason: s.reason,
  };
}

// HA-2: `hunters:gate_blocked` froze `_currentSchedule` at {active:false} but
// NOTHING ever un-froze it — `market:update` fires once at startup and the
// screening agent only commands hunters when the market condition CHANGES, so
// one temporary gate (learning mode, rug breaker, kill switch) silently killed
// the intake pipeline until the next process restart. Recovery is two-layered:
// the hunters cron emits `hunters:gate_cleared` whenever the gate is open
// (forced restore), and runHuntersExpedition() self-heals any gate block older
// than GATE_BLOCK_STALE_MS in case the cleared event itself never arrives.
const GATE_BLOCK_STALE_MS = 15 * 60_000;
export function recoverHuntingIfGateBlocked({ force = false, now = Date.now() } = {}) {
  if (!_currentSchedule?.gateBlock) return false;
  if (!force && now - (_currentSchedule.blockedAt || 0) < GATE_BLOCK_STALE_MS) return false;
  _currentSchedule = scheduleForCondition(_lastMarketCondition);
  log("hunters", `Gate cleared — schedule restored (${_currentSchedule.marketCondition}: ${_currentSchedule.active ? `hunting (${_currentSchedule.sources.join(",")})` : `paused — ${_currentSchedule.reason}`})`);
  updateAgentHealth(AGENT_NAME, { gateRecoveredAt: new Date().toISOString() });
  return true;
}

// Bus-event handlers, exported so tests can drive them directly.
export function onHuntersGateBlocked(payload) {
  log("hunters", `Gate blocked — pausing: ${payload?.reason}`);
  _currentSchedule = {
    active: false,
    sources: [],
    reason: payload?.reason || "gate_blocked",
    gateBlock: true,
    blockedAt: payload?.timestamp || Date.now(),
  };
  updateAgentHealth(AGENT_NAME, { lastGateBlock: payload?.reason, gateBlockedAt: new Date().toISOString() });
}
export function onHuntersGateCleared() {
  recoverHuntingIfGateBlocked({ force: true });
}

export function initHuntersAgent() {
  // Guard first so re-init never wipes already-registered listeners without
  // re-registering them (which would leave the agent permanently deaf).
  if (_initialized) return;
  _initialized = true;

  setAgentStatus(AGENT_NAME, "running", "Hunters agent initialized");

  // Listen for Screening Agent commands
  _unsubscribers.push(agentBus.subscribe("hunters:command", (cmd) => {
    log("hunters", `Command received: active=${cmd.active} sources=${cmd.sources} market=${cmd.marketCondition}`);
    if (cmd?.marketCondition) _lastMarketCondition = cmd.marketCondition;
    _currentSchedule = cmd;
    updateAgentHealth(AGENT_NAME, {
      lastCommand: cmd,
      commandedAt: new Date().toISOString(),
    });
  }));

  // Listen for market updates to adjust hunting
  _unsubscribers.push(agentBus.subscribe("market:update", (update) => {
    const condition = update?.condition || "NORMAL";
    _lastMarketCondition = condition;
    _currentSchedule = scheduleForCondition(condition);
    log("hunters", `Market ${condition}: ${_currentSchedule.active ? `hunting (${_currentSchedule.sources.join(",")})` : `paused — ${_currentSchedule.reason}`}`);
  }));

  // Listen for gate blocks — stop hunting immediately if kill switch or rug breaker trips
  _unsubscribers.push(agentBus.subscribe("hunters:gate_blocked", onHuntersGateBlocked));
  // HA-2: and resume when the gate is open again (emitted by the hunters cron)
  _unsubscribers.push(agentBus.subscribe("hunters:gate_cleared", onHuntersGateCleared));

  // ── Learning feedback loop — adjust per-source minScore based on rug rates ──
  // High rug-rate source → raise threshold (harder to pass)
  // High win-rate source → lower threshold slightly (easier to pass)
  _unsubscribers.push(agentBus.subscribe("learning:hunter_weights", ({ ranking } = {}) => {
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
  }));
}

export async function runHuntersExpedition({ strategy = null } = {}) {
  if (!_initialized) initHuntersAgent();

  // HA-2 self-heal: a stale gate block must never outlive the gate itself.
  if (_currentSchedule?.gateBlock) recoverHuntingIfGateBlocked();

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
  const EXPEDITION_TIMEOUT_MS = 30_000;

  try {
    // Wrap expedition with timeout — if multi-source API calls hang beyond 30s,
    // fall back to cached prey so the screening cycle isn't starved of candidates.
    const expeditionWithTimeout = Promise.race([
      runHunterExpedition({ strategy: huntingStrategy }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`expedition_timeout_${EXPEDITION_TIMEOUT_MS}ms`)), EXPEDITION_TIMEOUT_MS)
      ),
    ]);
    const prey = await expeditionWithTimeout;

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
        // Debug level: fires tens of thousands of times per day (84k+ in one
        // log archive) — the aggregate "Source thresholds dropped X/Y" line
        // below is the operator-facing signal.
        log("hunters_debug", `Source filter: ${token.symbol || token.mint?.slice(0, 8)} from "${src}" score=${score} < threshold=${effectiveMin} — dropped`);
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
    const isTimeout = e.message?.startsWith("expedition_timeout");
    if (isTimeout) {
      log("hunters_timeout", `Expedition timed out after ${EXPEDITION_TIMEOUT_MS}ms — falling back to cached prey`);
      updateAgentHealth(AGENT_NAME, { lastTimeout: new Date().toISOString(), lastError: "timeout" });
      // Return cached prey so the screening cycle still has candidates
      const cached = getCachedPrey();
      if (cached.length > 0) {
        log("hunters", `Timeout fallback: returning ${cached.length} cached tokens`);
        return cached;
      }
      return [];
    }
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
