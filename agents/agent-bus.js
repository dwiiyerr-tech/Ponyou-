/**
 * Agent Bus — In-process EventEmitter singleton for inter-agent communication.
 *
 * Topics:
 *   hunters:command          → Screening → Hunters (activate/deactivate, sources)
 *   hunters:prey_ready       → Hunters → Screening (hunting results)
 *   screening:decision       → Screening → Management (execute buy)
 *   screening:candidates     → Screening → General (LLM review needed)
 *   management:exit          → Management → General (exit executed)
 *   management:status        → Management → Dashboard (position state)
 *   market:update            → Market Intel → all agents
 *   general:telegram         → Telegram → General (user commands)
 *   general:report           → Cron → General (daily reports)
 *
 * Pattern:
 *   emit(topic, payload)     — fire-and-forget
 *   request(topic, payload, timeoutMs) — returns Promise<response>
 */

import { EventEmitter } from "events";

class AgentBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._pendingRequests = new Map(); // id → { resolve, reject, timer }
    this._reqId = 0;
  }

  // ── Fire-and-forget ──────────────────────────────────────────

  emit(topic, payload) {
    return super.emit(topic, payload);
  }

  // ── Request-Response (for LLM decisions, async agent ops) ────

  request(topic, payload, timeoutMs = 30000) {
    if (!topic || typeof topic !== "string") {
      return Promise.reject(new Error("AgentBus.request: topic is required"));
    }
    return new Promise((resolve, reject) => {
      const id = ++this._reqId;
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`AgentBus request '${topic}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timer });
      this.emit(topic, { ...payload, _reqId: id });
    });
  }

  respond(reqId, response) {
    const pending = this._pendingRequests.get(reqId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingRequests.delete(reqId);
    pending.resolve(response);
    return true;
  }

  get pendingCount() {
    return this._pendingRequests.size;
  }

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Subscribe to a topic with automatic cleanup reference.
   * Returns an unsubscribe function.
   */
  subscribe(topic, handler) {
    // Warn if any single topic accumulates too many listeners, which is the
    // classic agent-restart leak pattern (every restart adds a new subscriber
    // and the old one never gets cleaned up because the agent didn't call
    // the unsubscribe function on shutdown).
    const current = this.listenerCount(topic);
    if (current >= 20) {
      console.warn(`[agent-bus] ${topic} has ${current} listeners — possible leak from agent restart cycles`);
    }
    this.on(topic, handler);
    return () => this.off(topic, handler);
  }

  /**
   * Remove all listeners for a topic. Use this in agent shutdown to
   * explicitly prevent listener leaks across restart cycles.
   */
  clearTopic(topic) {
    this.removeAllListeners(topic);
  }

  /**
   * List active topics with listener counts (for dashboard / health checks).
   */
  getActiveTopics() {
    const names = this.eventNames();
    return names.map(name => ({ topic: name, listeners: this.listenerCount(name) }));
  }
}

// Singleton
export const agentBus = new AgentBus();
export default agentBus;
