import { buildRiskPolicy } from "./risk-policy.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Evaluate a candidate token through Ponyou's full cognitive decision pipeline.
 *
 * New in v2.1:
 *   - portfolio_context: open positions, drawdown, daily guard, consecutive losses
 *   - timing_context: cooldown, learning mode, session phase, circuit breaker
 *   - narrativeVelocity: proper vector scoring with trending boost/penalty
 *   - Unified return always uses `caution_score` (was `caution` in early-return path)
 *
 * Returns { verdict, caution_score, reasons, policy, size_multiplier,
 *           recommended_amount_sol, fast_track_eligible, llm_can_buy,
 *           velocity_override, context_blocks }
 */
export function evaluateCandidateDecision({
  token = {},
  conviction = {},
  marketCondition = "UNKNOWN",
  probeSizeFraction = 0.35,
  policy: policyOverride = null,
  config = {},
  narrativeVelocity = null,
  // ─── NEW: Portfolio + Timing Context ─────────────────────────
  portfolioContext = null,
  timingContext = null,
} = {}) {
  const normalMarket = String(marketCondition || "UNKNOWN").toUpperCase().trim();
  const convictionScore = Number(conviction.conviction_score || 0);
  const convictionConfidence = Number(conviction.confidence_score || 0);
  const policy = policyOverride || buildRiskPolicy({
    marketCondition: normalMarket,
    conviction,
    token,
    config,
  });

  // ─── Early bail: no rug data = no decision ──────────────────
  if (token.rug_score == null || !Number.isFinite(Number(token.rug_score))) {
    return {
      verdict: "skip",
      reason: "missing_rug_score",
      caution_score: 100,
      reasons: ["missing_rug_score"],
      policy,
      size_multiplier: 0,
      recommended_amount_sol: 0,
      fast_track_eligible: false,
      llm_can_buy: false,
      velocity_override: false,
      context_blocks: [],
    };
  }

  const reasons = [];
  const contextBlocks = [];
  let cautionScore = 0;
  let sizeMultiplier = 1;

  // ═══════════════════════════════════════════════════════════════
  // LAYER 1: Portfolio Context Gates
  // ═══════════════════════════════════════════════════════════════
  if (portfolioContext) {
    // Position limit: skip if portfolio is full
    if (portfolioContext.open_positions != null && portfolioContext.max_positions != null) {
      if (portfolioContext.open_positions >= portfolioContext.max_positions) {
        return {
          verdict: "skip",
          reason: "portfolio_full",
          caution_score: 100,
          reasons: [`portfolio_full: ${portfolioContext.open_positions}/${portfolioContext.max_positions}`],
          policy,
          size_multiplier: 0,
          recommended_amount_sol: 0,
          fast_track_eligible: false,
          llm_can_buy: false,
          velocity_override: false,
          context_blocks: ["portfolio_full"],
        };
      }
    }

    // Daily guard: block if stopped
    if (portfolioContext.daily_guard_blocked) {
      contextBlocks.push("daily_guard_blocked");
      return {
        verdict: "skip",
        reason: "daily_guard_blocked",
        caution_score: 100,
        reasons: ["daily_guard_blocked"],
        policy,
        size_multiplier: 0,
        recommended_amount_sol: 0,
        fast_track_eligible: false,
        llm_can_buy: false,
        velocity_override: false,
        context_blocks: contextBlocks,
      };
    }

    // Drawdown proximity: reduce risk as we approach kill switch
    if (portfolioContext.session_pnl_pct != null && portfolioContext.kill_switch_threshold != null) {
      const distanceToKill = Math.abs(portfolioContext.session_pnl_pct - portfolioContext.kill_switch_threshold);
      if (distanceToKill < 5) {
        // Within 5% of kill switch — shadow mode only, no new entries
        cautionScore += 35;
        reasons.push(`near_kill_switch: ${portfolioContext.session_pnl_pct.toFixed(1)}%`);
        contextBlocks.push("near_kill_switch");
      } else if (distanceToKill < 10) {
        cautionScore += 15;
        reasons.push("approaching_kill_switch");
        contextBlocks.push("approaching_kill_switch");
      }
    }

    // Consecutive losses: pro-orchestrator skip threshold
    if (portfolioContext.consecutive_losses != null && portfolioContext.pro_skip_threshold != null) {
      if (portfolioContext.consecutive_losses >= portfolioContext.pro_skip_threshold) {
        cautionScore += 30;
        reasons.push(`loss_streak: ${portfolioContext.consecutive_losses}`);
        contextBlocks.push("loss_streak");
      }
    }

    // Narrative concentration: all positions in same narrative
    if (portfolioContext.same_narrative_count != null && portfolioContext.same_narrative_count >= 2) {
      cautionScore += 18;
      reasons.push("narrative_concentration");
      contextBlocks.push("narrative_concentration");
    }

    // Profit mode: allow more aggressive sizing
    if (portfolioContext.in_profit_mode) {
      cautionScore = Math.max(0, cautionScore - 8);
      reasons.push("profit_mode_active");
    }

    // Vault sweep pending: reduce new position size
    if (portfolioContext.vault_sweep_due) {
      cautionScore += 10;
      reasons.push("vault_sweep_pending");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 2: Timing Context Gates
  // ═══════════════════════════════════════════════════════════════
  if (timingContext) {
    // Circuit breaker active: all trading paused
    if (timingContext.circuit_breaker_locked) {
      contextBlocks.push("circuit_breaker_locked");
      return {
        verdict: "skip",
        reason: `circuit_breaker: ${timingContext.circuit_breaker_reason || "locked"}`,
        caution_score: 100,
        reasons: ["circuit_breaker_locked"],
        policy,
        size_multiplier: 0,
        recommended_amount_sol: 0,
        fast_track_eligible: false,
        llm_can_buy: false,
        velocity_override: false,
        context_blocks: contextBlocks,
      };
    }

    // Learning mode active
    if (timingContext.learning_mode_active) {
      contextBlocks.push("learning_mode_active");
      return {
        verdict: "skip",
        reason: "learning_mode_active",
        caution_score: 100,
        reasons: ["learning_mode_active"],
        policy,
        size_multiplier: 0,
        recommended_amount_sol: 0,
        fast_track_eligible: false,
        llm_can_buy: false,
        velocity_override: false,
        context_blocks: contextBlocks,
      };
    }

    // Cooldown active on this token
    if (timingContext.token_cooldown_active) {
      contextBlocks.push("token_cooldown");
      cautionScore += 25;
      reasons.push(`cooldown: ${timingContext.cooldown_remaining_min || 0}min remaining`);
    }

    // Session phase: weekend is lower conviction
    if (timingContext.session_phase === "weekend") {
      cautionScore += 5;
      reasons.push("weekend_session");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 3: Token Safety Signals
  // ═══════════════════════════════════════════════════════════════

  const flagCount = Array.isArray(token.flags) ? token.flags.length : 0;
  // P1-2: count string-form critical flags — string labels like "honeypot" or
  // "mint_authority" are just as dangerous as object flags with severity fields.
  // Previously all strings were unconditionally excluded, allowing a token with
  // string-encoded critical flags to evade the critical-flag caution bump.
  const CRITICAL_FLAG_STRINGS = new Set(["honeypot","mint_authority","freeze_authority","rug","blacklisted","scam"]);
  const criticalFlags = Array.isArray(token.flags)
    ? token.flags.filter(f => {
      if (typeof f === "string") return CRITICAL_FLAG_STRINGS.has(f.toLowerCase());
      return f?.severity === "critical" || f?.severity === "high";
    })
    : [];

  if (criticalFlags.length >= 1) {
    cautionScore += 50;
    reasons.push(`critical_flag:${criticalFlags[0]?.type || "unknown"}`);
  }
  if (flagCount === 1 && criticalFlags.length === 0) {
    cautionScore += 12;
    reasons.push("single_flag");
  }
  if (flagCount >= 2) {
    cautionScore += 24;
    reasons.push(`flags=${flagCount}`);
  }
  if ((token.rug_score || 0) >= policy.entry.hardBlockRugScore) {
    cautionScore += 45;
    reasons.push(`rug_score=${token.rug_score}`);
  } else if ((token.rug_score || 0) >= 20) {
    cautionScore += 25;
    reasons.push(`rug_score=${token.rug_score}`);
  }
  if (token.kelly?.should_skip) {
    cautionScore += 40;
    reasons.push("negative_kelly_edge");
  }
  if (token.momentum_entry_pass === false) {
    cautionScore += 25; // raised from 10 — klines available but no confirmation = falling knife risk
    reasons.push("momentum_unconfirmed");
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 4: Market Condition Adjustment
  // ═══════════════════════════════════════════════════════════════
  if (normalMarket === "COLD") {
    cautionScore += 8;
    reasons.push("cold_market");
  }
  if (normalMarket === "DEAD") {
    cautionScore += 20;
    reasons.push("dead_market");
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 5: Conviction Signal
  // ═══════════════════════════════════════════════════════════════
  if (convictionConfidence < policy.entry.shadowConfidenceFloor) {
    cautionScore += 16;
    reasons.push("low_conviction_confidence");
  }
  if (convictionScore < 35) {
    cautionScore += 14;
    reasons.push("weak_conviction");
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 6: Narrative Velocity Gate Override
  // Trending narratives get reduced thresholds — momentum > history.
  // Negative velocity (dying narrative) adds caution.
  // ═══════════════════════════════════════════════════════════════
  let velocityOverride = false;
  let velocityScore = 0;
  const tokenNarratives = Array.isArray(token.narrative_tags)
    ? token.narrative_tags.map(t => typeof t === "string" ? t : t?.narrative).filter(Boolean)
    : [];

  if (narrativeVelocity && tokenNarratives.length > 0) {
    for (const n of tokenNarratives) {
      const vel = narrativeVelocity.velocities?.[n] || narrativeVelocity[n];
      if (!vel) continue;

      const vScore = Number(vel.velocity_score || vel.score || 0);
      const trendingBoost = Number(vel.trending_boost || vel.boost || 0);

      // Trending narrative: reduce caution (positive momentum)
      if (vel.is_trending && vScore >= 60) {
        const reduction = Math.min(20, Math.round(vScore / 5));
        cautionScore = Math.max(0, cautionScore - reduction);
        reasons.push(`narrative_trending:${n}(${vScore})`);
        velocityOverride = true;
        velocityScore = Math.max(velocityScore, vScore);
      }

      // Dying narrative: increase caution (negative momentum)
      if (trendingBoost < -10 || vScore < 25) {
        cautionScore += 12;
        reasons.push(`narrative_dying:${n}(${vScore})`);
      }

      // Trending boost for conviction
      if (trendingBoost > 15) {
        velocityOverride = true;
        velocityScore = Math.max(velocityScore, vScore);
        reasons.push(`narrative_boost:${n}(+${trendingBoost})`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 7: Conviction Bonus (only if no hard blocks)
  // ═══════════════════════════════════════════════════════════════
  // P3-3: conviction bonus must not cancel portfolio-safety caution (near kill-switch,
  // loss streak, cooldown). High conviction in a token should not override the fact
  // that the account is in a risk-halted state.
  const hasPortfolioSafetyBlock = contextBlocks.some(b =>
    ["near_kill_switch", "loss_streak", "narrative_concentration"].includes(b)
  );
  const canConvictionReduce = !hasPortfolioSafetyBlock && !(
    (token.rug_score || 0) >= 20 ||
    criticalFlags.length >= 1 ||
    token.kelly?.should_skip === true
  );
  if (canConvictionReduce && convictionScore >= 70 && convictionConfidence >= 45) {
    cautionScore -= 12;
    reasons.push("strong_conviction");
  }

  cautionScore = clamp(cautionScore, 0, 100);

  // ═══════════════════════════════════════════════════════════════
  // LAYER 8: Verdict Assignment
  // ═══════════════════════════════════════════════════════════════

  // Velocity override: lower conviction thresholds for trending narratives
  const probeConvictionFloor = velocityOverride ? 45 : 65;
  const shadowConvictionFloor = velocityOverride ? 20 : 35;
  // P1-3: velocity override may lower conviction floors for trending narratives,
  // but never below the policy's own shadow floor — prevents a narrative-gamed
  // token from lowering the floor to 30 regardless of what policy specifies.
  const VELOCITY_CONFIDENCE_FLOOR_MIN = 35;
  const activeConfidenceFloor = velocityOverride
    ? Math.max(VELOCITY_CONFIDENCE_FLOOR_MIN, Math.min(policy.entry.activeConfidenceFloor || 0, 45))
    : policy.entry.activeConfidenceFloor;

  let verdict = "active";

  if (
    token.kelly?.should_skip ||
    normalMarket === "DEAD" ||
    cautionScore >= 45 ||
    (token.rug_score || 0) >= policy.entry.hardBlockRugScore
  ) {
    verdict = "skip";
    sizeMultiplier = 0;
  } else if (
    convictionConfidence < policy.entry.shadowConfidenceFloor ||
    convictionScore < shadowConvictionFloor
  ) {
    verdict = "shadow";
    sizeMultiplier = 0;
  } else if (
    cautionScore >= policy.entry.probeCautionThreshold ||
    convictionScore < probeConvictionFloor ||
    convictionConfidence < (activeConfidenceFloor ?? 0) ||
    convictionConfidence < (policy.entry.probeConfidenceFloor ?? 0)
  ) {
    verdict = "probe";
    sizeMultiplier = Math.min(policy.sizing.probeSizeFraction, probeSizeFraction);
  }

  // Portfolio context can demote but not promote
  if (portfolioContext) {
    // Near full capacity: demote active→probe
    if (verdict === "active" && portfolioContext.open_positions != null && portfolioContext.max_positions != null) {
      if (portfolioContext.open_positions >= portfolioContext.max_positions - 1) {
        verdict = "probe";
        sizeMultiplier = Math.min(sizeMultiplier, policy.sizing.probeSizeFraction);
        reasons.push("portfolio_near_full");
      }
    }
    // Post-reset: only probe
    if (portfolioContext.just_reset && verdict === "active") {
      verdict = "probe";
      sizeMultiplier = Math.min(sizeMultiplier, policy.sizing.probeSizeFraction * 0.5);
      reasons.push("post_reset_caution");
    }
  }

  return {
    verdict,
    caution_score: cautionScore,
    reasons,
    policy,
    size_multiplier: Number(sizeMultiplier.toFixed(4)),
    recommended_amount_sol: Number(((token.volatility_adjusted_size || 0) * sizeMultiplier).toFixed(4)),
    fast_track_eligible: verdict === "active" && cautionScore <= 18 && flagCount === 0 && token.momentum_entry_pass === true,
    llm_can_buy: verdict === "probe" || verdict === "active",
    velocity_override: velocityOverride,
    velocity_score: velocityScore,
    context_blocks: contextBlocks,
  };
}
