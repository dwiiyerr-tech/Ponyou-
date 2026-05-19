function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getHolderMemoryRules() {
  return [
    "Holder concentration tidak bisa dibaca naif dari satu wallet terbesar saja.",
    "Multi-wallet, same-funder cluster, dan bundle buyers lebih penting daripada angka 3% atau 5% tunggal.",
    "Top10 tinggi adalah warning, bukan auto-skip, terutama saat narasi kuat dan market cap sudah lebih matang.",
    "Fokus pada siapa yang terlihat terkoordinasi, bukan hanya siapa yang terlihat besar.",
  ];
}

export function analyzeHolderStructure({ rugSignals = {}, holders = [], token = {} } = {}) {
  const top10Pct = Number(rugSignals.top10_concentration_pct || 0);
  const sameFunder = Number(rugSignals.same_funder_holders || 0);
  const bundleBuyersPct = Number(rugSignals.bundle_buyers_pct || 0);
  const freshFunded = Number(rugSignals.fresh_funded_holders || 0);
  const dustHolders = Number(rugSignals.dust_holders || 0);
  const maxHolderPct = Math.max(0, ...holders.map(h => Number(h?.pct || 0)));
  const mcap = Number(token.mcap || token.market_cap || 0);
  const hotLevel = Number(token.hot_level || 0);
  const narrativeStrength = Array.isArray(token.narrative_tags) ? token.narrative_tags.length : 0;

  const contextAllowsConcentration =
    mcap >= 1_000_000 ||
    hotLevel >= 2 ||
    narrativeStrength >= 2;

  let hiddenControlScore = 0;
  hiddenControlScore += clamp((sameFunder / 5) * 40, 0, 40);
  hiddenControlScore += clamp((bundleBuyersPct / 40) * 25, 0, 25);
  hiddenControlScore += clamp((freshFunded / 6) * 20, 0, 20);
  hiddenControlScore += clamp((dustHolders / 6) * 10, 0, 10);
  hiddenControlScore += top10Pct > 70 ? 10 : top10Pct > 55 ? 5 : 0;
  hiddenControlScore = Math.round(clamp(hiddenControlScore, 0, 100));

  let structureRisk = "LOW";
  if (sameFunder >= 4 || hiddenControlScore >= 70) structureRisk = "HIGH";
  else if (hiddenControlScore >= 40 || (!contextAllowsConcentration && top10Pct >= 60)) structureRisk = "MEDIUM";

  const notes = [];
  if (sameFunder >= 3) notes.push(`${sameFunder} holder top terlihat share funder, indikasi kontrol terselubung`);
  if (bundleBuyersPct >= 25) notes.push(`${bundleBuyersPct}% launch window dibeli bundle buyers`);
  if (freshFunded >= 5) notes.push(`${freshFunded} holder top didanai sangat baru`);
  if (contextAllowsConcentration && maxHolderPct >= 7) notes.push("Konsentrasi wallet besar masih bisa wajar karena narasi/ukuran token kuat");
  if (!contextAllowsConcentration && maxHolderPct >= 5) notes.push("Wallet besar di fase awal lebih berbahaya karena konteks belum cukup kuat");

  return {
    max_holder_pct: Number(maxHolderPct.toFixed(2)),
    top10_pct: Number(top10Pct.toFixed(2)),
    context_allows_concentration: contextAllowsConcentration,
    hidden_wallet_control_score: hiddenControlScore,
    holder_structure_risk: structureRisk,
    notes,
    summary: structureRisk === "HIGH"
      ? "Distribusi holder terlihat terpecah tapi perilakunya menunjukkan koordinasi."
      : contextAllowsConcentration
        ? "Konsentrasi holder perlu dibaca dengan konteks narasi dan ukuran pasar."
        : "Distribusi holder belum punya konteks kuat, jadi cluster perilaku harus diprioritaskan.",
  };
}
