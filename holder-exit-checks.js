/**
 * Holder Exit Checks Integration
 *
 * Hooks ABC (Dump Monitor, Entry Price, Pattern Detector) into the position
 * monitoring cycle. Called from main loop to check holder health before normal
 * exit policy evaluation.
 *
 * Usage:
 *   const exitSignal = await checkHolderExitSignals({
 *     position,
 *     currentPrice,
 *     topHolders,
 *     recentSells,
 *     featureFlags: config.holderAnalysis
 *   });
 *   if (exitSignal) triggerExit(position, exitSignal);
 */

import { monitorHolderDumps, recordHolderSnapshot } from "./tools/holder-dump-monitor.js";
import { analyzeHolderEntryPrices, estimateEntryPriceFromHistory } from "./tools/holder-entry-price.js";
import { detectRugPattern } from "./tools/rug-pattern-detector.js";
import { log } from "./logger.js";
import { recordCounter } from "./metrics.js";

/**
 * Check all three holder analysis tools (A/B/C) for exit signals.
 * Returns null if no exit needed, or structured signal if action required.
 */
export async function checkHolderExitSignals({
  position,
  currentPrice = 0,
  topHolders = [],
  recentSells = [],
  holderTransactions = [],
  priceHistory = [],
  featureFlags = {},
} = {}) {
  if (!position || !position.mint) return null;

  const { mint, pool_name } = position;
  const cfg = featureFlags || {};

  // Feature flag check: skip if disabled
  const flagsEnabled = cfg.dumpMonitor?.enabled || cfg.entryPriceAnalysis?.enabled || cfg.rugPatternDetector?.enabled;
  if (!flagsEnabled) return null;

  // Check if this position should run holder checks (beta rollout percentage)
  const shouldRun = shouldRunBetaCheck(mint, cfg);
  if (!shouldRun) return null;

  const signals = [];
  let maxRisk = "NONE";
  let maxConfidence = 0;

  // ─────────────────────────────────────────────────────────────
  // A) HOLDER DUMP MONITOR
  // ─────────────────────────────────────────────────────────────
  if (cfg.dumpMonitor?.enabled) {
    try {
      // Record snapshot first
      if (topHolders && topHolders.length > 0) {
        await recordHolderSnapshot({
          tokenMint: mint,
          tokenSymbol: position.symbol || pool_name,
          topHolders,
          totalSupply: position.total_supply,
        });
      }

      const dumpRisk = monitorHolderDumps({
        tokenMint: mint,
        currentTopHolders: topHolders,
        lookbackMinutes: 60,
      });

      if (dumpRisk.risk_level !== "NONE" && dumpRisk.confidence > 0) {
        signals.push({
          tool: "dump_monitor",
          risk_level: dumpRisk.risk_level,
          confidence: dumpRisk.confidence,
          reason: dumpRisk.recommendation,
          details: dumpRisk.details,
        });

        // Update max risk
        if (shouldUpgradeRisk(dumpRisk.risk_level, maxRisk)) {
          maxRisk = dumpRisk.risk_level;
          maxConfidence = Math.max(maxConfidence, dumpRisk.confidence);
        }

        recordCounter(`holder_exit_dump_${dumpRisk.risk_level.toLowerCase()}`);
        log(
          "holder_exit",
          `Position ${mint.slice(0, 8)}: dump risk ${dumpRisk.risk_level} (${dumpRisk.confidence}%)`
        );
      }
    } catch (err) {
      recordCounter("holder_exit_dump_error");
      log("holder_exit_error", `Dump monitor failed for ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // B) ENTRY PRICE ANALYSIS
  // ─────────────────────────────────────────────────────────────
  if (cfg.entryPriceAnalysis?.enabled) {
    try {
      let entryAnalysis;

      // Prefer transaction history if available
      if (holderTransactions && holderTransactions.length > 0) {
        entryAnalysis = analyzeHolderEntryPrices({
          tokenMint: mint,
          currentPriceUsd: currentPrice,
          holderTransactions,
        });
      } else if (priceHistory && priceHistory.length > 2) {
        // Fallback to price history estimation
        entryAnalysis = estimateEntryPriceFromHistory({
          tokenMint: mint,
          currentPriceUsd: currentPrice,
          priceHistory,
        });
      }

      if (entryAnalysis && entryAnalysis.underwater_pct > 0) {
        const uwThreshold = cfg.entryPriceAnalysis?.underwaterThreshold || 80;

        if (entryAnalysis.underwater_pct >= uwThreshold && entryAnalysis.confidence > 70) {
          signals.push({
            tool: "entry_price_analysis",
            risk_level: entryAnalysis.sell_pressure_risk,
            confidence: entryAnalysis.confidence,
            reason: `${entryAnalysis.underwater_pct.toFixed(0)}% holders underwater (bought @${entryAnalysis.avg_entry_price_usd.toFixed(8)}, now ${currentPrice.toFixed(8)})`,
            details: entryAnalysis.details,
          });

          if (shouldUpgradeRisk(entryAnalysis.sell_pressure_risk, maxRisk)) {
            maxRisk = entryAnalysis.sell_pressure_risk;
            maxConfidence = Math.max(maxConfidence, entryAnalysis.confidence);
          }

          recordCounter(`holder_exit_underwater_${entryAnalysis.sell_pressure_risk.toLowerCase()}`);
          log(
            "holder_exit",
            `Position ${mint.slice(0, 8)}: ${entryAnalysis.underwater_pct.toFixed(0)}% underwater (${entryAnalysis.sell_pressure_risk})`
          );
        }
      }
    } catch (err) {
      recordCounter("holder_exit_entry_price_error");
      log("holder_exit_error", `Entry price analysis failed for ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // C) RUG PATTERN DETECTOR
  // ─────────────────────────────────────────────────────────────
  if (cfg.rugPatternDetector?.enabled) {
    try {
      if (recentSells && recentSells.length >= 2) {
        const patternRisk = detectRugPattern({
          tokenMint: mint,
          tokenSymbol: position.symbol || pool_name,
          recentSells,
          windowMinutes: 5,
        });

        if (patternRisk.pattern_detected) {
          const confThreshold = cfg.rugPatternDetector?.confidenceThreshold || 70;

          if (patternRisk.confidence >= confThreshold) {
            signals.push({
              tool: "rug_pattern_detector",
              risk_level: patternRisk.rug_risk,
              confidence: patternRisk.confidence,
              reason: `${patternRisk.pattern_type} detected: ${patternRisk.signals[0]?.detail || ""}`,
              details: {
                pattern_type: patternRisk.pattern_type,
                ...patternRisk.details,
              },
            });

            if (shouldUpgradeRisk(patternRisk.rug_risk, maxRisk)) {
              maxRisk = patternRisk.rug_risk;
              maxConfidence = Math.max(maxConfidence, patternRisk.confidence);
            }

            recordCounter(`holder_exit_pattern_${patternRisk.rug_risk.toLowerCase()}`);
            log(
              "holder_exit",
              `Position ${mint.slice(0, 8)}: ${patternRisk.pattern_type} pattern (${patternRisk.rug_risk})`
            );
          }
        }
      }
    } catch (err) {
      recordCounter("holder_exit_pattern_error");
      log("holder_exit_error", `Pattern detection failed for ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Return structured signal if any exit triggered
  // ─────────────────────────────────────────────────────────────
  if (maxRisk === "CRITICAL" && maxConfidence >= 70) {
    return {
      type: "HOLDER_EXIT_CRITICAL",
      risk_level: maxRisk,
      confidence: maxConfidence,
      signals: signals.slice(0, 3), // top 3 signals
      recommendation: "IMMEDIATE_EXIT",
      urgency: "CRITICAL",
      details: {
        position_key: position.position_key || mint,
        holder_signals: signals.length,
      },
    };
  } else if (maxRisk === "HIGH" && maxConfidence >= 80) {
    return {
      type: "HOLDER_EXIT_HIGH",
      risk_level: maxRisk,
      confidence: maxConfidence,
      signals: signals.slice(0, 3),
      recommendation: "WATCH_CLOSELY",
      urgency: "HIGH",
      details: {
        position_key: position.position_key || mint,
        holder_signals: signals.length,
      },
    };
  } else if (maxRisk === "MEDIUM" && maxConfidence >= 60 && signals.length >= 2) {
    // Only exit on MEDIUM if multiple signals agree
    return {
      type: "HOLDER_EXIT_MEDIUM",
      risk_level: maxRisk,
      confidence: maxConfidence,
      signals: signals.slice(0, 3),
      recommendation: "MONITOR",
      urgency: "MEDIUM",
      details: {
        position_key: position.position_key || mint,
        holder_signals: signals.length,
      },
    };
  }

  return null;
}

/**
 * Determine if this position should run beta checks (for staged rollout).
 * Uses mint hash to consistently assign positions to beta cohorts.
 */
function shouldRunBetaCheck(mint, featureFlags = {}) {
  const dumpPct = featureFlags.dumpMonitor?.betaRolloutPct || 0;
  const entryPct = featureFlags.entryPriceAnalysis?.betaRolloutPct || 0;
  const patternPct = featureFlags.rugPatternDetector?.betaRolloutPct || 0;

  const maxPct = Math.max(dumpPct, entryPct, patternPct);
  if (maxPct === 0) return false;

  // Hash mint to 0-100 bucket for consistent rollout
  const hash = mint
    .split("")
    .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const bucket = Math.abs(hash) % 100;

  return bucket < maxPct;
}

/**
 * Check if newRisk is higher priority than currentMax.
 */
function shouldUpgradeRisk(newRisk, currentMax) {
  const riskOrder = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4, UNKNOWN: 0 };
  return (riskOrder[newRisk] || 0) > (riskOrder[currentMax] || 0);
}

/**
 * Summary stats for holder exit checks (for metrics/telemetry).
 */
export function getHolderExitStats() {
  return {
    metrics: [
      "holder_exit_dump_critical",
      "holder_exit_dump_high",
      "holder_exit_underwater_critical",
      "holder_exit_underwater_high",
      "holder_exit_pattern_critical",
      "holder_exit_pattern_high",
      "holder_exit_dump_error",
      "holder_exit_entry_price_error",
      "holder_exit_pattern_error",
    ],
  };
}
