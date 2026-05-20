export const REGIMES = Object.freeze({
  HOT:     "HOT",
  WARM:    "WARM",
  NORMAL:  "NORMAL",
  COLD:    "COLD",
  DEAD:    "DEAD",
  EXTREME: "EXTREME",
});

export const ALL_REGIMES = new Set(Object.values(REGIMES));

export function normalizeRegime(value, fallback = REGIMES.NORMAL) {
  if (!value) return fallback;
  const upper = String(value).toUpperCase().trim();
  return ALL_REGIMES.has(upper) ? upper : fallback;
}

export function isActiveRegime(regime) {
  const r = normalizeRegime(regime);
  return r === REGIMES.HOT || r === REGIMES.WARM || r === REGIMES.NORMAL;
}

export function isTradingAllowed(regime) {
  const r = normalizeRegime(regime);
  return r !== REGIMES.DEAD && r !== REGIMES.EXTREME;
}
