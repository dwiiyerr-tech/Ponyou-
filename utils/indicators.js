/**
 * Technical Indicators for Ponyou Agent.
 * Standard formulas for RSI, SMA, EMA, and SuperTrend.
 */

/**
 * Relative Strength Index (RSI)
 * @param {Array<number>} closes - Array of closing prices
 * @param {number} period - RSI period (standard is 14, user requested 2)
 */
export function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    let gain = 0;
    let loss = 0;
    if (diff >= 0) gain = diff;
    else loss = -diff;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Average True Range (ATR) - used for SuperTrend
 */
export function calculateATR(highs, lows, closes, period = 10) {
  if (closes.length <= period) return null;

  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  const atr = [];
  let sum = trs.slice(0, period).reduce((a, b) => a + b, 0);
  atr.push(sum / period);

  for (let i = period; i < trs.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + trs[i]) / period);
  }

  return atr;
}

/**
 * SuperTrend Indicator
 * Returns { trend: 'up'|'down', value: number }
 */
export function calculateSuperTrend(highs, lows, closes, period = 10, multiplier = 3) {
  const atr = calculateATR(highs, lows, closes, period);
  if (!atr) return null;

  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  let upperBand = hl2.map((val, i) => val + multiplier * (atr[i - period + 1] || 0));
  let lowerBand = hl2.map((val, i) => val - multiplier * (atr[i - period + 1] || 0));

  let superTrend = new Array(closes.length).fill(0);
  let trend = new Array(closes.length).fill('up');

  for (let i = 1; i < closes.length; i++) {
    const prevClose = closes[i - 1];
    const currUpper = upperBand[i];
    const currLower = lowerBand[i];
    const prevUpper = upperBand[i - 1];
    const prevLower = lowerBand[i - 1];

    if (currUpper < prevUpper || prevClose > prevUpper) upperBand[i] = currUpper;
    else upperBand[i] = prevUpper;

    if (currLower > prevLower || prevClose < prevLower) lowerBand[i] = currLower;
    else lowerBand[i] = prevLower;

    if (superTrend[i - 1] === prevUpper) {
      trend[i] = closes[i] > upperBand[i] ? 'up' : 'down';
    } else {
      trend[i] = closes[i] < lowerBand[i] ? 'down' : 'up';
    }

    superTrend[i] = trend[i] === 'up' ? lowerBand[i] : upperBand[i];
  }

  return {
    trend: trend[trend.length - 1],
    value: superTrend[superTrend.length - 1],
    all: superTrend
  };
}
