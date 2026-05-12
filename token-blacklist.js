const _blacklist = new Map();

export function addToBlacklist({ mint, reason = "" } = {}) {
  if (!mint) return { error: "mint required" };
  _blacklist.set(mint, { mint, reason, added_at: new Date().toISOString() });
  return { saved: true, mint, reason };
}
export function removeFromBlacklist({ mint } = {}) {
  const existed = _blacklist.delete(mint);
  return { removed: existed, mint };
}
export function isBlacklisted(mint) { return _blacklist.has(mint); }
export function listBlacklist() { return Array.from(_blacklist.values()); }
