import { normalizeRegime } from "./market-regime.js";

export function computeRegimeSizeMultiplier(currentSolPrice, prevSolPrice, marketCondition = "NORMAL") {
  const condition = normalizeRegime(marketCondition, "NORMAL");
  if (condition === "DEAD") return 0;

  const current = Number(currentSolPrice);
  const previous = Number(prevSolPrice);
  if (Number.isFinite(current) && current > 0 && Number.isFinite(previous) && previous > 0) {
    const dropPct = (previous - current) / previous;
    if (dropPct > 0.05) return 0.25;
  }

  if (condition === "COLD") return 0.5;
  return 1;
}
