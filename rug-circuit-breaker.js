/**
 * Rug wave circuit breaker.
 *
 * Tracks rug exits in a rolling time window. If N rug exits occur within
 * the window, the circuit trips and blocks all new entries for lockDurationMs.
 * This is independent of the learning-mode / consecutive-loss system.
 */

export function createRugCircuitBreaker({
  maxEvents = 3,
  windowMs = 30 * 60 * 1000,
  lockDurationMs = 4 * 60 * 60 * 1000,
  log = () => {},
} = {}) {
  const events = [];
  let lockedUntil = 0;
  let lockReason = null;

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
      return { tripped: true, lockReason };
    }
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
  }

  return { recordExit, isLocked, getStatus, reset };
}
