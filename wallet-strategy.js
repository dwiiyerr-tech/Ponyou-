import { listTrackedPositions } from "./state.js";

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

export function planWalletExecution({
  wallets = [],
  tokenMint,
  amountSol,
  mode = "entry",
  maxWallets = 1,
  splitThresholdSol = 5,
} = {}) {
  const openPositions = listTrackedPositions(tokenMint, { open_only: true });
  const walletsWithPosition = new Set(openPositions.map(p => p.wallet_address).filter(Boolean));

  const viable = wallets
    .filter(w => w && w.status !== "cold" && w.status !== "disabled")
    .map(w => ({
      ...w,
      has_position: walletsWithPosition.has(w.address),
    }));

  let preferred = viable;
  if (mode === "dca") {
    preferred = viable.filter(w => !w.has_position);
  } else if (mode === "sell") {
    preferred = viable.filter(w => w.has_position);
  }

  if (preferred.length === 0 && mode !== "sell") preferred = viable;

  const shouldSplit = mode === "entry" && amountSol >= splitThresholdSol && preferred.length > 1;
  const selected = shouldSplit ? preferred.slice(0, Math.min(maxWallets, preferred.length)) : preferred.slice(0, 1);
  const splitAmount = selected.length > 0 ? round(amountSol / selected.length) : round(amountSol);

  return {
    mode,
    split: shouldSplit,
    selected_wallets: selected.map(w => ({
      address: w.address,
      label: w.label,
      has_position: w.has_position,
      amount_sol: splitAmount,
    })),
    wallets_with_position: [...walletsWithPosition],
  };
}
