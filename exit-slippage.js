import { config } from "./config.js";

export function getExitSlippage(attempt) {
  const steps = config.exitSlippage?.steps ?? [1, 5, 10, 20];
  const idx = Math.max(0, Math.min(attempt - 1, steps.length - 1));
  return steps[idx] / 100;
}

export function validateSlippageConfig() {
  const steps = config.exitSlippage?.steps;
  if (steps !== undefined) {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error("exitSlippage.steps must be a non-empty array");
    if (steps.some(s => typeof s !== "number" || s <= 0 || s > 100)) throw new Error("exitSlippage.steps values must be numbers between 1 and 100");
  }
  const max = config.exitSlippage?.maxAttempts;
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new Error("exitSlippage.maxAttempts must be a positive integer");
}

/**
 * Run an exit swap with progressive slippage retries.
 * exitFn(slippage): async function that calls swapToken — returns swap result.
 * Returns { result, attempt, stuck } where stuck=true means all attempts failed.
 */
export async function withProgressiveSlippage(exitFn, { maxAttempts } = {}) {
  const max = maxAttempts ?? config.exitSlippage?.maxAttempts ?? 4;
  let lastResult = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const slippage = getExitSlippage(attempt);
    lastResult = await exitFn(slippage);
    if (lastResult.success || lastResult.dry_run) {
      return { result: lastResult, attempt, stuck: false };
    }
    // M3: indeterminate = swap was sent but outcome is unknown (e.g. signature
    // not confirmed). Retrying at higher slippage risks a double-sell. Surface
    // it to the caller as a non-stuck, non-success result so it can handle the
    // ambiguity (e.g. wait for confirmation) rather than escalating slippage.
    if (lastResult.indeterminate) {
      return { result: lastResult, attempt, stuck: false, indeterminate: true };
    }
  }
  return { result: lastResult, attempt: max, stuck: true };
}
