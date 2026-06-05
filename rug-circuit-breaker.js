/**
 * Rug wave circuit breaker.
 *
 * Tracks rug exits in a rolling time window. If N rug exits occur within
 * the window, the circuit trips and blocks all new entries for lockDurationMs.
 * This is independent of the learning-mode / consecutive-loss system.
 */

import fs from "fs";
import { atomicWriteJson } from "./atomic-write.js";

export function createRugCircuitBreaker({
  maxEvents = 3,
  windowMs = 30 * 60 * 1000,
  lockDurationMs = 4 * 60 * 60 * 1000,
  persistPath = null,
  log = () => {},
} = {}) {
  const events = [];
  let lockedUntil = 0;
  let lockReason = null;

  // Restore persisted state so a restart doesn't reset an active lock
  if (persistPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(persistPath, "utf8"));
      if (raw.lockedUntil && Date.now() < raw.lockedUntil) {
        lockedUntil = raw.lockedUntil;
        lockReason = raw.lockReason || null;
        if (Array.isArray(raw.events)) events.push(...raw.events);
        log("rug_circuit_breaker", `Restored lock from disk — ${Math.ceil((lockedUntil - Date.now()) / 60000)}min remaining`);
      }
    } catch {
      // No persisted state — start fresh
    }
  }

  function _persist() {
    if (!persistPath) return;
    try {
      atomicWriteJson(persistPath, { lockedUntil, lockReason, events });
    } catch (e) {
      log("rug_circuit_breaker", `persist failed: ${e.message}`);
    }
  }

  function _prune(now = Date.now()) {
    const cutoff = now - windowMs;
    while (events.length > 0 && events[0].ts < cutoff) events.shift();
  }

  function recordExit(mint, reason, now = Date.now()) {
    _prune(now);
    events.push({ mint, reason, ts: now });

    if (!isLocked(now) && events.length >= maxEvents) {
      lockedUntil = now + lockDurationMs;
      lockReason = `${events.length} rug exits in ${Math.round(windowMs / 60000)}min window`;
      log("rug_circuit_breaker", `TRIPPED: ${lockReason}`);
      _persist();
      return { tripped: true, lockReason };
    }
    _persist();
    return { tripped: false };
  }

  function isLocked(now = Date.now()) {
    return lockedUntil > now;
  }

  function getStatus(now = Date.now()) {
    _prune(now);
    const locked = isLocked(now);
    return {
      locked,
      lockedUntil: locked ? lockedUntil : null,
      resumeInMin: locked ? Math.ceil((lockedUntil - now) / 60000) : 0,
      lockReason: locked ? lockReason : null,
      recentCount: events.length,
      maxEvents,
      windowMs,
    };
  }

  function reset() {
    events.length = 0;
    lockedUntil = 0;
    lockReason = null;
    _persist();
  }

  return { recordExit, isLocked, getStatus, reset };
}
