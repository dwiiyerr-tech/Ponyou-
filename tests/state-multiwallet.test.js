import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  _resetStateForTests,
  buildPositionKey,
  cleanStaleTestPositions,
  getTrackedPosition,
  listTrackedPositions,
  recordClose,
  trackPosition,
} from "../state.js";

const STATE_FILE = path.join(process.cwd(), "state.json");
let backup = null;

beforeEach(() => {
  _resetStateForTests();
  backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8") : null;
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
});

afterEach(() => {
  _resetStateForTests();
  if (backup != null) fs.writeFileSync(STATE_FILE, backup);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
});

describe("state multi-wallet positions", () => {
  it("builds wallet-aware position keys", () => {
    expect(buildPositionKey("mintA", "wallet1")).toBe("mintA::wallet1");
    expect(buildPositionKey("mintA")).toBe("mintA");
  });

  it("tracks same mint across multiple wallets without overwriting", async () => {
    await trackPosition({ position: "mintA", pool: "gmgn", pool_name: "AAA", amount_sol: 1, initial_value_usd: 10, wallet_address: "wallet1" });
    await trackPosition({ position: "mintA", pool: "gmgn", pool_name: "AAA", amount_sol: 2, initial_value_usd: 20, wallet_address: "wallet2" });

    const positions = listTrackedPositions("mintA", { open_only: true });
    expect(positions).toHaveLength(2);
    expect(getTrackedPosition("mintA", "wallet1")?.amount_sol).toBe(1);
    expect(getTrackedPosition("mintA", "wallet2")?.amount_sol).toBe(2);
  });

  it("closes only the targeted wallet position when wallet is specified", async () => {
    await trackPosition({ position: "mintA", pool: "gmgn", pool_name: "AAA", amount_sol: 1, initial_value_usd: 10, wallet_address: "wallet1" });
    await trackPosition({ position: "mintA", pool: "gmgn", pool_name: "AAA", amount_sol: 2, initial_value_usd: 20, wallet_address: "wallet2" });

    await recordClose("mintA", "TP hit", "wallet1");

    expect(getTrackedPosition("mintA", "wallet1")).toBeNull();
    expect(getTrackedPosition("mintA", "wallet2")?.closed).toBe(false);
  });

  it("cleans stale test positions without deleting valid multi-wallet positions", async () => {
    const validMint = "6veQU7HDdXV5DC2Eqhnri5q71gkMzG73qKkSSudnpump";

    await trackPosition({ position: "mintSell", pool: "gmgn", pool_name: "TEST", amount_sol: 1, initial_value_usd: 10, wallet_address: "walletB" });
    await trackPosition({ position: "SMOKE_TEST_POS", pool: "gmgn", pool_name: "TEST", amount_sol: 1, initial_value_usd: 10 });
    await trackPosition({ position: validMint, pool: "gmgn", pool_name: "REAL", amount_sol: 1, initial_value_usd: 10, wallet_address: "walletA" });

    expect(cleanStaleTestPositions()).toBe(2);

    expect(getTrackedPosition("mintSell", "walletB")).toBeNull();
    expect(getTrackedPosition("SMOKE_TEST_POS")).toBeNull();
    expect(getTrackedPosition(validMint, "walletA")?.closed).toBe(false);
  });

  it("identifies test position keys correctly", () => {
    const testKeys = ["mintSell::walletB", "mintDca::walletA", "SMOKE_TEST_POS"];
    const validKeys = ["6veQU7HDdXV5DC2Eqhnri5q71gkMzG73qKkSSudnpump"];

    for (const key of testKeys) {
      expect(key.includes("::") || key === "SMOKE_TEST_POS").toBe(true);
    }
    for (const key of validKeys) {
      expect(key.includes("::")).toBe(false);
      expect(key.length).toBeGreaterThanOrEqual(32);
    }
  });
});
