import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBotState, _setBasePath } from "../dashboard/state-reader.js";

let tmpDir;
const ENV_KEYS = ["PONYOU_STATE_FILE", "PONYOU_EXEC_QUALITY_FILE", "PONYOU_PLAN_FILE"];
let savedEnv;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-dash-state-"));
  _setBasePath(tmpDir);
  // The reader gives env-redirected paths precedence over BASE_PATH, so clear
  // those vars here to let _setBasePath drive reads to this test's tmpDir.
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
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
});
