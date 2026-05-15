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

  // Exit jika trend SuperTrend flip ke down, atau harga drop di bawah garis trend
  if (supertrend.trend === "down") {
    return {
      shouldExit: true,
      reason: `Trend flip: SuperTrend trend=down (line=${supertrend.value})`,
    };
  }
  if (supertrend.value != null && currentPrice < supertrend.value) {
    return {
      shouldExit: true,
      reason: `Price ${currentPrice} dropped below SuperTrend line ${supertrend.value}`,
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
