/**
 * Momentum Analysis for Entry/Exit Decisions
 * Uses RSI and SuperTrend for entry confirmation and trend-based exits
 */

import { calculateRSI, calculateSuperTrend, calculateATR } from "./utils/indicators.js";

/**
 * Analyze token momentum from klines
 * Returns RSI, SuperTrend, and trend status
 */
export function analyzeMomentum(klines) {
  if (!klines || klines.length < 50) {
    return { valid: false, reason: "Insufficient kline data" };
  }

  const closes = klines.map(k => k.close || k.c);
  const highs = klines.map(k => k.high || k.h);
  const lows = klines.map(k => k.low || k.l);

  // Calculate indicators
  const rsi = calculateRSI(closes, 14);
  const supertrend = calculateSuperTrend(highs, lows, closes, 3, 10);
  const currentPrice = closes[closes.length - 1];

  return {
    valid: true,
    rsi,
    supertrend,
    currentPrice,
    trend: supertrend.trend || "neutral",
    upperBand: supertrend.value,
    strength: rsi ? (rsi > 50 ? "bullish" : "bearish") : "neutral",
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

  // Rule 1: RSI not overbought
  if (momentum.rsi > 70) {
    checks.push({ rule: "RSI not overbought", pass: false, value: momentum.rsi });
    return { pass: false, reason: `RSI=${momentum.rsi} (overbought, too late to enter)`, checks };
  }
  checks.push({ rule: "RSI not overbought", pass: true, value: momentum.rsi });

  // Rule 2: Price above SuperTrend
  if (momentum.currentPrice < momentum.supertrend.middle) {
    checks.push({ rule: "Price above SuperTrend", pass: false, value: momentum.currentPrice });
    return { pass: false, reason: "Price below SuperTrend (downtrend)", checks };
  }
  checks.push({ rule: "Price above SuperTrend", pass: true, value: momentum.currentPrice });

  // Rule 3: Not at extreme low
  if (momentum.currentPrice < momentum.supertrend.lower) {
    checks.push({ rule: "Not at extreme low", pass: false, value: momentum.currentPrice });
    return { pass: false, reason: "Price too low (extreme volatility)", checks };
  }
  checks.push({ rule: "Not at extreme low", pass: true, value: momentum.currentPrice });

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
 * Check if position should exit on trend break
 * Exit when price breaks below SuperTrend lower band
 */
export function checkTrendBreakExit(currentPrice, supertrend) {
  if (!supertrend || currentPrice == null) {
    return { shouldExit: false, reason: "Insufficient data" };
  }

  // Exit if price breaks below trend
  if (currentPrice < supertrend.lower) {
    return { 
      shouldExit: true, 
      reason: `Trend break: price (${currentPrice}) < SuperTrend lower (${supertrend.lower})` 
    };
  }

  return { shouldExit: false, reason: "Trend intact" };
}

/**
 * Get momentum score (0-100) for ranking
 * Combines RSI strength with trend alignment
 */
export function getMomentumScore(momentum) {
  if (!momentum.valid) return 0;

  let score = 50;  // Base score

  // Adjust by RSI
  const rsiScore = momentum.rsi ? (momentum.rsi / 100) * 50 : 25;
  score = rsiScore;

  // Boost if price well above SuperTrend
  if (momentum.currentPrice > momentum.supertrend.value * 1.02) {
    score += 10;  // Price ahead of trend = bullish
  }

  // Penalize if price near bands
  if (momentum.currentPrice < momentum.supertrend.value * 1.001) {
    score -= 5;  // Price too close to trend = risky
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
