const _wallets = new Map();

export function addSmartWallet({ address, label = "" } = {}) {
  if (!address) return { error: "address required" };
  _wallets.set(address, { address, label, added_at: new Date().toISOString() });
  return { saved: true, address, label };
}
export function removeSmartWallet({ address } = {}) {
  const existed = _wallets.delete(address);
  return { removed: existed, address };
}
export function listSmartWallets() { return Array.from(_wallets.values()); }
