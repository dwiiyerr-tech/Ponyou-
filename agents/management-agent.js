/**
 * Management Agent — BUY & SELL Decision Maker (with LLM)
 *
 * This agent OWNS all trading decisions:
 *   BUY  — LLM reviews screening candidates, decides which to enter
 *   SELL — deterministic exits (SL/TP/trailing/rug) + LLM qualitative review
 *
 * Flow:
 *   1. Deterministic exits run first (no LLM, no override)
 *   2. LLM portfolio review for remaining positions
 *   3. LLM entry review for screening candidates (delegated from index.js)
 *
 * General Agent does NOT make trading decisions — only chat/Telegram/dashboard.
 *
 * Bus events emitted:
 *   management:llm_review_started   — LLM review begins
 *   management:llm_review_complete  — LLM review ends
 *   management:llm_buy              — LLM decided to buy
 *   management:llm_sell             — LLM decided to sell
 *   management:llm_exit_executed    — Sell executed + recorded
 *   management:llm_entry_executed   — Buy executed + tracked
 *   management:status               — Cycle status update
 */

import { agentBus } from "./agent-bus.js";
import { setAgentStatus, updateAgentHealth } from "./agent-registry.js";
import { log } from "../logger.js";

const AGENT_NAME = "management";

let _runManagementCycle = null;
let _checkAllGates = null;
let _telegramEnabled = null;
let _lLMReviewEnabled = true;

export function initManagementAgent({ runManagementCycle, checkAllGates, telegramEnabled, llmReviewEnabled = true }) {
  _runManagementCycle = runManagementCycle;
  _checkAllGates = checkAllGates;
  _telegramEnabled = telegramEnabled;
  _lLMReviewEnabled = llmReviewEnabled;

  setAgentStatus(AGENT_NAME, "running", "Management agent — owns BUY/SELL decisions, LLM review enabled");

  // ── BUY tracking: listen for screening candidates → could trigger entry ──
  agentBus.subscribe("screening:decision", (payload) => {
    log("management", `Screening decision received: ${payload?.symbol || payload?.mint} — ready for review`);
    updateAgentHealth(AGENT_NAME, {
      lastScreeningDecision: payload,
      pendingBuyReview: true,
    });
  });

  // ── SELL tracking: LLM review lifecycle ──
  agentBus.subscribe("management:llm_review_started", () => {
    updateAgentHealth(AGENT_NAME, { llmReviewActive: true });
  });

  agentBus.subscribe("management:llm_review_complete", (payload) => {
    log("management", `LLM review complete — ${payload?.tokenCount || 0} positions`);
    updateAgentHealth(AGENT_NAME, {
      lastLLMReview: new Date().toISOString(),
      llmReviewActive: false,
    });
  });

  agentBus.subscribe("management:llm_buy", (payload) => {
    log("management", `BUY: ${payload?.symbol || payload?.token?.slice(0, 8)} | ${payload?.amount} SOL`);
    updateAgentHealth(AGENT_NAME, { lastLLMBuy: payload, pendingBuyReview: false });
  });

  agentBus.subscribe("management:llm_sell", (payload) => {
    log("management", `SELL: ${payload?.symbol || payload?.token?.slice(0, 8)}`);
    updateAgentHealth(AGENT_NAME, { lastLLMSell: payload });
  });

  agentBus.subscribe("management:llm_exit_executed", (payload) => {
    log("management", `EXIT: ${payload?.mint?.slice(0, 8)} — ${payload?.reason}`);
    updateAgentHealth(AGENT_NAME, { lastExit: payload });
  });

  agentBus.subscribe("management:llm_entry_executed", (payload) => {
    log("management", `ENTRY: ${payload?.mint?.slice(0, 8)} | ${payload?.amount_sol} SOL`);
    updateAgentHealth(AGENT_NAME, { lastEntry: payload });
  });

  // ── Heartbeat: always-on position monitoring (every 30s) ──
  agentBus.subscribe("management:heartbeat", (payload) => {
    updateAgentHealth(AGENT_NAME, {
      lastHeartbeat: new Date().toISOString(),
      positionsMonitored: payload?.positions || 0,
      emergencySignals: payload?.emergencySignals || 0,
    });
  });

  // ── Emergency exits: rug force-exit or price crash ──
  agentBus.subscribe("management:emergency_exit", (payload) => {
    log("management", `EMERGENCY: ${payload?.symbol} — ${payload?.reason} (${payload?.type})`);
    updateAgentHealth(AGENT_NAME, {
      lastEmergency: payload,
      emergencyCount: (updateAgentHealth._emergencyCount || 0) + 1,
    });
  });

  // ── Full cycle complete tracking ──
  agentBus.subscribe("management:full_cycle_complete", () => {
    updateAgentHealth(AGENT_NAME, {
      lastFullCycle: new Date().toISOString(),
    });
  });
}

export async function runManagementCycle({ silent = false } = {}) {
  if (!_runManagementCycle) {
    log("management_error", "Management agent not initialized");
    return "Management agent not initialized";
  }

  const gate = await _checkAllGates("management");
  if (gate.blocked) {
    updateAgentHealth(AGENT_NAME, { lastGateBlock: gate.reason });
    return gate.reason;
  }

  setAgentStatus(AGENT_NAME, "running");
  const startTime = Date.now();

  try {
    // Delegate to index.js — which runs determistic exits THEN LLM review
    const result = await _runManagementCycle({ silent });

    agentBus.emit("management:status", {
      result,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });

    updateAgentHealth(AGENT_NAME, {
      lastRun: new Date().toISOString(),
      lastDurationMs: Date.now() - startTime,
    });

    return result;
  } catch (e) {
    log("management_error", e.message);
    updateAgentHealth(AGENT_NAME, { lastError: e.message });
    return `Error: ${e.message}`;
  }
}

export function setLLMReviewEnabled(enabled) {
  _lLMReviewEnabled = !!enabled;
  log("management", `LLM review ${_lLMReviewEnabled ? "enabled" : "disabled"}`);
}

export function getManagementAgentStatus() {
  return {
    name: AGENT_NAME,
    role: "management",
    description: "Owns BUY & SELL decisions. Uses LLM for portfolio review.",
    initialized: !!_runManagementCycle,
    llmReviewEnabled: _lLMReviewEnabled,
  };
}

export default {
  initManagementAgent,
  runManagementCycle,
  setLLMReviewEnabled,
  getManagementAgentStatus,
};
