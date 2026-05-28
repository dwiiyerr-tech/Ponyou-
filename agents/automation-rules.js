/**
 * Full Automation Rules — Qualification Gate & Proposal System
 *
 * Full automation (auto-strategy-selection, auto-BUY/SELL/SKIP/CUTLOSS)
 * is LOCKED until these requirements are met:
 *
 *   HARD REQUIREMENTS:
 *   1. 1000+ hours market exposure (live or demo trading time)
 *   2. 500+ closed trades in trade-attribution.json
 *   3. 100+ conviction samples across 20+ unique coins
 *   4. 50+ lessons learned from trade outcomes
 *   5. 30+ unique rug patterns in rug-memory.json
 *   6. 4+ market regimes observed (HOT, NORMAL, COLD, DEAD)
 *   7. Win rate >= 45% over last 100 trades
 *   8. Strategy evolution engine has produced >= 3 strategies
 *
 *   BEFORE requirements met:
 *   - Agent follows user-configured rules ONLY (no auto-decision)
 *   - All BUY/SELL must go through confirmMode or Telegram approval
 *   - Strategy selection is manual (user picks strategy)
 *
 *   AFTER requirements met:
 *   - Agent sends PROPOSAL to Telegram for user approval
 *   - User can APPROVE or REJECT via Telegram or dashboard
 *   - If approved: full automation activates
 *   - Agent can auto-select strategies, auto-create new ones
 *   - Agent can auto-BUY/SELL/SKIP/CUTLOSS within strategy rules
 *   - User can REVOKE automation anytime via dashboard
 *
 *   PROPOSAL SYSTEM:
 *   - When all requirements met → agent sends proposal to Telegram
 *   - Proposal includes: qualification summary, what will change, risks
 *   - User responds: /approve_automation or /reject_automation
 *   - Dashboard toggle: automation_enabled: true/false
 *   - Revocation: immediate, no grace period
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { log } from "../logger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ─── Hard Requirements ────────────────────────────────────────

const REQUIREMENTS = {
  marketExposureHours: 1000,      // 1000 jam tayang di market
  minClosedTrades: 500,           // 500+ closed trades
  minConvictionSamples: 100,      // 100+ conviction samples
  minUniqueCoins: 20,             // 20+ unique coins observed
  minLessonsLearned: 50,          // 50+ lessons from outcomes
  minRugPatterns: 30,             // 30+ rug patterns known
  minRegimesObserved: 4,          // HOT, NORMAL, COLD, DEAD
  minWinRate: 0.45,               // 45% win rate over last 100
  minEvolvedStrategies: 3,        // 3+ evolved strategies
};

// ─── State ────────────────────────────────────────────────────

const AUTOMATION_STATE_FILE = path.join(PROJECT_ROOT, "automation-state.json");

let _automationState = {
  qualified: false,
  proposalSent: false,
  proposalApproved: false,
  automationActive: false,
  qualificationCheckedAt: null,
  proposalSentAt: null,
  approvedAt: null,
  revokedAt: null,
  qualificationSummary: null,
};

function loadAutomationState() {
  try {
    if (fs.existsSync(AUTOMATION_STATE_FILE)) {
      _automationState = { ..._automationState, ...JSON.parse(fs.readFileSync(AUTOMATION_STATE_FILE, "utf8")) };
    }
  } catch (e) {
    log("automation_rules_error", `Failed to load automation state: ${e.message}`);
  }
}

function saveAutomationState() {
  try {
    atomicWriteJson(AUTOMATION_STATE_FILE, _automationState);
  } catch (e) {
    log("automation_rules_error", `Failed to save state: ${e.message}`);
  }
}

loadAutomationState();

// ─── Data Readers ─────────────────────────────────────────────

function tryReadJson(filename) {
  try {
    const fp = path.join(PROJECT_ROOT, filename);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {
    log("automation_rules_warn", `Failed to read ${filename}: ${e.message}`);
    return null;
  }
}

// ─── Qualification Check ──────────────────────────────────────

export function checkAutomationQualification() {
  const results = { passed: [], failed: [], summary: {} };

  // 1. Market exposure hours — from metrics.json or trading time tracking
  const metrics = tryReadJson("metrics.json") || {};
  // AAR-5: derive cycle minutes from runtime config so the estimate
  // tracks the operator's actual interval. Previously hardcoded 5,
  // which over- or under-counted whenever config changed.
  const cycleMin = Math.max(1, Number(config?.schedule?.managementIntervalMin) || 5);
  const exposureHours = metrics.total_market_hours
    || metrics.market_exposure_hours
    || metrics.uptime_hours
    || ((metrics.total_cycles || 0) * cycleMin / 60)
    || 0;
  results.summary.marketExposureHours = exposureHours;
  if (exposureHours >= REQUIREMENTS.marketExposureHours) {
    results.passed.push(`Market exposure: ${exposureHours.toFixed(0)}h >= ${REQUIREMENTS.marketExposureHours}h`);
  } else {
    results.failed.push(`Market exposure: ${exposureHours.toFixed(0)}h / ${REQUIREMENTS.marketExposureHours}h needed (${(exposureHours / REQUIREMENTS.marketExposureHours * 100).toFixed(1)}%)`);
  }

  // 2. Closed trades
  const attribution = tryReadJson("trade-attribution.json") || {};
  const trades = attribution.trades || [];
  results.summary.closedTrades = trades.length;
  if (trades.length >= REQUIREMENTS.minClosedTrades) {
    results.passed.push(`Closed trades: ${trades.length} >= ${REQUIREMENTS.minClosedTrades}`);
  } else {
    results.failed.push(`Closed trades: ${trades.length} / ${REQUIREMENTS.minClosedTrades}`);
  }

  // 3. Conviction samples + unique coins
  const conviction = tryReadJson("coin-conviction.json") || {};
  const coins = conviction.coins || {};
  const coinList = Object.values(coins);
  const totalSamples = coinList.reduce((s, c) => s + (c.observation_count || 0), 0);
  results.summary.convictionSamples = totalSamples;
  results.summary.uniqueCoins = coinList.length;
  if (totalSamples >= REQUIREMENTS.minConvictionSamples && coinList.length >= REQUIREMENTS.minUniqueCoins) {
    results.passed.push(`Conviction: ${totalSamples} samples across ${coinList.length} coins`);
  } else {
    results.failed.push(`Conviction: ${totalSamples}/${REQUIREMENTS.minConvictionSamples} samples, ${coinList.length}/${REQUIREMENTS.minUniqueCoins} coins`);
  }

  // 4. Lessons learned
  const lessons = tryReadJson("lessons.json") || {};
  const lessonEntries = lessons.lessons || lessons.entries || [];
  results.summary.lessonsLearned = lessonEntries.length;
  if (lessonEntries.length >= REQUIREMENTS.minLessonsLearned) {
    results.passed.push(`Lessons: ${lessonEntries.length} >= ${REQUIREMENTS.minLessonsLearned}`);
  } else {
    results.failed.push(`Lessons: ${lessonEntries.length} / ${REQUIREMENTS.minLessonsLearned}`);
  }

  // 5. Rug patterns
  const rugMemory = tryReadJson("rug-memory.json") || {};
  const rugPatterns = rugMemory.patterns || [];
  results.summary.rugPatterns = rugPatterns.length;
  if (rugPatterns.length >= REQUIREMENTS.minRugPatterns) {
    results.passed.push(`Rug patterns: ${rugPatterns.length} >= ${REQUIREMENTS.minRugPatterns}`);
  } else {
    results.failed.push(`Rug patterns: ${rugPatterns.length} / ${REQUIREMENTS.minRugPatterns}`);
  }

  // 6. Market regimes observed
  const marketIntel = tryReadJson("market-intelligence.json") || {};
  const regimes = new Set();
  (marketIntel.snapshots || marketIntel.history || []).forEach(s => {
    if (s.condition) regimes.add(s.condition);
  });
  results.summary.regimesObserved = regimes.size;
  results.summary.regimesList = [...regimes];
  if (regimes.size >= REQUIREMENTS.minRegimesObserved) {
    results.passed.push(`Regimes observed: ${regimes.size} (${[...regimes].join(", ")})`);
  } else {
    results.failed.push(`Regimes: ${regimes.size}/${REQUIREMENTS.minRegimesObserved} observed`);
  }

  // 7. Win rate
  const recentTrades = trades.slice(-100);
  const wins = recentTrades.filter(t => (t.pnl_pct || 0) > 0).length;
  const winRate = recentTrades.length > 0 ? wins / recentTrades.length : 0;
  results.summary.recentWinRate = winRate;
  results.summary.recentTradeCount = recentTrades.length;
  if (winRate >= REQUIREMENTS.minWinRate && recentTrades.length >= 50) {
    results.passed.push(`Win rate: ${(winRate * 100).toFixed(1)}% >= ${(REQUIREMENTS.minWinRate * 100).toFixed(0)}%`);
  } else {
    results.failed.push(`Win rate: ${(winRate * 100).toFixed(1)}% / ${(REQUIREMENTS.minWinRate * 100).toFixed(0)}% (last ${recentTrades.length} trades)`);
  }

  // 8. Evolved strategies
  const strategyReg = tryReadJson("data/strategy-registry.json") || {};
  const strategies = strategyReg.strategies || strategyReg.entries || [];
  const evolved = strategies.filter(s => s.source === "evolution" || s.generation > 0);
  results.summary.evolvedStrategies = evolved.length;
  if (evolved.length >= REQUIREMENTS.minEvolvedStrategies) {
    results.passed.push(`Evolved strategies: ${evolved.length} >= ${REQUIREMENTS.minEvolvedStrategies}`);
  } else {
    results.failed.push(`Evolved strategies: ${evolved.length} / ${REQUIREMENTS.minEvolvedStrategies}`);
  }

  // Final verdict
  const qualified = results.failed.length === 0;
  results.qualified = qualified;
  results.checkedAt = new Date().toISOString();
  const total = results.passed.length + results.failed.length;
  results.progressPct = total > 0 ? Math.round((results.passed.length / total) * 100) : 0;

  return results;
}

// ─── Automation Lifecycle ─────────────────────────────────────

export function isAutomationQualified() {
  return _automationState.qualified;
}

export function isAutomationActive() {
  return _automationState.automationActive && _automationState.proposalApproved;
}

export function getAutomationState() {
  return { ..._automationState };
}

/**
 * Run qualification check. If qualified and proposal not yet sent,
 * emit proposal event to Telegram via bus.
 */
