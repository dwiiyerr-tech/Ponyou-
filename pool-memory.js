const _notes = new Map();

export function getPoolMemory({ pool } = {}) {
  if (pool) return _notes.get(pool) || {};
  return Object.fromEntries(_notes);
}
export function addPoolNote({ pool, note } = {}) {
  if (!pool) return { error: "pool required" };
  const existing = _notes.get(pool) || { pool, notes: [] };
  existing.notes.push({ note, ts: new Date().toISOString() });
  _notes.set(pool, existing);
  return { saved: true, pool, note };
}
