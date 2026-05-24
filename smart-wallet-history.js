import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "smart-wallet-history.json");
const MAX_SNAPSHOTS_PER_WALLET = 40;

function loadHistoryFile() {
  if (!fs.existsSync(HISTORY_FILE)) return { wallets: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { wallets: {} };
  } catch {
    return { wallets: {} };
  }
}

function saveHistoryFile(data) {
  atomicWriteJson(HISTORY_FILE, data);
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeTrend(values = []) {
  if (values.length < 2) return 0;
  const midpoint = Math.floor(values.length / 2);
  const early = average(values.slice(0, midpoint));
  const late = average(values.slice(midpoint));
  return late - early;
}

export async function recordSmartWalletSnapshot(address, snapshot = {}) {
  if (!address) return null;
  return withFileLock(HISTORY_FILE, async () => {
    const data = loadHistoryFile();
    if (!data.wallets[address]) data.wallets[address] = { snapshots: [] };

    const entry = {
      ts: snapshot.ts || new Date().toISOString(),
      timeframe: snapshot.timeframe || "24h",
      realized_pnl_sol: Number(snapshot.realized_pnl_sol || 0),
      winrate: Number(snapshot.winrate || 0),
      conviction_score: Number(snapshot.conviction_score || 0),
      buy_pressure: Number(snapshot.buy_pressure ?? 0.5),
      trade_count: Number(snapshot.trade_count || 0),
      open_positions: Number(snapshot.open_positions || 0),
    };

    data.wallets[address].snapshots.push(entry);
    if (data.wallets[address].snapshots.length > MAX_SNAPSHOTS_PER_WALLET) {
      data.wallets[address].snapshots = data.wallets[address].snapshots.slice(-MAX_SNAPSHOTS_PER_WALLET);
    }
    saveHistoryFile(data);
    return entry;
  });
}

export function getSmartWalletHistory(address, { timeframe = null, limit = 12 } = {}) {
  const data = loadHistoryFile();
  const snapshots = data.wallets[address]?.snapshots || [];
  const filtered = timeframe ? snapshots.filter(s => s.timeframe === timeframe) : snapshots;
  return filtered.slice(-limit);
}

export function summarizeSmartWalletHistory(address, options = {}) {
  const snapshots = getSmartWalletHistory(address, options);
  if (snapshots.length === 0) {
    return {
      sample_count: 0,
      avg_realized_pnl_sol: 0,
      avg_winrate: 0,
      avg_conviction_score: 0,
      stability_score: 0,
      pnl_trend: 0,
      conviction_trend: 0,
      last_seen_at: null,
    };
  }

  const pnlSeries = snapshots.map(s => s.realized_pnl_sol);
  const winrateSeries = snapshots.map(s => s.winrate);
  const convictionSeries = snapshots.map(s => s.conviction_score);
  const positivePnlRatio = pnlSeries.filter(v => v > 0).length / pnlSeries.length;
  const positiveWinrateRatio = winrateSeries.filter(v => v >= 0.6).length / winrateSeries.length;
  const stabilityScore = Math.max(0, Math.min(100, Math.round(
    average(convictionSeries) * 0.5 +
    positivePnlRatio * 25 +
    positiveWinrateRatio * 25
  )));

  return {
    sample_count: snapshots.length,
    avg_realized_pnl_sol: Number(average(pnlSeries).toFixed(4)),
    avg_winrate: Number(average(winrateSeries).toFixed(3)),
    avg_conviction_score: Number(average(convictionSeries).toFixed(1)),
    stability_score: stabilityScore,
    pnl_trend: Number(computeTrend(pnlSeries).toFixed(4)),
    conviction_trend: Number(computeTrend(convictionSeries).toFixed(1)),
    last_seen_at: snapshots[snapshots.length - 1]?.ts || null,
  };
}

export function resetSmartWalletHistory() {
  saveHistoryFile({ wallets: {} });
}
