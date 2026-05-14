/**
 * TUI Event Bridge — decouples logger/agent from the TUI renderer.
 * Any module can emit events here; tui.js listens and updates panels.
 */

import { EventEmitter } from "events";

export const tuiEvents = new EventEmitter();
tuiEvents.setMaxListeners(50);

// Convenience emitters used by logger.js and agent.js
export function emitLog(category, message) {
  tuiEvents.emit("log", { category, message, ts: Date.now() });
}

export function emitTrade(data) {
  tuiEvents.emit("trade", data);
}

export function emitPositions(positions) {
  tuiEvents.emit("positions", positions);
}

export function emitBalance(balance) {
  tuiEvents.emit("balance", balance);
}

export function emitCandidate(token) {
  tuiEvents.emit("candidate", token);
}

export function emitStep(step, maxSteps) {
  tuiEvents.emit("step", { step, maxSteps });
}