export function runAutomationQualification({ telegramSendFn = null } = {}) {
  const results = checkAutomationQualification();

  _automationState.qualificationCheckedAt = new Date().toISOString();
  _automationState.qualificationSummary = results;

  // AAR-9: detect transitions in both directions so the operator gets a
  // signal when a previously-qualified bot drops back below threshold
  // (e.g., win rate decay, evolved-strategy expiry, regime gap).
  const wasQualified = _automationState.qualified;

  if (results.qualified) {
    _automationState.qualified = true;

    if (!_automationState.proposalSent) {
      // Build proposal for Telegram
      const proposal = buildProposal(results);

      // Emit to bus for Telegram delivery
      agentBus.emit("automation:proposal_ready", {
        proposal,
        qualification: results,
        timestamp: Date.now(),
      });

      _automationState.proposalSent = true;
      _automationState.proposalSentAt = new Date().toISOString();

      log("automation_rules", "QUALIFIED — proposal sent for approval");
      updateAgentHealth("orchestrator", {
        automationQualified: true,
        automationProposalSent: true,
      });
    }
  } else {
    _automationState.qualified = false;
    log("automation_rules", `Not qualified: ${results.progressPct}% (${results.passed.length}/${results.passed.length + results.failed.length} checks passed)`);
    // AAR-9: explicit degradation alert. If automation is currently
    // active and we just lost qualification, the operator should know
    // immediately — the safety gate is now propped open by a stale
    // approval.
    if (wasQualified) {
      agentBus.emit("automation:qualification_lost", {
        previousState: "qualified",
        failedChecks: results.failed,
        progressPct: results.progressPct,
        automationActive: _automationState.automationActive,
        timestamp: Date.now(),
      });
      log("automation_rules",
        `⚠️  QUALIFICATION LOST (was qualified) — ${results.failed.length} checks now failing` +
        (_automationState.automationActive ? " — automation still active, consider /revoke_automation" : ""),
      );
    }
  }

  saveAutomationState();
  return results;
}

