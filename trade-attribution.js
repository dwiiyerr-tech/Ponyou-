import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTR_FILE = process.env.PONYOU_TRADE_ATTRIBUTION_FILE || path.join(__dirname, "trade-attribution.json");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadStore() {
  if (!fs.existsSync(ATTR_FILE)) {
    return {
      trades: [],
      summary: {
        pick: 0,
        timing: 0,
        execution: 0,
        mixed: 0,
      },
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ATTR_FILE, "utf8"));
    return parsed && typeof parsed === "object"
      ? parsed
      : { trades: [], summary: { pick: 0, timing: 0, execution: 0, mixed: 0 } };
  } catch {
    return { trades: [], summary: { pick: 0, timing: 0, execution: 0, mixed: 0 } };
  }
}

function saveStore(data) {
  atomicWriteJson(ATTR_FILE, data);
}

export function assessTradeAttribution({
  tracked = null,
  exit = {},
  tokenData = {},
  executionQuality = null,
} = {}) {
  const snapshot = tracked?.signal_snapshot || {};
  const conviction = snapshot.conviction || {};
  const regime = snapshot.regime || {};
  const workflow = snapshot.workflow || {};
  const kelly = snapshot.kelly || {};
  const rugScore = Number(snapshot.rug_score || 0);
  const holdMinutes = Number(exit.hold_minutes || 0);
  const pnlPct = Number(exit.pnl_pct || 0);
  const exitReason = String(exit.exit_reason || exit.reason || "");

  let pickScore = 0;
  let timingScore = 0;
  let executionScore = 0;
  const factors = [];

  // ─── PnL magnitude multiplier ─────────────────────────────────
  // A -50% loss carries more signal than -1%. Scale factor scores
  // by magnitude so bigger outcomes sharpen attribution.
  const absPnl = Math.abs(pnlPct);
  const magMult = pnlPct < 0
    ? clamp(0.6 + absPnl / 60, 0.6, 2.0)  // loss: 0.6x at 0% → 2.0x at -84%+
    : clamp(0.5 + absPnl / 100, 0.5, 1.5); // win: 0.5x at 0% → 1.5x at +100%

  if (/rug/i.test(exitReason)) {
    pickScore += Math.round(45 * magMult);
    factors.push("rug_exit");
  }
  if (rugScore >= 30) {
    pickScore += Math.round(20 * magMult);
    factors.push("high_rug_score");
  }
  if ((workflow.caution_score || 0) >= 28) {
    pickScore += Math.round(16 * magMult);
    factors.push("high_caution_entry");
  }
  if ((conviction.conviction_score || 0) < 40) {
    pickScore += Math.round(18 * magMult);
    factors.push("weak_conviction_entry");
  }
  if ((regime.regime_score || 0) < 40 && (regime.confidence_score || 0) >= 20) {
    pickScore += Math.round(15 * magMult);
    factors.push("weak_regime_entry");
  }
  if (kelly.should_skip) {
    pickScore += Math.round(25 * magMult);
    factors.push("ignored_negative_kelly");
  }

  if (holdMinutes <= 10 && pnlPct < 0 && (conviction.conviction_score || 0) >= 60 && (regime.regime_score || 0) >= 50) {
    timingScore += Math.round(28 * magMult);
    factors.push("strong_setup_failed_fast");
  }
  if (holdMinutes <= 5 && /stop loss/i.test(exitReason)) {
    timingScore += Math.round(16 * magMult);
    factors.push("early_stopout");
  }
  if ((workflow.verdict || "") === "probe" && pnlPct < 0 && holdMinutes <= 15) {
    timingScore += Math.round(10 * magMult);
    factors.push("probe_entry_failed");
  }

  const execution = executionQuality || snapshot.execution_quality || {};
  if ((execution.quality_score || 50) < 40) {
    executionScore += Math.round(28 * magMult);
    factors.push("low_execution_quality");
  }
  if ((execution.avg_slippage || snapshot.execution_context?.slippage || 0) >= 1.5) {
    executionScore += Math.round(14 * magMult);
    factors.push("high_slippage");
  }
  if ((execution.avg_latency_ms || 0) >= 4000) {
    executionScore += Math.round(12 * magMult);
    factors.push("slow_execution");
  }
  if (holdMinutes <= 3 && pnlPct < 0 && (execution.quality_score || 50) < 55) {
    executionScore += Math.round(12 * magMult);
    factors.push("immediate_post_fill_damage");
  }

  const ranking = [
    ["pick", clamp(pickScore, 0, 100)],
    ["timing", clamp(timingScore, 0, 100)],
    ["execution", clamp(executionScore, 0, 100)],
  ].sort((a, b) => b[1] - a[1]);

  const top = ranking[0];
  const second = ranking[1];
  const primary = top[1] >= 18 ? top[0] : "mixed";
  const confidence = clamp(top[1] - second[1] + 50, 0, 100);

  return {
    primary_cause: primary,
    confidence_score: Number(confidence.toFixed(1)),
    scores: {
      pick: ranking.find(r => r[0] === "pick")[1],
      timing: ranking.find(r => r[0] === "timing")[1],
      execution: ranking.find(r => r[0] === "execution")[1],
    },
    factors,
  };
}

export async function recordTradeAttribution(entry = {}) {
  return withFileLock(ATTR_FILE, async () => {
    const store = loadStore();
    store.trades.push({
      ts: new Date().toISOString(),
      mint: entry.mint || null,
      symbol: entry.symbol || null,
      pnl_pct: Number.isFinite(Number(entry.pnl_pct)) ? Number(entry.pnl_pct) : null,
      win: entry.win ?? (Number.isFinite(Number(entry.pnl_pct)) ? Number(entry.pnl_pct) > 0 : null),
      ...entry,
    });
    if (store.trades.length > 500) store.trades = store.trades.slice(-500);

    const cause = entry.primary_cause || "mixed";
    if (!store.summary[cause]) store.summary[cause] = 0;
    store.summary[cause] += 1;
    saveStore(store);
  });
}

export function getAttributionSummary() {
  const store = loadStore();
  const total = Object.values(store.summary || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  return {
    total,
    ...store.summary,
  };
}

export function getAttributionPromptLine() {
  const summary = getAttributionSummary();
  if (!(summary.total > 0)) return "";
  return `Attribution: pick=${summary.pick || 0} timing=${summary.timing || 0} execution=${summary.execution || 0} mixed=${summary.mixed || 0}`;
}

export function _resetTradeAttributionForTests() {
  if (fs.existsSync(ATTR_FILE)) fs.unlinkSync(ATTR_FILE);
}
