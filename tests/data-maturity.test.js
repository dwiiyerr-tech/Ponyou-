import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getDataMaturity } from "../data-maturity.js";

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "data-maturity-"));
}

describe("data-maturity", () => {
  let dir;
  let paths;

  beforeEach(() => {
    dir = makeTempDir();
    paths = {
      regime:           path.join(dir, "regime-memory.json"),
      conviction:       path.join(dir, "coin-conviction.json"),
      smartWallet:      path.join(dir, "smart-wallet-history.json"),
      executionQuality: path.join(dir, "execution-quality.json"),
    };
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("reports ageDays=0 when no memories exist", () => {
    const result = getDataMaturity({ paths });
    expect(result.ageDays).toBe(0);
    expect(result.oldestSeenAt).toBeNull();
    expect(result.sources).toEqual([]);
    expect(result.mature(30)).toBe(false);
  });

  it("derives ageDays from earliest regime observation", () => {
    const oldTs = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(paths.regime, {
      regimes: {
        "HOT|TIER1|AI|active": { last_seen_at: oldTs },
      },
    });
    const result = getDataMaturity({ paths });
    expect(result.ageDays).toBeGreaterThan(44);
    expect(result.ageDays).toBeLessThan(46);
    expect(result.sources).toContain("regime");
    expect(result.mature(30)).toBe(true);
    expect(result.mature(60)).toBe(false);
  });

  it("picks the EARLIEST timestamp across sources", () => {
    const oldRegime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const olderConviction = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(paths.regime, { regimes: { x: { last_seen_at: oldRegime } } });
    writeJson(paths.conviction, {
      coins: { MintA: { last_seen_at: olderConviction } },
      narratives: {},
    });
    const result = getDataMaturity({ paths });
    expect(result.ageDays).toBeGreaterThan(39);
    expect(result.sources).toEqual(expect.arrayContaining(["regime", "conviction"]));
  });

  it("uses smart-wallet snapshot[0].ts as wallet age", () => {
    const oldTs = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
    writeJson(paths.smartWallet, {
      wallets: {
        WalletA: {
          snapshots: [
            { ts: oldTs, timeframe: "24h", realized_pnl_sol: 1 },
          ],
        },
      },
    });
    const result = getDataMaturity({ paths });
    expect(result.ageDays).toBeGreaterThan(49);
    expect(result.sources).toContain("smartWallet");
  });

  it("survives malformed JSON without throwing", () => {
    fs.writeFileSync(paths.regime, "{this is not json");
    fs.writeFileSync(paths.conviction, "");
    const result = getDataMaturity({ paths });
    expect(result.ageDays).toBe(0);
    expect(result.mature(30)).toBe(false);
  });

  it("mature() returns true when threshold is 0", () => {
    const result = getDataMaturity({ paths });
    expect(result.mature(0)).toBe(true);
  });
});