export function approveAutomation() {
  // AAR-2: re-check qualification at approve time instead of trusting the
  // cached flag. Conditions can degrade between qualification and approval
  // (win rate drops, regime exits, etc.); approving based on stale state
  // means the safety gate opens for a bot that no longer meets the bar.
  const fresh = checkAutomationQualification();
  if (!fresh.qualified) {
    log("automation_rules",
      `Approve blocked — re-check failed: ${fresh.failed.length} checks now missing (${fresh.progressPct}%)`,
    );
    // Sync the cached state so isAutomationQualified() reads accurately.
    _automationState.qualified = false;
    _automationState.qualificationSummary = fresh;
    saveAutomationState();
    return {
      ok: false,
      reason: "Re-check at approve time failed",
      failedChecks: fresh.failed,
      progressPct: fresh.progressPct,
    };
  }

  _automationState.qualified = true;
  _automationState.qualificationSummary = fresh;
  _automationState.proposalApproved = true;
  _automationState.approvedAt = new Date().toISOString();
  _automationState.automationActive = true;

  saveAutomationState();

  agentBus.emit("automation:activated", {
    approvedAt: _automationState.approvedAt,
    timestamp: Date.now(),
  });

  log("automation_rules", "AUTOMATION ACTIVATED — full auto strategy selection + BUY/SELL enabled");
  return { ok: true, message: "Full automation activated" };
}

