const _decisions = [];

export function recordDecision(decision = {}) {
  _decisions.push({ ...decision, ts: new Date().toISOString() });
  if (_decisions.length > 100) _decisions.shift();
}
export function getRecentDecisions(limit = 6) {
  return _decisions.slice(-limit);
}
