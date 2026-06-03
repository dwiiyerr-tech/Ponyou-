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
  // calculateATR returns array of ATR values; ambil nilai terakhir (current ATR)
  if (!atr || !Array.isArray(atr) || atr.length === 0) return 50;
  const atrLast = atr[atr.length - 1];
  const closePrice = closes[closes.length - 1];
  if (!Number.isFinite(atrLast) || !Number.isFinite(closePrice) || closePrice <= 0) return 50;

  // ATR sebagai % harga. Mapping ke percentile:
  //   2% ATR → 20 (low-med), 5% → 50 (medium), 10% → 100 (cap)
  const atrPercent = (atrLast / closePrice) * 100;
  const percentile = Math.min(100, (atrPercent / 10) * 100);
  return Math.max(0, percentile);
}

/**
 * Exponential Moving Average (EMA) — building block for MACD + EMA-cross.
 * Returns an array of EMA values aligned to the input (first `period-1`
 * entries are seeded with the SMA, then EMA-smoothed).
 * @param {Array<number>} values
 * @param {number} period
 * @returns {Array<number>|null}
 */
export function calculateEMA(values, period = 9) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  const ema = [];
  // Seed with SMA of first `period` values
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  // Pad the lead-in so the array length matches input
  for (let i = 0; i < period - 1; i++) ema.push(null);
  ema.push(seed);
  for (let i = period; i < values.length; i++) {
    ema.push(values[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

/**
 * MACD (Moving Average Convergence Divergence).
 * Standard (12, 26, 9). Returns the latest reading + trend.
 *   macd       = EMA(fast) - EMA(slow)
 *   signal     = EMA(macd, signalPeriod)
 *   histogram  = macd - signal   (>0 bullish momentum, rising = accelerating)
 *   trend      = "bullish" | "bearish" | "neutral"
 *   cross      = "bullish_cross" | "bearish_cross" | null  (this candle)
 * @returns {{macd, signal, histogram, trend, cross}|null}
 */
export function calculateMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signalPeriod) return null;
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  if (!emaFast || !emaSlow) return null;

  // MACD line where both EMAs are defined
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) { macdLine.push(null); continue; }
    macdLine.push(emaFast[i] - emaSlow[i]);
  }
  const macdDefined = macdLine.filter(v => v != null);
  if (macdDefined.length < signalPeriod + 1) return null;

  const signalArr = calculateEMA(macdDefined, signalPeriod);
  if (!signalArr) return null;

  const macd = macdDefined[macdDefined.length - 1];
  const signal = signalArr[signalArr.length - 1];
  const prevMacd = macdDefined[macdDefined.length - 2];
  const prevSignal = signalArr[signalArr.length - 2];
  const histogram = macd - signal;
  const prevHist = (prevMacd != null && prevSignal != null) ? prevMacd - prevSignal : null;

  let cross = null;
  if (prevHist != null) {
    if (prevHist <= 0 && histogram > 0) cross = "bullish_cross";
    else if (prevHist >= 0 && histogram < 0) cross = "bearish_cross";
  }
  // Treat a histogram within a tiny epsilon of zero as neutral momentum.
  // On a steady (constant-slope) trend the signal line fully converges to the
  // MACD line, so histogram→0 — that's "no acceleration", not bearish/bullish.
  // Epsilon scales with the MACD-line magnitude so it works across price scales.
  const eps = Math.max(1e-9, Math.abs(macd) * 1e-4);
  const trend = histogram > eps ? "bullish" : histogram < -eps ? "bearish" : "neutral";

  return {
    macd: Number(macd.toFixed(8)),
    signal: Number(signal.toFixed(8)),
    histogram: Number(histogram.toFixed(8)),
    rising: prevHist != null ? histogram > prevHist : null,
    trend,
    cross,
  };
}

/**
 * EMA crossover (fast vs slow). Detects golden/death cross + current state.
 *   cross      = "golden" (fast crossed above slow) | "death" | null
 *   fastAbove  = boolean (fast EMA currently above slow EMA)
 * @returns {{cross, fastAbove, fast, slow}|null}
 */
