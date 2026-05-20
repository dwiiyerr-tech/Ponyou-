export const SEVERITY = Object.freeze({
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
});

export function aggregateSeverity(perDetector) {
  const values = Object.values(perDetector || {});
  if (values.length === 0) return SEVERITY.NONE;
  return Math.max(SEVERITY.NONE, ...values);
}

export function shouldEmit(newSev, lastSev) {
  return newSev > lastSev;
}

export function detectDevSell({ balanceAtEntry, currentBalance, thresholds }) {
  if (!Number.isFinite(balanceAtEntry) || balanceAtEntry <= 0) return SEVERITY.NONE;
  if (!Number.isFinite(currentBalance)) return SEVERITY.NONE;
  const deltaPct = ((currentBalance - balanceAtEntry) / balanceAtEntry) * 100;
  if (deltaPct >= 0) return SEVERITY.NONE;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  if (thresholds.medium !== null && deltaPct <= thresholds.medium) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

export const BURN_ADDRESSES = Object.freeze([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

export const LP_PROGRAMS = Object.freeze({
  raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
});

export function detectLpMovement({ lpAtEntry, currentLp, transferTo = null, removeLiquidityBy = null, deployerWallet = null, thresholds }) {
  if (removeLiquidityBy && deployerWallet && removeLiquidityBy === deployerWallet) return SEVERITY.HIGH;
  if (transferTo && BURN_ADDRESSES.includes(transferTo)) return SEVERITY.NONE;
  if (!Number.isFinite(lpAtEntry) || lpAtEntry <= 0) return SEVERITY.NONE;
  if (!Number.isFinite(currentLp)) return SEVERITY.NONE;
  const deltaPct = ((currentLp - lpAtEntry) / lpAtEntry) * 100;
  if (deltaPct >= 0) return SEVERITY.NONE;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  const mediumThreshold = thresholds.high === null && thresholds.medium !== null
    ? Math.max(thresholds.medium, thresholds.low * 2)
    : thresholds.medium;
  if (mediumThreshold !== null && deltaPct <= mediumThreshold) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}

export function detectAuthorityChange({ atEntry, current }) {
  const entryMint = atEntry?.mint_authority ?? null;
  const currMint = current?.mint_authority ?? null;
  const entryFreeze = atEntry?.freeze_authority ?? null;
  const currFreeze = current?.freeze_authority ?? null;
  const becameSet = (a, b) => a === null && b !== null;
  const transferredToBurn = (a, b) => a !== null && b !== null && a !== b && BURN_ADDRESSES.includes(b);
  if (becameSet(entryMint, currMint) && !BURN_ADDRESSES.includes(currMint)) return SEVERITY.HIGH;
  if (becameSet(entryFreeze, currFreeze) && !BURN_ADDRESSES.includes(currFreeze)) return SEVERITY.HIGH;
  if (transferredToBurn(entryMint, currMint) || transferredToBurn(entryFreeze, currFreeze)) return SEVERITY.LOW;
  return SEVERITY.NONE;
}
