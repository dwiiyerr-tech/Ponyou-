/**
 * Volume Divergence Detector — early warning of distribution phase
 *
 * The classic exhaustion pattern: price keeps making new highs while
 * volume DECLINES on each leg up. Means fewer buyers each push — the
 * rally is running on fumes. Pro traders exit before SL/TP triggers
 * because they see the exhaustion form.
 *
 * Detection requires a small rolling history of (ts, price, volume_window)
 * — we use the slow-rug-history.json file's samples for storage
 * efficiency (same shape works for our needs here).
 *
 * Patterns detected:
 *   1. PRICE_UP_VOLUME_DOWN — price up >5% over N samples while volume
 *      down >25% on each leg
 *   2. SHRINKING_RANGES — price reaches new highs but each leg's high
 *      has less volume than the previous leg
 *
 * Returns a warning level. Caller (management agent) decides whether
 * to act — typically tightens trailing-stop or exits at next bounce.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "..", "volume-divergence-history.json");

const MAX_SAMPLES_PER_TOKEN = 20;

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { tokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return { tokens: parsed.tokens || {} };
  } catch { return { tokens: {} }; }
}

function writeHistory(state) { atomicWriteJson(HISTORY_FILE, state); }

/**
 * Record price + volume sample. Called by management cycle per held position.
 */
export async function recordPriceVolumeSample({ mint, price_usd, volume_recent_usd } = {}) {
  if (!mint || !(price_usd > 0)) return;
  await withFileLock(HISTORY_FILE, async () => {
    const state = readHistory();
    if (!state.tokens[mint]) state.tokens[mint] = { samples: [] };
    state.tokens[mint].samples.push({
      ts: new Date().toISOString(),
      price_usd: Number(price_usd),
      volume_usd: Number(volume_recent_usd || 0),
    });
    if (state.tokens[mint].samples.length > MAX_SAMPLES_PER_TOKEN) {
      state.tokens[mint].samples = state.tokens[mint].samples.slice(-MAX_SAMPLES_PER_TOKEN);
    }
    writeHistory(state);
  });
}

/**
 * Evaluate divergence over the most recent N samples.
 *
 * @param {string} mint
 * @param {Object} opts — { sampleCount?, minPriceUpPct?, minVolumeDeclinePct? }
 * @returns {{
 *   detected: boolean,
 *   pattern: 'price_up_volume_down'|'shrinking_ranges'|null,
 *   severity: 'none'|'watch'|'high',
 *   evidence: Object | null,
 *   recommendation: string,
 * }}
 */
export function evaluateVolumeDivergence(mint, opts = {}) {
  const sampleCount = Math.max(3, Number(opts.sampleCount ?? 5));
  const minPriceUp = Number(opts.minPriceUpPct ?? 0.05);
  const minVolDecline = Number(opts.minVolumeDeclinePct ?? 0.25);

  const state = readHistory();
  const all = state.tokens[mint]?.samples || [];
  if (all.length < sampleCount) {
    return {
      detected: false,
      pattern: null,
      severity: "none",
      evidence: { sample_count: all.length, need: sampleCount },
      recommendation: "continue monitoring",
    };
  }

  const samples = all.slice(-sampleCount);
  const first = samples[0];
  const last = samples[samples.length - 1];

  // Pattern 1: Price-up, volume-down across the window
  const priceMove = first.price_usd > 0 ? (last.price_usd - first.price_usd) / first.price_usd : 0;
  // Compare volume in first vs last halves
  const half = Math.floor(samples.length / 2);
  const earlyVolAvg = samples.slice(0, half).reduce((s, x) => s + (x.volume_usd || 0), 0) / Math.max(1, half);
  const lateVolAvg  = samples.slice(-half).reduce((s, x) => s + (x.volume_usd || 0), 0) / Math.max(1, half);
  const volDecline = earlyVolAvg > 0 ? (earlyVolAvg - lateVolAvg) / earlyVolAvg : 0;

  if (priceMove >= minPriceUp && volDecline >= minVolDecline) {
    const severity = volDecline >= 0.50 ? "high" : "watch";
    return {
      detected: true,
      pattern: "price_up_volume_down",
      severity,
      evidence: {
        price_change_pct: Number((priceMove * 100).toFixed(1)),
        volume_decline_pct: Number((volDecline * 100).toFixed(1)),
        sample_count: samples.length,
      },
      recommendation: severity === "high"
        ? "EXIT — exhaustion confirmed, tighten trailing and prepare sell"
        : "tighten trailing-stop, exit on next pullback",
    };
  }

  // Pattern 2: Shrinking ranges — each new local high has less volume
  // Simple proxy: max volume in early third > max volume in late third
  // while price is still trending up.
  const third = Math.floor(samples.length / 3);
  if (third >= 2) {
    const earlyMaxVol = Math.max(...samples.slice(0, third).map((s) => s.volume_usd || 0));
    const lateMaxVol = Math.max(...samples.slice(-third).map((s) => s.volume_usd || 0));
    if (earlyMaxVol > 0 && lateMaxVol < earlyMaxVol * 0.6 && priceMove > 0.02) {
      return {
        detected: true,
        pattern: "shrinking_ranges",
        severity: "watch",
        evidence: {
          early_max_volume: earlyMaxVol,
          late_max_volume: lateMaxVol,
          price_still_rising_pct: Number((priceMove * 100).toFixed(1)),
        },
        recommendation: "rallies losing fuel — consider trimming",
      };
    }
  }

  return {
    detected: false,
    pattern: null,
    severity: "none",
    evidence: { sample_count: samples.length },
    recommendation: "no divergence",
  };
}

export function _resetVolumeDivergenceForTests() {
  if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
}
