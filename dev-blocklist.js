const _blocked = new Map();

export function blockDev({ address, reason = "" } = {}) {
  if (!address) return { error: "address required" };
  _blocked.set(address, { address, reason, added_at: new Date().toISOString() });
  return { saved: true, address, reason };
}
export function unblockDev({ address } = {}) {
  const existed = _blocked.delete(address);
  return { removed: existed, address };
}
export function isBlockedDev(address) { return _blocked.has(address); }
export function listBlockedDevs() { return Array.from(_blocked.values()); }
export function listBlockedDeployers() { return Array.from(_blocked.values()); }
