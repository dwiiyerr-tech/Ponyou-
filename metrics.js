/**
 * Lightweight in-memory metrics collector. No external deps — Prometheus-style
 * histograms would be nicer for a real ops stack, but for a single-node retail
 * bot a rolling JSON dump is plenty.
 *
 * Usage:
 *   const t0 = startTimer();
 *   try { ... }
 *   finally { recordLatency("management", elapsedMs(t0)); }
 *
 *   recordSlippage({ expected_out: 100, actual_out: 97 });
 *   recordError("helius_429");
 *
 *   await flushMetrics();  // periodic JSON dump to metrics.json
 *   const snapshot = getStats();  // pull current view for /metrics command
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJsonAsync } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_FILE = process.env.PONYOU_METRICS_FILE || path.join(__dirname, "metrics.json");
const HISTORY_CAP = 200;        // keep last 200 samples per series
const PERSIST_INTERVAL_MS = 60_000; // flush at most once a minute

// ─── State (in-memory) ────────────────────────────────────────────

// Latency samples, keyed by series name (e.g. "management_cycle_ms"). Each
// series is a rolling window of recent observations.
const _samples = new Map();

// Cumulative counters (errors, swaps_executed, etc.)
const _counters = new Map();

// Single-value gauges (most recent observation: current drawdown, balance, ...)
const _gauges = new Map();

// Session metadata
const _startedAt = Date.now();
let _lastPersistAt = 0;
let _persistScheduled = false;

// ─── Recording ────────────────────────────────────────────────────

export function startTimer() {
  return process.hrtime.bigint();
}

export function elapsedMs(t0) {
  return Number(process.hrtime.bigint() - t0) / 1_000_000;
}

function pushSample(series, value) {
  if (!Number.isFinite(value)) {
    if (process.env.NODE_ENV !== "production") console.warn(`[metrics] pushSample dropped non-finite value for series="${series}": ${value}`);
    return;
  }
  if (!_samples.has(series)) _samples.set(series, []);
  const arr = _samples.get(series);
  arr.push(value);
  if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
}

/**
 * Record a latency observation (milliseconds) for a named cycle.
 */
export function recordLatency(cycleName, ms) {
  pushSample(`${cycleName}_ms`, ms);
  maybePersist();
}

/**
 * Record slippage on a swap. ratio is (expected-actual)/expected, positive
 * means user got fewer tokens than quoted. Negative means positive surprise.
 */
export function recordSlippage({ expected_out, actual_out } = {}) {
  if (!Number.isFinite(expected_out) || !Number.isFinite(actual_out) || expected_out <= 0) return;
  const ratio = (expected_out - actual_out) / expected_out;
  pushSample("swap_slippage_ratio", ratio);
  maybePersist();
}

/**
 * Bump a named counter (errors, swaps, etc.).
 */
export function recordError(kind = "unknown") {
  _counters.set(kind, (_counters.get(kind) || 0) + 1);
  maybePersist();
}

export function recordCounter(kind, delta = 1) {
  _counters.set(kind, (_counters.get(kind) || 0) + delta);
  maybePersist();
}

export function setGauge(name, value) {
  if (!Number.isFinite(value)) return;
  _gauges.set(name, value);
  maybePersist();
}

/**
 * Track cumulative PnL delta. Call on every trade close.
 * cumulative_pnl_usd is the running total; cumulative_trades counts closes.
 */
export function recordCumulativePnl(usdDelta) {
  if (!Number.isFinite(usdDelta)) return;
  const current = _gauges.get("cumulative_pnl_usd") || 0;
  _gauges.set("cumulative_pnl_usd", current + usdDelta);
  const trades = (_gauges.get("cumulative_trades") || 0) + 1;
  _gauges.set("cumulative_trades", trades);
  maybePersist();
}

// ─── Aggregation ──────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(series) {
  if (!series || series.length === 0) return null;
  const sorted = [...series].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

export function getStats() {
  const seriesSummary = {};
  for (const [name, samples] of _samples.entries()) {
    seriesSummary[name] = summarize(samples);
  }
  return {
    session_started_at: new Date(_startedAt).toISOString(),
    session_uptime_ms: Date.now() - _startedAt,
    series: seriesSummary,
    counters: Object.fromEntries(_counters),
    gauges: Object.fromEntries(_gauges),
  };
}

// ─── Persistence ──────────────────────────────────────────────────

/**
 * Flush stats to disk. Atomic via temp+rename. Throttled to PERSIST_INTERVAL_MS
 * so high-frequency recordLatency calls don't pound the FS.
 */
function maybePersist() {
  const now = Date.now();
  if (_persistScheduled || now - _lastPersistAt < PERSIST_INTERVAL_MS) return;
  _lastPersistAt = now;
  _persistScheduled = true;
  queueMicrotask(() => {
    _persistScheduled = false;
    flushMetrics().catch((e) => { if (process.env.NODE_ENV !== "production") console.warn("[metrics] persist failed:", e.message); });
  });
}

export async function flushMetrics() {
  const snapshot = getStats();
  await atomicWriteJsonAsync(METRICS_FILE, snapshot);
  _lastPersistAt = Date.now();
  return snapshot;
}

/**
 * Read the latest persisted snapshot written by the bot process. Dashboard and
 * other sidecar processes have separate in-memory counters, so operational
 * health must use this file when available.
 */
export function readPersistedStats() {
  try {
    if (!fs.existsSync(METRICS_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Test helpers (exported for unit tests, not for runtime use) ──

export function _resetForTests() {
  _samples.clear();
  _counters.clear();
  _gauges.clear();
  // Set lastPersistAt to "now" so subsequent record* calls in tests won't
  // trigger a real disk write (throttle window keeps them in memory).
  _lastPersistAt = Date.now();
  _persistScheduled = false;
  if (fs.existsSync(METRICS_FILE)) {
    try { fs.unlinkSync(METRICS_FILE); } catch { /* best-effort */ }
  }
}
