/**
 * Staged / DCA Entry Engine — multiple buys instead of single-shot.
 *
 * Strategy presets define `staged_entry` config:
 *   staged_entry: {
 *     enabled: true/false,
 *     stages: N,
 *     stage_pct: [35, 35, 30],        // % of total per stage
 *     trigger_type: "price" | "time",
 *     price_trigger_pct: -5,           // for price trigger
 *     time_trigger_min: 1440,          // for time trigger (minutes)
 *   }
 *
 * Flow:
 *   Stage 1: executed at initial entry (portion of total allocation)
 *   Stage 2+: triggered by management cycle when condition met
 *   After each stage: avg_entry_price recomputed, position amount_sol updated
 */

/**
 * Initialize staged entry tracking on a position. Called right after
 * the FIRST buy swap succeeds.
 */
export function initStagedEntry(position, strategyConfig, initialAmountSol, initialPriceUsd) {
  const cfg = strategyConfig?.staged_entry;
  if (!cfg?.enabled || cfg.stages <= 1) return null;

  const stagePcts = Array.isArray(cfg.stage_pct) && cfg.stage_pct.length === cfg.stages
    ? cfg.stage_pct
    : Array(cfg.stages).fill(Math.round(100 / cfg.stages));

  if (stagePcts[0] <= 0) {
    throw new Error(`staged_entry: invalid stage_pct[0]=${stagePcts[0]} — must be > 0`);
  }
  const totalAllocated = initialAmountSol / (stagePcts[0] / 100);
  const stageAmounts = stagePcts.map(pct => (totalAllocated * pct / 100));

  return {
    enabled: true,
    stages: cfg.stages,
    stage_pct: stagePcts,
    stage_amounts_sol: stageAmounts.map(a => parseFloat(a.toFixed(6))),
    trigger_type: cfg.trigger_type || "price",
    price_trigger_pct: cfg.price_trigger_pct ?? -5,
    time_trigger_min: cfg.time_trigger_min ?? 1440,
    completed_stages: 1,
    next_stage: 2,
    total_allocated_sol: parseFloat(totalAllocated.toFixed(6)),
    avg_entry_price_usd: initialPriceUsd,
    stage_entry_prices: [initialPriceUsd],
    last_stage_at: new Date().toISOString(),
  };
}

/**
 * Check if the next stage should be triggered.
 * Called from management cycle for positions with staged_entry state.
 *
 * @param {Object} staged — staged entry state from position
 * @param {number} currentPnlPct — current unrealized PnL %
 * @param {number} currentPriceUsd — current token price in USD
 * @param {number} ageMinutes — position age in minutes
 * @returns {{ trigger: boolean, reason: string, next_amount_sol: number }}
 */
export function checkStagedEntryTrigger(staged, currentPnlPct, currentPriceUsd, ageMinutes) {
  if (!staged?.enabled) return { trigger: false, reason: null };
  if (staged.completed_stages >= staged.stages) return { trigger: false, reason: "all_stages_complete" };

  const nextAmount = staged.stage_amounts_sol[staged.next_stage - 1];

  if (staged.trigger_type === "time") {
    const lastStageMs = new Date(staged.last_stage_at).getTime();
    const elapsedMin = (Date.now() - lastStageMs) / 60000;
    if (elapsedMin >= staged.time_trigger_min) {
      return {
        trigger: true,
        reason: `time_trigger: ${elapsedMin.toFixed(0)}min >= ${staged.time_trigger_min}min`,
        next_amount_sol: nextAmount,
      };
    }
    return { trigger: false, reason: `waiting_time: ${elapsedMin.toFixed(0)}/${staged.time_trigger_min}min` };
  }

  // Price trigger: buy next stage when PnL drops below threshold from avg entry
  if (staged.trigger_type === "price") {
    // PnL from last stage entry = how much the price dropped since last buy
    const lastEntryPrice = staged.stage_entry_prices[staged.stage_entry_prices.length - 1];
    const dropFromLastEntry = lastEntryPrice > 0
      ? ((currentPriceUsd - lastEntryPrice) / lastEntryPrice) * 100
      : 0;

    if (dropFromLastEntry <= staged.price_trigger_pct) {
      return {
        trigger: true,
        reason: `price_trigger: ${dropFromLastEntry.toFixed(1)}% <= ${staged.price_trigger_pct}% (from last entry)`,
        next_amount_sol: nextAmount,
      };
    }
    return {
      trigger: false,
      reason: `waiting_price: ${dropFromLastEntry.toFixed(1)}% > ${staged.price_trigger_pct}%`,
    };
  }

  return { trigger: false, reason: "unknown_trigger_type" };
}

/**
 * Update staged entry state after executing a subsequent stage.
 */
export function advanceStagedEntry(staged, entryPriceUsd) {
  if (!staged?.enabled) return staged;

  staged.completed_stages = (staged.completed_stages || 1) + 1;
  staged.next_stage = staged.completed_stages + 1;
  staged.stage_entry_prices.push(entryPriceUsd);
  staged.last_stage_at = new Date().toISOString();

  // Recompute average entry price
  const totalWeight = staged.stage_pct.slice(0, staged.completed_stages).reduce((s, p) => s + p, 0);
  let weightedSum = 0;
  for (let i = 0; i < staged.completed_stages; i++) {
    weightedSum += (staged.stage_entry_prices[i] || entryPriceUsd) * staged.stage_pct[i];
  }
  staged.avg_entry_price_usd = parseFloat((weightedSum / totalWeight).toFixed(8));

  return staged;
}

/**
 * Compute the initial stage-1 amount from the total deploy amount.
 * Stage 1 uses only its allocated %, not the full amount.
 */
export function getStage1Amount(staged, deployAmountSol) {
  if (!staged?.enabled || staged.stages <= 1) return deployAmountSol;
  const pct = (staged.stage_pct?.[0] || 100) / 100;
  return parseFloat((deployAmountSol * pct).toFixed(6));
}