export function calculateEMACross(closes, fastPeriod = 9, slowPeriod = 21) {
  if (!Array.isArray(closes) || closes.length < slowPeriod + 1) return null;
  const fast = calculateEMA(closes, fastPeriod);
  const slow = calculateEMA(closes, slowPeriod);
  if (!fast || !slow) return null;
  const n = closes.length - 1;
  const f = fast[n], s = slow[n], pf = fast[n - 1], ps = slow[n - 1];
  if ([f, s, pf, ps].some(v => v == null)) return null;

  let cross = null;
  if (pf <= ps && f > s) cross = "golden";
  else if (pf >= ps && f < s) cross = "death";

  return { cross, fastAbove: f > s, fast: Number(f.toFixed(8)), slow: Number(s.toFixed(8)) };
}

/**
 * Support / Resistance from recent swing highs/lows (pivot detection).
 * Finds local pivots over `lookback` candles, returns nearest S/R to price
 * and proximity flags. Memecoin-tuned: small pivot window (2 bars each side).
 * @returns {{support, resistance, nearSupport, nearResistance, distToSupportPct, distToResistancePct}|null}
 */
export function calculateSupportResistance(highs, lows, closes, lookback = 50, pivotBars = 2) {
  if (!Array.isArray(closes) || closes.length < pivotBars * 2 + 1) return null;
  const start = Math.max(pivotBars, closes.length - lookback);
  const price = closes[closes.length - 1];
  const resistances = [];
  const supports = [];

  for (let i = start; i < closes.length - pivotBars; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= pivotBars; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false;
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isLow = false;
    }
    if (isHigh) resistances.push(highs[i]);
    if (isLow) supports.push(lows[i]);
  }

  // Nearest resistance above price, nearest support below price
  const resAbove = resistances.filter(r => r > price).sort((a, b) => a - b)[0] ?? null;
  const supBelow = supports.filter(s => s < price).sort((a, b) => b - a)[0] ?? null;

  const distToResistancePct = resAbove != null ? ((resAbove - price) / price) * 100 : null;
  const distToSupportPct = supBelow != null ? ((price - supBelow) / price) * 100 : null;

  return {
    support: supBelow,
    resistance: resAbove,
    // "near" = within 2% — at resistance is a sell signal, at support is a bounce zone
    nearResistance: distToResistancePct != null && distToResistancePct <= 2,
    nearSupport: distToSupportPct != null && distToSupportPct <= 2,
    distToSupportPct: distToSupportPct != null ? Number(distToSupportPct.toFixed(2)) : null,
    distToResistancePct: distToResistancePct != null ? Number(distToResistancePct.toFixed(2)) : null,
  };
}

/**
 * Volume profile — trend + spike + buy pressure from kline volumes.
 *   volumeTrend  = "rising" | "falling" | "flat"  (recent vs prior window)
 *   volumeSpike  = boolean (last candle volume > 2.5× recent avg)
 *   buyVolRatio  = 0-1 estimate of buy volume (uses close>open as proxy)
 * @param {Array} klines - {open, close, volume} or {o,c,v}
 * @returns {{volumeTrend, volumeSpike, buyVolRatio, lastVsAvg}|null}
 */
export function calculateVolumeProfile(klines, window = 10) {
  if (!Array.isArray(klines) || klines.length < window + 1) return null;
  const vols = klines.map(k => Number(k.volume ?? k.v ?? 0));
  const recent = vols.slice(-window);
  const prior = vols.slice(-window * 2, -window);
  if (prior.length === 0) return null;

  const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const recentAvg = avg(recent);
  const priorAvg = avg(prior);
  const lastVol = vols[vols.length - 1];

  let volumeTrend = "flat";
  if (priorAvg > 0) {
    const change = (recentAvg - priorAvg) / priorAvg;
    if (change > 0.2) volumeTrend = "rising";
    else if (change < -0.2) volumeTrend = "falling";
  }

  const volumeSpike = recentAvg > 0 && lastVol > recentAvg * 2.5;

  // Buy-volume proxy: candles where close > open carry "buy" volume
  let buyVol = 0, totalVol = 0;
  for (const k of klines.slice(-window)) {
    const o = Number(k.open ?? k.o ?? 0);
    const c = Number(k.close ?? k.c ?? 0);
    const v = Number(k.volume ?? k.v ?? 0);
    totalVol += v;
    if (c >= o) buyVol += v;
  }
  const buyVolRatio = totalVol > 0 ? Number((buyVol / totalVol).toFixed(3)) : 0.5;

  return {
    volumeTrend,
    volumeSpike,
    buyVolRatio,
    lastVsAvg: recentAvg > 0 ? Number((lastVol / recentAvg).toFixed(2)) : null,
  };
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
