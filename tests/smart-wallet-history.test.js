import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  getSmartWalletHistory,
  recordSmartWalletSnapshot,
  resetSmartWalletHistory,
  summarizeSmartWalletHistory,
} from "../smart-wallet-history.js";

const HISTORY_FILE = path.join(process.cwd(), "smart-wallet-history.json");
let backup = null;

beforeEach(() => {
  backup = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, "utf8") : null;
  resetSmartWalletHistory();
});

afterEach(() => {
  if (backup != null) fs.writeFileSync(HISTORY_FILE, backup);
  else if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
});

describe("smart wallet history", () => {
  it("records snapshots and returns rolling history", () => {
    recordSmartWalletSnapshot("walletA", { timeframe: "24h", realized_pnl_sol: 0.5, winrate: 0.6, conviction_score: 60 });
    recordSmartWalletSnapshot("walletA", { timeframe: "24h", realized_pnl_sol: 1.2, winrate: 0.8, conviction_score: 75 });

    const history = getSmartWalletHistory("walletA", { timeframe: "24h", limit: 10 });
    expect(history).toHaveLength(2);
    expect(history[1].realized_pnl_sol).toBeCloseTo(1.2);
  });

  it("summarizes stability and trend from recent snapshots", () => {
    recordSmartWalletSnapshot("walletA", { timeframe: "24h", realized_pnl_sol: 0.2, winrate: 0.55, conviction_score: 45 });
    recordSmartWalletSnapshot("walletA", { timeframe: "24h", realized_pnl_sol: 0.8, winrate: 0.7, conviction_score: 68 });
    recordSmartWalletSnapshot("walletA", { timeframe: "24h", realized_pnl_sol: 1.4, winrate: 0.8, conviction_score: 82 });

    const summary = summarizeSmartWalletHistory("walletA", { timeframe: "24h", limit: 12 });
    expect(summary.sample_count).toBe(3);
    expect(summary.avg_realized_pnl_sol).toBeGreaterThan(0.7);
    expect(summary.stability_score).toBeGreaterThan(0);
    expect(summary.pnl_trend).toBeGreaterThan(0);
    expect(summary.conviction_trend).toBeGreaterThan(0);
  });

  it("returns zero summary when wallet has no history", () => {
    const summary = summarizeSmartWalletHistory("missing", { timeframe: "24h", limit: 12 });
    expect(summary.sample_count).toBe(0);
    expect(summary.stability_score).toBe(0);
  });
});
