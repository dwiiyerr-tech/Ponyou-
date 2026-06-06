// kelly-mode-selector.js
export const KELLY_MODES = Object.freeze({
  CONSERVATIVE: "Mode1_Conservative",
  ADAPTIVE:     "Mode2_Adaptive",
  FULL_KELLY:   "Mode3_FullKelly",
});

const MODE3_MIN_LIVE_TRADES        = 50;
const MODE3_MIN_WIN_RATE           = 0.70;
const MODE3_MIN_CONVICTION         = 0.99;
const MODE3_MIN_SEMANTIC_ENTRIES   = 200;

const MODE2_MIN_LIVE_TRADES = 20;
const MODE2_MIN_WIN_RATE    = 0.80;
const MODE2_MIN_CONVICTION  = 0.70;

/**
 * @param {object} opts
 * @param {number} opts.bankrollSol
 * @param {number} [opts.deployedSol=0]
 * @param {number} [opts.maxPositions=3]
 * @param {number} [opts.winRate=0]
 * @param {number} [opts.liveTrades=0]
 * @param {number} [opts.conviction=0]
 * @param {boolean} [opts.mode3Approved=false]
 * @param {number} [opts.semanticMemoryEntries=0]
 * @returns {{ mode: string, effectiveBankroll: number, reason: string }}
 */
export function selectKellyMode({
  bankrollSol,
  deployedSol = 0,
  maxPositions = 3,
  winRate = 0,
  liveTrades = 0,
  conviction = 0,
  mode3Approved = false,
  semanticMemoryEntries = 0,
}) {
  if (
    mode3Approved &&
    liveTrades >= MODE3_MIN_LIVE_TRADES &&
    winRate >= MODE3_MIN_WIN_RATE &&
    conviction >= MODE3_MIN_CONVICTION &&
    semanticMemoryEntries >= MODE3_MIN_SEMANTIC_ENTRIES
  ) {
    return {
      mode: KELLY_MODES.FULL_KELLY,
      effectiveBankroll: bankrollSol,
      reason: `Mode3: all unlock criteria met + operator approved (trades=${liveTrades}, winRate=${winRate}, conviction=${conviction})`,
    };
  }

  if (
    liveTrades >= MODE2_MIN_LIVE_TRADES &&
    winRate >= MODE2_MIN_WIN_RATE &&
    conviction >= MODE2_MIN_CONVICTION
  ) {
    return {
      mode: KELLY_MODES.ADAPTIVE,
      effectiveBankroll: Math.max(0, bankrollSol - deployedSol),
      reason: `Mode2: winRate=${winRate} trades=${liveTrades} conviction=${conviction}`,
    };
  }

  const slots = Math.max(1, maxPositions);
  return {
    mode: KELLY_MODES.CONSERVATIVE,
    effectiveBankroll: bankrollSol / slots,
    reason: `Mode1: winRate=${winRate} trades=${liveTrades} below Mode2 threshold (need wr>=${MODE2_MIN_WIN_RATE} trades>=${MODE2_MIN_LIVE_TRADES})`,
  };
}
