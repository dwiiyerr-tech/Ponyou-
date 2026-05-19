function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

export function analyzeCapitalAwareWalletPlan({
  wallets = [],
  totalSol = 0,
  desiredAmountSol = 0,
  reserveSol = 0.2,
  maxEntries = 1,
  minTotalSol = 3,
  minWalletDeploySol = null,
} = {}) {
  const minPerWallet = minWalletDeploySol != null ? Math.max(minWalletDeploySol, maxEntries > 1 ? round(desiredAmountSol / maxEntries) : desiredAmountSol * 0.8) : Math.max(0.1, desiredAmountSol * 0.8);
  const hotWallets = wallets
    .filter(w => w && w.status !== "cold" && w.status !== "disabled")
    .map(w => {
      const capitalPct = Number(w.capital_pct || 0);
      const allocSol = totalSol * capitalPct / 100;
      const freeSol = Math.max(0, allocSol - reserveSol);
      return {
        ...w,
        alloc_sol: round(allocSol),
        free_sol: round(freeSol),
        can_deploy: freeSol >= minPerWallet,
      };
    })
    .sort((a, b) => b.free_sol - a.free_sol || Number(b.is_active) - Number(a.is_active));

  const viable = hotWallets.filter(w => w.can_deploy);
  const spreadReady = totalSol >= minTotalSol && desiredAmountSol > 0 && viable.length >= 2;
  const entryCount = Math.max(1, Math.min(maxEntries || 1, viable.length || 1));
  const selectedBase = spreadReady ? viable.slice(0, entryCount) : viable.slice(0, 1);
  const perWalletAmount = selectedBase.length > 0
    ? (spreadReady ? desiredAmountSol / selectedBase.length : desiredAmountSol)
    : desiredAmountSol;
  const selected = selectedBase.map(w => ({
    address: w.address,
    label: w.label,
    deploy_amount_sol: round(Math.min(perWalletAmount, w.free_sol)),
    capital_pct: w.capital_pct,
    free_sol: w.free_sol,
  }));

  return {
    spread_ready: spreadReady,
    total_sol: round(totalSol),
    desired_amount_sol: round(desiredAmountSol),
    viable_wallets: viable.length,
    selected_wallets: selected,
    summary: spreadReady
      ? `Capital cukup untuk menyebar entry ke ${selected.length} wallet`
      : `Gunakan 1 wallet utama dulu`,
  };
}
