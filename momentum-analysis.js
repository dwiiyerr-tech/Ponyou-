/**
 * Momentum Analysis for Entry/Exit Decisions
 * Uses RSI and SuperTrend for entry confirmation and trend-based exits
 */

import {
  calculateRSI, calculateSuperTrend,
  calculateMACD, calculateEMACross, calculateSupportResistance, calculateVolumeProfile,
} from "./utils/indicators.js";

/**
 * Analyze token momentum from klines
 * Returns RSI, SuperTrend, and trend status
 */
export function analyzeMomentum(klines) {
  if (!klines || klines.length < 30) {
    return { valid: false, reason: "Insufficient kline data" };
  }

  const closes = klines.map(k => k.close || k.c);
  const highs = klines.map(k => k.high || k.h);
  const lows = klines.map(k => k.low || k.l);

  // Calculate indicators.
  // calculateSuperTrend signature is (highs, lows, closes, period=10, multiplier=3).
  // Standard SuperTrend on memecoin scalping = ATR period 10, multiplier 3.
  const rsi = calculateRSI(closes, 14);
  const supertrend = calculateSuperTrend(highs, lows, closes, 10, 3);
  const currentPrice = closes[closes.length - 1];

  // Upgrade indicators (each returns null gracefully if insufficient data —
  // memecoins with <35 candles won't have MACD, that's fine).
  const macd = calculateMACD(closes, 12, 26, 9);
  const emaCross = calculateEMACross(closes, 9, 21);
  const sr = calculateSupportResistance(highs, lows, closes, 50, 2);
  const volume = calculateVolumeProfile(klines, 10);

  return {
    valid: true,
    rsi,
    supertrend,
    currentPrice,
    trend: supertrend.trend || "neutral",
    upperBand: supertrend.value,
    strength: rsi ? (rsi > 50 ? "bullish" : "bearish") : "neutral",
    // Upgrade indicators
    macd,          // {macd, signal, histogram, rising, trend, cross} | null
    emaCross,      // {cross, fastAbove, fast, slow} | null
    supportResistance: sr, // {support, resistance, nearSupport, nearResistance, ...} | null
    volume,        // {volumeTrend, volumeSpike, buyVolRatio, lastVsAvg} | null
  };
}

/**
 * Check if token passes entry confirmation rules
 * Requirements:
 * 1. RSI not overbought (< 70)
 * 2. Price above SuperTrend (uptrend)
 * 3. Price not at extreme low
 */
export function checkEntryConfirmation(momentum) {
  const checks = [];

  if (!momentum.valid) {
    return { pass: false, reason: "Invalid momentum data", checks };
  }

  // Rule 1: RSI tidak overbought
  if (momentum.rsi > 70) {
    checks.push({ rule: "RSI not overbought", pass: false, value: momentum.rsi });
    return { pass: false, reason: `RSI=${momentum.rsi?.toFixed(1)} (overbought, too late to enter)`, checks };
  }
  checks.push({ rule: "RSI not overbought", pass: true, value: momentum.rsi });

  // Rule 2: SuperTrend trend = up
  // (calculateSuperTrend hanya kembalikan { trend, value }, jadi pakai .trend langsung)
  if (momentum.supertrend?.trend !== "up") {
    checks.push({ rule: "SuperTrend up", pass: false, value: momentum.supertrend?.trend });
    return { pass: false, reason: `SuperTrend trend=${momentum.supertrend?.trend ?? "?"} (downtrend)`, checks };
  }
  checks.push({ rule: "SuperTrend up", pass: true, value: "up" });

  // Rule 3: Harga di atas garis SuperTrend (konfirmasi trend up belum patah)
  if (momentum.supertrend?.value != null && momentum.currentPrice < momentum.supertrend.value) {
    checks.push({ rule: "Price above SuperTrend line", pass: false, value: momentum.currentPrice });
    return { pass: false, reason: `Price ${momentum.currentPrice} below ST line ${momentum.supertrend.value} (trend lemah)`, checks };
  }
  checks.push({ rule: "Price above SuperTrend line", pass: true, value: momentum.currentPrice });

  // Rule 4 (UPGRADE): jangan entry tepat di resistance — risk/reward jelek.
  // Hanya blok kalau data S/R tersedia (null = skip, jangan blok token muda).
  if (momentum.supportResistance?.nearResistance) {
    checks.push({ rule: "Not at resistance", pass: false, value: momentum.supportResistance.distToResistancePct });
    return { pass: false, reason: `Price at resistance (${momentum.supportResistance.distToResistancePct}% away) — poor R/R`, checks };
  }
  if (momentum.supportResistance) checks.push({ rule: "Not at resistance", pass: true });

  // Rule 5 (UPGRADE): MACD bearish cross = momentum baru patah ke bawah, jangan entry.
  // Advisory — hanya blok pada bearish_cross eksplisit, bukan histogram negatif statis
  // (token bisa baru recover). Skip kalau MACD null (data kurang).
  if (momentum.macd?.cross === "bearish_cross") {
    checks.push({ rule: "MACD not bearish-crossing", pass: false, value: momentum.macd.histogram });
    return { pass: false, reason: `MACD bearish cross — momentum patah`, checks };
  }
  if (momentum.macd) checks.push({ rule: "MACD not bearish-crossing", pass: true });

  return { pass: true, reason: "All momentum checks passed", checks };
}

