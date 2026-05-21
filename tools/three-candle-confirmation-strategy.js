/**
 * ThreeCandleConfirmationStrategy
 * Staged-entry guard for sharp red candles. Analysis only; never executes trades.
 */

export const CandleStrategyState = Object.freeze({
  OBSERVING: "OBSERVING",
  FIRST_RED_DETECTED: "FIRST_RED_DETECTED",
  WAITING_FIRST_DIP: "WAITING_FIRST_DIP",
  FIRST_DIP_CONFIRMED: "FIRST_DIP_CONFIRMED",
  WAITING_BOUNCE: "WAITING_BOUNCE",
  MARK_POSITION_READY: "MARK_POSITION_READY",
  MARK_POSITION_OPEN: "MARK_POSITION_OPEN",
  WAITING_SECOND_DIP: "WAITING_SECOND_DIP",
  SECOND_DIP_CONFIRMED: "SECOND_DIP_CONFIRMED",
  FULL_ENTRY_READY: "FULL_ENTRY_READY",
  INVALIDATED: "INVALIDATED",
});

export const AgentAction = Object.freeze({
  WAIT: "WAIT",
  BLOCK_ENTRY: "BLOCK_ENTRY",
  MARK_POSITION: "MARK_POSITION",
  HOLD_MARK: "HOLD_MARK",
  FULL_ENTRY: "FULL_ENTRY",
  RESET: "RESET",
});

const DEFAULTS = Object.freeze({
  sharpRedPercent: -8,
  minBouncePercent: 3,
  minSecondDipPercent: 4,
  confirmationThreshold: 3,
  markPositionFraction: 0.1,
  maxChasePumpPercent: 35,
  maxMarkDrawdownPercent: -12,
});

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function last(list) {
  return Array.isArray(list) && list.length ? list[list.length - 1] : null;
}

function candleChangePct(candle) {
  const open = number(candle?.open ?? candle?.o, NaN);
  const close = number(candle?.close ?? candle?.c, NaN);
  if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(close)) return 0;
  return ((close - open) / open) * 100;
}

function isGreen(candle) {
  return candleChangePct(candle) > 0;
}

function hasHigherLow(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return false;
  const current = last(candles);
  const previous = candles[candles.length - 2];
  const currentLow = number(current?.low ?? current?.l, NaN);
  const previousLow = number(previous?.low ?? previous?.l, NaN);
  return Number.isFinite(currentLow) && Number.isFinite(previousLow) && currentLow > previousLow;
}

