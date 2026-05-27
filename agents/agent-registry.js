/**
 * Agent Registry — Lifecycle tracking + health status for all agents.
 *
 * Agents register at startup, report health, and are tracked
 * for the dashboard and operator visibility.
 *
 * Agent roles:
 *   hunters     — No-LLM token discovery (kuli)
 *   screening   — Pipeline orchestrator (min LLM)
 *   management  — Position exits + plan execution (no LLM)
 *   general     — LLM decisions + Telegram + reports (LLM only)
 */

import { log } from "../logger.js";

const _agents = new Map(); // name → { status, role, module, health, startedAt, lastHeartbeat }

const VALID_ROLES = new Set(["hunters", "screening", "management", "general", "trash-layer", "orchestrator", "pro-orchestrator"]);
const VALID_STATUSES = new Set(["stopped", "starting", "running", "degraded", "error", "stopping"]);

export function registerAgent(name, { role, module, healthCheck = null } = {}) {
  if (_agents.has(name)) {
    // Update existing registration
    const existing = _agents.get(name);
    if (module) existing.module = module;
    if (healthCheck) existing.healthCheck = healthCheck;
    existing.role = role || existing.role;
    return;
  }

  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid agent role '${role}' for '${name}'. Valid: ${[...VALID_ROLES].join(", ")}`);
  }

  _agents.set(name, {
    status: "stopped",
    role,
    module: module || null,
    healthCheck: healthCheck || null,
    health: {},
    startedAt: null,
    lastHeartbeat: null,
    errorCount: 0,
    lastError: null,
  });

  log("agent_registry", `Registered: ${name} (${role})`);
}

export function setAgentStatus(name, status, detail = "") {
  const agent = _agents.get(name);
  if (!agent) return false;
  if (!VALID_STATUSES.has(status)) return false;

  agent.status = status;
  if (status === "running" && !agent.startedAt) {
    agent.startedAt = new Date().toISOString();
  }
  if (status === "error") {
    agent.errorCount++;
    agent.lastError = detail;
  }
  agent.lastHeartbeat = new Date().toISOString();

  log("agent_registry", `${name}: ${status}${detail ? " — " + detail : ""}`);
  return true;
}

export function updateAgentHealth(name, healthData = {}) {
  const agent = _agents.get(name);
  if (!agent) return false;
  agent.health = { ...agent.health, ...healthData };
  agent.lastHeartbeat = new Date().toISOString();
  return true;
}

export function getAgentStatus(name) {
  const agent = _agents.get(name);
  if (!agent) return null;
  return {
    name,
    role: agent.role,
    status: agent.status,
    startedAt: agent.startedAt,
    lastHeartbeat: agent.lastHeartbeat,
    health: agent.health,
    errorCount: agent.errorCount,
    lastError: agent.lastError,
  };
}

export function getAllAgentStatuses() {
  const result = [];
  for (const [name, agent] of _agents) {
    result.push({
      name,
      role: agent.role,
      status: agent.status,
      startedAt: agent.startedAt,
      lastHeartbeat: agent.lastHeartbeat,
      health: agent.health,
      errorCount: agent.errorCount,
    });
  }
  return result;
}

export function getAgentsByRole(role) {
  return [..._agents.entries()]
    .filter(([, a]) => a.role === role)
    .map(([name]) => name);
}

export async function runHealthChecks() {
  const results = {};
  for (const [name, agent] of _agents) {
    if (typeof agent.healthCheck === "function") {
      try {
        const health = await agent.healthCheck();
        updateAgentHealth(name, { ...health, checkedAt: new Date().toISOString() });
        results[name] = { ok: true, ...health };
      } catch (e) {
        updateAgentHealth(name, { error: e.message });
        results[name] = { ok: false, error: e.message };
      }
    }
  }
  return results;
}

// Agents that are *intentionally* stopped (e.g. pro-orchestrator awaiting
// automation approval) — don't count them as failures in the running tally.
const INTENTIONALLY_LOCKED = new Set(["pro-orchestrator"]);

export function getDashboardSummary() {
  const agents = getAllAgentStatuses();
  const running = agents.filter(a => a.status === "running").length;
  const degraded = agents.filter(a => a.status === "degraded").length;
  const stopped = agents.filter(a => a.status === "stopped").length;
  const errored = agents.filter(a => a.status === "error").length;
  const locked = agents.filter(a => a.status === "stopped" && INTENTIONALLY_LOCKED.has(a.name)).length;
  // expected = total minus locked agents (which are not failures)
  const expected = agents.length - locked;

  return {
    total: agents.length,
    expected,
    running,
    degraded,
    stopped,
    errored,
    locked,
    agents,
    timestamp: new Date().toISOString(),
  };
}

export default {
  registerAgent,
  setAgentStatus,
  updateAgentHealth,
  getAgentStatus,
  getAllAgentStatuses,
  getAgentsByRole,
  runHealthChecks,
  getDashboardSummary,
};
