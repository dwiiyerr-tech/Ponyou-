/**
 * rr-guard.js — Minimum Risk:Reward ratio gate for new entries.
 *
 * Rejects a candidate entry if the expected reward (TP distance) divided by
 * the risk (SL distance) is below a configurable threshold (default 1.5).
 *
 * When no explicit TP is configured, falls back to trailingTriggerPct as a
 * conservative proxy — the trailing stop activates at that gain, so it
 * represents the minimum captured profit in the best case.
 *
 * If neither TP nor trailing trigger is available, the check is skipped
 * (returns passes=true) so no entry is blocked by missing config.
 *
 * Pure functions — no I/O, no side effects, sub-millisecond.
 */

export const RR_DEFAULTS = {
  minRatio: 1.5,
};

/**
 * Compute R:R ratio and decide whether a trade setup clears the minimum.
 *
 * @param {number}      slPct              stop-loss % (must be negative, e.g. -12)
 * @param {number|null} tpPct              explicit take-profit % (positive), or null
 * @param {object}      [opts]
 * @param {number}      [opts.minRatio]    minimum R:R ratio (default 1.5)
 * @param {number|null} [opts.trailingTriggerPct] proxy TP when tpPct is absent
 * @returns {{
 *   passes:  boolean,
 *   ratio:   number|null,
 *   sl:      number,
 *   tp:      number|null,
 *   reason?: string,
 * }}
 */
export function checkRiskReward(
  slPct,
  tpPct,
  { minRatio = RR_DEFAULTS.minRatio, trailingTriggerPct = null } = {},
) {
  // SL must be a finite negative number — can't compute without it
  if (!Number.isFinite(slPct) || slPct >= 0) {
    return { passes: true, ratio: null, sl: slPct, tp: tpPct, reason: "sl_invalid_skip" };
  }

  // Resolve effective TP: explicit value first, then trailing proxy
  let effectiveTp = (Number.isFinite(tpPct) && tpPct > 0) ? tpPct : null;
  if (effectiveTp === null) {
    effectiveTp =
      Number.isFinite(trailingTriggerPct) && trailingTriggerPct > 0
        ? trailingTriggerPct
        : null;
  }

  // No TP reference available — skip the check rather than block all entries
  if (effectiveTp === null) {
    return { passes: true, ratio: null, sl: slPct, tp: null, reason: "tp_unknown_skip" };
  }

  const ratio = effectiveTp / Math.abs(slPct);
  const roundedRatio = Number(ratio.toFixed(2));
  const passes = roundedRatio >= minRatio;

  return {
    passes,
    ratio: roundedRatio,
    sl: slPct,
    tp: effectiveTp,
    ...(passes
      ? {}
      : {
          reason: `R:R ${roundedRatio} < ${minRatio} (SL=${slPct}% TP=${effectiveTp}%)`,
        }),
  };
}
