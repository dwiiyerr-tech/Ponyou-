import fs from "fs";
import path from "path";
import { atomicWriteJson } from "./atomic-write.js";

const STATE_PATH = path.resolve("partial-tp-guard-state.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(state) {
  atomicWriteJson(STATE_PATH, state);
}

/**
 * Check if a partial TP for this position+attempt has already been submitted.
 * Returns true if already landed (idempotency block).
 */
export function isPartialTPLanded(positionKey, attempt = 1) {
  const state = load();
  const key = `${positionKey}::${attempt}`;
  return !!state[key]?.landed;
}

/**
 * Mark a partial TP as landed so retries are blocked.
 */
export function markPartialTPLanded(positionKey, attempt = 1) {
  const state = load();
  const key = `${positionKey}::${attempt}`;
  state[key] = { landed: true, ts: Date.now() };
  save(state);
}

/**
 * Clear all landed records for a position (e.g. after full close).
 */
export function clearPartialTPGuard(positionKey) {
  const state = load();
  for (const key of Object.keys(state)) {
    if (key.startsWith(`${positionKey}::`)) delete state[key];
  }
  save(state);
}

/**
 * Prune entries older than maxAgeDays (default 7) to keep file lean.
 */
export function prunePartialTPGuard(maxAgeDays = 7) {
  const state = load();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [key, val] of Object.entries(state)) {
    if (val.ts && val.ts < cutoff) { delete state[key]; pruned++; }
  }
  if (pruned > 0) save(state);
  return pruned;
}