export function rejectAutomation(reason = "") {
  _automationState.proposalApproved = false;
  _automationState.automationActive = false;
  _automationState.proposalSent = false;

  saveAutomationState();

  log("automation_rules", `Automation rejected${reason ? ": " + reason : ""}`);
  return { ok: true, message: "Automation rejected" };
}

export function revokeAutomation(reason = "") {
  _automationState.automationActive = false;
  _automationState.proposalApproved = false;
  _automationState.revokedAt = new Date().toISOString();

  saveAutomationState();

  agentBus.emit("automation:revoked", {
    reason,
    timestamp: Date.now(),
  });

  log("automation_rules", `Automation REVOKED${reason ? ": " + reason : ""}`);
  return { ok: true, message: "Automation revoked — back to manual mode" };
}

// ─── Proposal Builder ─────────────────────────────────────────

function buildProposal(qualification) {
  return {
    title: "Full Automation — Qualification Met",
    summary: `${qualification.passed.length}/${qualification.passed.length + qualification.failed.length} requirements passed (${qualification.progressPct}%)`,
    requirements: qualification.summary,
    whatChanges: [
      "Agent can auto-select strategies based on market regime",
      "Agent can auto-create new strategies from evolved data",
      "Agent can auto-BUY when screening finds high-conviction candidates",
      "Agent can auto-SELL on stop-loss, take-profit, or conviction decay",
      "Agent can auto-SKIP when risk is too high",
      "Agent can auto-CUTLOSS at hard thresholds",
      "User keeps veto power: revoke anytime via dashboard or /revoke_automation",
    ],
    risks: [
      "Full automation means no human review per trade",
      "Market conditions can change rapidly",
      "Strategy degradation may not be caught immediately",
      "Circuit breakers and kill switch remain active as safety net",
    ],
    actions: {
      approve: "/approve_automation",
      reject: "/reject_automation",
    },
    qualifiedAt: qualification.checkedAt,
  };
}

// ─── Guard: Check Before Automated Decisions ──────────────────

/**
 * Check if automated decision is allowed.
 * Returns { allowed: boolean, reason: string }
 */
export function guardAutomatedDecision(decisionType) {
  if (!_automationState.automationActive) {
    return {
      allowed: false,
      // AAR-10: include the decision type in the reason so the caller's
      // log line tells the operator which action was blocked.
      reason: `Automation not active${decisionType ? ` (${decisionType})` : ""}. ${_automationState.qualified ? "Awaiting approval." : "Not qualified yet. " + getProgressMessage()}`,
    };
  }

  return { allowed: true, decisionType };
}

function getProgressMessage() {
  const results = checkAutomationQualification();
  return `${results.progressPct}% requirements met (${results.passed.length}/${results.passed.length + results.failed.length})`;
}

// ─── Export ───────────────────────────────────────────────────

export { REQUIREMENTS };
export default {
  checkAutomationQualification,
  runAutomationQualification,
  approveAutomation,
  rejectAutomation,
  revokeAutomation,
  isAutomationQualified,
  isAutomationActive,
  getAutomationState,
  guardAutomatedDecision,
  REQUIREMENTS,
};
