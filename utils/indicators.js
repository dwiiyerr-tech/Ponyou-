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

/**
 * Calculate volatility (ATR-based) as percentile
 * @param {Array} klines - Array of {high, low, close} candles
 * @param {number} atrPeriod - ATR calculation period
 * @returns {number} Volatility percentile 0-100
 */
export function calculateVolatilityPercentile(klines, atrPeriod = 14) {
  if (klines.length <= atrPeriod) return 50; // Default to medium vol

  const highs = klines.map(k => k.high || k.h);
  const lows = klines.map(k => k.low || k.l);
  const closes = klines.map(k => k.close || k.c);

  const atr = calculateATR(highs, lows, closes, atrPeriod);
  if (!atr) return 50;

  // Normalize ATR to percentile
  // Lower ATR = lower volatility = lower percentile
  const closePrice = closes[closes.length - 1];
  const atrPercent = (atr / closePrice) * 100;

  // Map to 0-100 percentile (adjust scaling as needed)
  // 0-2% = low vol (percentile 10)
  // 5-10% = medium vol (percentile 50)
  // 20%+ = high vol (percentile 90)
  const percentile = Math.min(100, (atrPercent / 0.2) * 100);
  return Math.max(0, percentile);
}

/**
 * Calculate Token Volatility from klines
 * @param {Array} klines - Array of {high, low, close, open} candles
 * @param {number} period - Lookback period (default 24 for 24h with 1h candles)
 * @returns {number} Volatility percentile 0-100
 */
export function calculateTokenVolatility(klines, period = 24) {
  if (klines.length < period) return 50; // Default if not enough data

  const recent = klines.slice(-period);
  const closes = recent.map(k => k.close || k.c);

  // Calculate standard deviation of returns
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const ret = (closes[i] - closes[i - 1]) / closes[i - 1];
    returns.push(ret);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Convert to percentile (0-100)
  // 0-1% return volatility = 10th percentile
  // 5% return volatility = 50th percentile
  // 20%+ return volatility = 90th percentile
  const percentile = Math.min(100, (stdDev * 100) * 10);
  return Math.max(0, percentile);
}