/**
 * Adjust position size based on RSI
 * High RSI = reduce size (momentum fading soon)
 * Low RSI = increase size (fresh momentum)
 */
export function adjustSizeByRSI(baseSize, rsi) {
  if (rsi == null) return baseSize;

  if (rsi > 60) {
    return baseSize * 0.8;  // Reduce 20% (momentum fading)
  }

  if (rsi < 40) {
    return baseSize * 1.2;  // Increase 20% (fresh momentum)
  }

  return baseSize;  // Normal size
}

/**
 * Check if position should exit on trend break.
 * Primary: SuperTrend flip / break below ST line.
 * UPGRADE (optional `extras`): also exit on MACD bearish cross or a clean
 * break below support — multi-signal confirmation of momentum failure.
 *
 * @param {number} currentPrice
 * @param {object} supertrend  {trend, value}
 * @param {object} [extras]    {macd, supportResistance} from analyzeMomentum (optional, backward-compatible)
 */
export function checkTrendBreakExit(currentPrice, supertrend, extras = null) {
  if (!supertrend || currentPrice == null) {
    return { shouldExit: false, reason: "Insufficient data" };
  }

  // Signal 1: SuperTrend flip ke down
  if (supertrend.trend === "down") {
    return { shouldExit: true, reason: `Trend flip: SuperTrend trend=down (line=${supertrend.value})` };
  }
  // Signal 2: harga drop di bawah garis SuperTrend
  if (supertrend.value != null && currentPrice < supertrend.value) {
    return { shouldExit: true, reason: `Price ${currentPrice} dropped below SuperTrend line ${supertrend.value}` };
  }

  // Signal 3 (UPGRADE): MACD bearish cross — momentum baru patah ke bawah
  if (extras?.macd?.cross === "bearish_cross") {
    return { shouldExit: true, reason: `MACD bearish cross (hist=${extras.macd.histogram})` };
  }

  // Signal 4 (UPGRADE): break bersih di bawah support (>1% di bawah, bukan noise)
  const sr = extras?.supportResistance;
  if (sr?.support != null && currentPrice < sr.support * 0.99) {
    return { shouldExit: true, reason: `Broke support ${sr.support} (price ${currentPrice})` };
  }

  return { shouldExit: false, reason: "Trend intact" };
}

/**
 * Get momentum score (0-100) for ranking
 * Combines RSI strength with trend alignment
 */
export function getMomentumScore(momentum) {
  if (!momentum.valid) return 0;

  // RSI-derived base: 0..50. Missing RSI defaults to neutral 25.
  let score = momentum.rsi ? (momentum.rsi / 100) * 50 : 25;

  const stVal = momentum.supertrend?.value;
  if (Number.isFinite(stVal) && stVal > 0) {
    if (momentum.currentPrice > stVal * 1.02) score += 10;       // ahead of trend
    else if (momentum.currentPrice < stVal * 1.001) score -= 5;  // hugging the line
  }

  // UPGRADE: MACD momentum (max ±12)
  if (momentum.macd) {
    if (momentum.macd.cross === "bullish_cross") score += 8;     // fresh momentum turn
    else if (momentum.macd.trend === "bullish" && momentum.macd.rising) score += 5;
    else if (momentum.macd.trend === "bearish") score -= 6;
  }
  // UPGRADE: EMA cross alignment (max ±6)
  if (momentum.emaCross) {
    if (momentum.emaCross.cross === "golden") score += 6;
    else if (momentum.emaCross.cross === "death") score -= 6;
    else if (momentum.emaCross.fastAbove) score += 2;
  }
  // UPGRADE: volume confirmation (max +6) — rising volume + buy pressure validates move
  if (momentum.volume) {
    if (momentum.volume.volumeTrend === "rising" && momentum.volume.buyVolRatio > 0.55) score += 6;
    else if (momentum.volume.volumeTrend === "falling") score -= 3;   // move losing fuel
  }

  return Math.max(0, Math.min(100, score));
}

export default {
  analyzeMomentum,
  checkEntryConfirmation,
  adjustSizeByRSI,
  checkTrendBreakExit,
  getMomentumScore,
};
