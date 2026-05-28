/**
 * Agents Module — Multi-Agent System for Ponyou
 *
 * Exports all agents and the communication bus:
 *
 *   agentBus          — Inter-agent EventEmitter (singleton)
 *   agentRegistry     — Lifecycle + health tracking
 *   Hunters Agent     — No-LLM token discovery workers ("kuli")
 *   Screening Agent   — Pipeline orchestrator (min LLM)
 *   Management Agent  — Position exits + plan execution (no LLM)
 *   General Agent     — LLM decisions + Telegram (LLM only)
 */

export { agentBus } from "./agent-bus.js";
export {
  registerAgent,
  setAgentStatus,
  updateAgentHealth,
  getAgentStatus,
  getAllAgentStatuses,
  getAgentsByRole,
  runHealthChecks,
  getDashboardSummary,
} from "./agent-registry.js";

export {
  initHuntersAgent,
  runHuntersExpedition,
  getHuntersPrey,
  getHuntersDashboard,
  HUNTER_SCHEDULE,
} from "./hunters-agent.js";

export {
  initScreeningAgent,
  runScreeningCycle as runScreeningCycleViaAgent,
  getScreeningDashboard,
} from "./screening-agent.js";

export {
  initManagementAgent,
  runManagementCycle as runManagementCycleViaAgent,
  setLLMReviewEnabled,
  getManagementAgentStatus,
} from "./management-agent.js";

export {
  initGeneralAgent,
  getGeneralAgentStatus,
} from "./general-agent.js";

export {
  initTrashLayer,
  getTrashLayerStats,
} from "./trash-layer.js";

export {
  initLearningAgent,
  getLearningStats,
  getStrategyPerformance,
} from "./learning-agent.js";