function roundSize(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function buildSizing(basePositionSizeSol, markPositionFraction, action) {
  const base = Math.max(0, number(basePositionSizeSol, 1));
  const mark = roundSize(base * markPositionFraction);
  const remaining = roundSize(Math.max(0, base - mark));
  const suggestedSizeSol = action === AgentAction.MARK_POSITION
    ? mark
    : action === AgentAction.FULL_ENTRY
      ? remaining
      : 0;

  return {
    basePositionSizeSol: base,
    markPositionFraction,
    markPositionSizeSol: mark,
    fullEntrySizeSol: remaining,
    suggestedSizeSol,
  };
}

function buildConfirmationChecklist(input, candles, cfg) {
  const current = last(candles);
  const pricePumpPercent = number(input.pricePumpPercent);
  const checklist = [
    {
      check: "buy_pressure",
      pass: number(input.buyPressurePercent) >= 55,
      value: number(input.buyPressurePercent),
    },
    {
      check: "relative_volume",
      pass: number(input.volumeRatio, 1) >= 1.2,
      value: number(input.volumeRatio, 1),
    },
    {
      check: "green_reversal_candle",
      pass: typeof input.greenReversal === "boolean" ? input.greenReversal : isGreen(current),
      value: candleChangePct(current),
    },
    {
      check: "higher_low",
      pass: typeof input.higherLow === "boolean" ? input.higherLow : hasHigherLow(candles),
      value: input.higherLow ?? hasHigherLow(candles),
    },
    {
      check: "not_chasing_extended_pump",
      pass: pricePumpPercent <= cfg.maxChasePumpPercent,
      value: pricePumpPercent,
    },
  ];

  return {
    checklist,
    confirmationScore: checklist.filter(item => item.pass).length,
  };
}

/**
 * @typedef {object} CandleStrategyInput
 * @property {string} [state]
 * @property {Array<object>} candles
 * @property {number} [buyPressurePercent]
 * @property {number} [volumeRatio]
 * @property {boolean} [greenReversal]
 * @property {boolean} [higherLow]
 * @property {number} [pricePumpPercent]
 * @property {number} [bouncePercent]
 * @property {number} [secondDipPercent]
 * @property {number} [drawdownFromMarkPercent]
 * @property {number} [basePositionSizeSol]
 *
 * @typedef {object} CandleStrategyOutput
 * @property {string} state
 * @property {string} nextState
 * @property {string} action
 * @property {number} confirmationScore
 * @property {Array<object>} checklist
 * @property {object} positionSizing
 * @property {string[]} reasons
 */

/**
 * @param {CandleStrategyInput} input
 * @param {Partial<typeof DEFAULTS>} overrides
 * @returns {CandleStrategyOutput}
 */
export function analyzeThreeCandleConfirmation(input = {}, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const candles = Array.isArray(input.candles) ? input.candles : [];
  const state = CandleStrategyState[input.state] || input.state || CandleStrategyState.OBSERVING;
  const reasons = [];
  const { checklist, confirmationScore } = buildConfirmationChecklist(input, candles, cfg);

  const done = (action, nextState, extraReasons = []) => ({
    state,
    nextState,
    action,
    confirmationScore,
    checklist,
    positionSizing: buildSizing(input.basePositionSizeSol, cfg.markPositionFraction, action),
    reasons: [...reasons, ...extraReasons],
  });

  if (candles.length < 3) {
    return done(AgentAction.WAIT, CandleStrategyState.OBSERVING, ["Need at least 3 candles before staged-entry analysis"]);
  }

  const current = last(candles);
  const currentChange = candleChangePct(current);
  const pricePumpPercent = number(input.pricePumpPercent);
  const bouncePercent = number(input.bouncePercent);
  const secondDipPercent = number(input.secondDipPercent);
  const drawdownFromMarkPercent = number(input.drawdownFromMarkPercent);

  if (input.invalidated || drawdownFromMarkPercent <= cfg.maxMarkDrawdownPercent) {
    return done(AgentAction.RESET, CandleStrategyState.INVALIDATED, ["Mark setup invalidated before full entry"]);
  }

  if (pricePumpPercent > cfg.maxChasePumpPercent) {
    return done(AgentAction.BLOCK_ENTRY, CandleStrategyState.WAITING_FIRST_DIP, ["Price already extended; block FOMO entry"]);
  }

  if (currentChange <= cfg.sharpRedPercent && (
    state === CandleStrategyState.OBSERVING ||
    state === CandleStrategyState.FIRST_RED_DETECTED ||
    state === CandleStrategyState.WAITING_FIRST_DIP
  )) {
    return done(AgentAction.BLOCK_ENTRY, CandleStrategyState.WAITING_FIRST_DIP, ["Sharp red candle detected; wait for first dip and bounce"]);
  }

  if (state === CandleStrategyState.WAITING_FIRST_DIP || state === CandleStrategyState.WAITING_BOUNCE) {
    if (bouncePercent >= cfg.minBouncePercent && confirmationScore >= cfg.confirmationThreshold) {
      return done(AgentAction.MARK_POSITION, CandleStrategyState.MARK_POSITION_OPEN, ["First-dip bounce confirmed; mark position only"]);
    }

    return done(AgentAction.WAIT, CandleStrategyState.WAITING_BOUNCE, ["First-dip bounce not confirmed"]);
  }

  if (state === CandleStrategyState.MARK_POSITION_READY) {
    if (confirmationScore >= cfg.confirmationThreshold) {
      return done(AgentAction.MARK_POSITION, CandleStrategyState.MARK_POSITION_OPEN, ["Mark position ready after confirmation checklist"]);
    }

    return done(AgentAction.WAIT, CandleStrategyState.WAITING_BOUNCE, ["Mark position blocked by weak confirmation checklist"]);
  }

  if (state === CandleStrategyState.MARK_POSITION_OPEN || state === CandleStrategyState.WAITING_SECOND_DIP) {
    if (secondDipPercent <= -cfg.minSecondDipPercent) {
      if (confirmationScore >= cfg.confirmationThreshold) {
        return done(AgentAction.FULL_ENTRY, CandleStrategyState.FULL_ENTRY_READY, ["Second dip confirmed with buy pressure and volume"]);
      }

      return done(AgentAction.HOLD_MARK, CandleStrategyState.WAITING_SECOND_DIP, ["Second dip present, but confirmation score below threshold"]);
    }

    return done(AgentAction.HOLD_MARK, CandleStrategyState.WAITING_SECOND_DIP, ["Holding mark while waiting for second dip"]);
  }

  if (confirmationScore < cfg.confirmationThreshold) {
    return done(AgentAction.WAIT, CandleStrategyState.OBSERVING, ["Confirmation checklist below threshold"]);
  }

  return done(AgentAction.WAIT, CandleStrategyState.OBSERVING, ["No staged-entry trigger"]);
}
