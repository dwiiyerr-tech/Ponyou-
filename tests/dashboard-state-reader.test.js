import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBotState, _setBasePath } from "../dashboard/state-reader.js";

let tmpDir;
const ENV_KEYS = [
  "PONYOU_STATE_FILE",
  "PONYOU_EXEC_QUALITY_FILE",
  "PONYOU_PLAN_FILE",
  "PONYOU_VAULT_DIR",
  "PONYOU_KILL_SWITCH_STATE",
  "PONYOU_METRICS_FILE",
];
let savedEnv;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-dash-state-"));
  _setBasePath(tmpDir);
  // The reader gives env-redirected paths precedence over BASE_PATH, so clear
  // those vars here to let _setBasePath drive reads to this test's tmpDir.
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.PONYOU_VAULT_DIR = path.join(tmpDir, "ponyou-brain");
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readBotState", () => {
  it("returns safe defaults when no files exist", async () => {
    const s = await readBotState();
    expect(s.bot_running).toBe(false);
    expect(s.balance_sol).toBe(0);
    expect(s.positions).toEqual([]);
    expect(s.features).toBeDefined();
  });

  it("uses a fresh state timestamp as the bot heartbeat", async () => {
    const statePath = path.join(tmpDir, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ lastUpdated: new Date().toISOString() }));
    expect((await readBotState()).bot_running).toBe(true);

    fs.writeFileSync(statePath, JSON.stringify({ lastUpdated: new Date(Date.now() - 60_000).toISOString() }));
    expect((await readBotState()).bot_running).toBe(false);
  });

  it("treats a fresh metrics.json as the bot heartbeat even when state.json is stale", async () => {
    // state.json only changes on position events; a quiet book must not
    // render the bot as STOPPED while metrics are still being flushed.
    fs.writeFileSync(
      path.join(tmpDir, "state.json"),
      JSON.stringify({ lastUpdated: new Date(Date.now() - 3 * 60 * 60_000).toISOString() })
    );
    fs.writeFileSync(path.join(tmpDir, "metrics.json"), JSON.stringify({ counters: {}, gauges: {} }));
    expect((await readBotState()).bot_running).toBe(true);

    const stale = (Date.now() - 30 * 60_000) / 1000;
    fs.utimesSync(path.join(tmpDir, "metrics.json"), stale, stale);
    expect((await readBotState()).bot_running).toBe(false);
  });

  it("falls back to metrics gauges for balance and SOL price", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "metrics.json"),
      JSON.stringify({ gauges: { balance_sol: 1.25, sol_price_usd: 160 } })
    );
    fs.writeFileSync(
      path.join(tmpDir, "state.json"),
      JSON.stringify({
        positions: {
          abc: { symbol: "WIF", mint: "abc", closed: false, initial_value_usd: 8 },
        },
      })
    );
    const s = await readBotState();
    expect(s.balance_sol).toBe(1.25);
    expect(s.sol_price).toBe(160);
    // entry_sol should resolve via the gauge-supplied price (8 / 160).
    expect(s.positions[0].entry_sol).toBe(0.05);
  });

  it("derives session PnL from wallet gauge vs kill-switch baseline", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "metrics.json"),
      JSON.stringify({ gauges: { wallet_total_usd: 318.5 } })
    );
    fs.writeFileSync(
      path.join(tmpDir, "kill-switch-state.json"),
      JSON.stringify({ sessionBaseline: 322.13 })
    );
    const s = await readBotState();
    expect(s.pnl_today_usd).toBeCloseTo(-3.63, 2);
  });

  it("reports zero PnL when the baseline is missing", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "metrics.json"),
      JSON.stringify({ gauges: { wallet_total_usd: 318.5 } })
    );
    const s = await readBotState();
    expect(s.pnl_today_usd).toBe(0);
  });

  it("reads open positions from state.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "state.json"),
      JSON.stringify({
        positions: {
          abc123: {
            symbol: "BONK",
            mint: "abc123",
            closed: false,
            pnl_pct: 14.2,
            deployed_at: new Date(Date.now() - 4 * 60000).toISOString(),
            initial_value_usd: 5,
          },
        },
      })
    );
    const s = await readBotState();
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0].symbol).toBe("BONK");
    expect(s.positions[0].pnl_pct).toBe(14.2);
  });

  it("excludes closed positions", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "state.json"),
      JSON.stringify({
        positions: {
          abc: { symbol: "WIF", mint: "abc", closed: true, pnl_pct: -3 },
        },
      })
    );
    const s = await readBotState();
    expect(s.positions).toHaveLength(0);
  });

  it("reads feature toggles from user-config.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "user-config.json"),
      JSON.stringify({
        vault: { sweep: { enabled: true } },
        tradingPlan: { enabled: true, targetTrades: 30 },
        dailyTradeGuardEnabled: true,
      })
    );
    const s = await readBotState();
    expect(s.features.vault_enabled).toBe(true);
    expect(s.features.trading_plan_enabled).toBe(true);
    expect(s.features.daily_guard_enabled).toBe(true);
  });

  it("maps Second Brain markdown files to anonymous visual stars", async () => {
    const vaultDir = process.env.PONYOU_VAULT_DIR;
    fs.mkdirSync(path.join(vaultDir, "01-Strategies"), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, "03-Performance"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, "01-Strategies", "scalping.md"),
      "# Scalping\n\nFast entries with strict risk controls.\n"
    );
    fs.writeFileSync(
      path.join(vaultDir, "03-Performance", "daily.md"),
      "# Daily\n\nWin rate improved after the latest review.\n"
    );

    const s = await readBotState();

    expect(s.second_brain.file_count).toBe(2);
    expect(s.second_brain.total_words).toBeGreaterThan(0);
    expect(s.second_brain.stars).toHaveLength(2);
    expect(s.second_brain.stars[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      orbit: expect.any(Number),
      phase: expect.any(Number),
      speed: expect.any(Number),
      weight: expect.any(Number),
      freshness: expect.any(Number),
      color_index: expect.any(Number),
    }));
    expect(JSON.stringify(s.second_brain)).not.toContain("scalping.md");
    expect(JSON.stringify(s.second_brain)).not.toContain("Fast entries");
  });
});
