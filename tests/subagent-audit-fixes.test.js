// Regression tests for the 2026-06-11 sub-agent architecture audit (collab
// task #14): degenerate exit-time fingerprints, the missing _updateWallet,
// and the structurally inert smart-money source.
import fs from "fs";
import { describe, it, expect, beforeEach } from "vitest";
import { fingerprint } from "../episodic-memory.js";
import { addSmartWallet, listSmartWallets, _updateWallet } from "../smart-wallets.js";
import { detectSmartMoneySignals, getWalletSignalStats } from "../tools/wallet-signal-injector.js";

const WALLETS_FILE = process.env.PONYOU_SMART_WALLETS_FILE;

describe("fingerprint entry-snapshot fallbacks", () => {
  it("uses entry_mcap/entry_liquidity when live market fields are gone", () => {
    const live = fingerprint({ mcap: 50_000, liquidity: 8_000, narrative_tags: ["ai"] });
    const fromSnapshot = fingerprint({ entry_mcap: 50_000, entry_liquidity: 8_000, narrative_tags: ["ai"] });
    expect(fromSnapshot).toBe(live);
    expect(fromSnapshot).toContain("mcap:30-100k");
    expect(fromSnapshot).toContain("liq:5-20k");
  });

  it("derives narrative from conviction.narratives when tags are missing", () => {
    const fp = fingerprint({ conviction: { narratives: ["POLITICAL", "CULTURE"] } });
    expect(fp).toContain("narr:political");
  });

  it("keeps the full UNKNOWN tier label (was truncated to UNKNOW)", () => {
    expect(fingerprint({})).toContain("tier:UNKNOWN");
  });
});

describe("smart-wallets _updateWallet", () => {
  beforeEach(() => {
    if (WALLETS_FILE && fs.existsSync(WALLETS_FILE)) fs.unlinkSync(WALLETS_FILE);
  });

  it("persists last_active for a tracked wallet (was a silent no-op)", async () => {
    await addSmartWallet({ address: "WalletAAA", label: "t", stats: { winrate: 0.9 } });
    const ts = new Date().toISOString();
    const r = await _updateWallet({ address: "WalletAAA", last_active: ts });
    expect(r.updated).toBe(true);
    const w = listSmartWallets().find((x) => x.address === "WalletAAA");
    expect(w.last_active).toBe(ts);
  });

  it("returns updated:false for an unknown wallet", async () => {
    const r = await _updateWallet({ address: "NopeWallet", last_active: new Date().toISOString() });
    expect(r.updated).toBe(false);
  });
});

describe("smart-money inert-source visibility", () => {
  beforeEach(() => {
    if (WALLETS_FILE && fs.existsSync(WALLETS_FILE)) fs.unlinkSync(WALLETS_FILE);
  });

  it("reports inertReason when every qualifying wallet is shadow-mode", async () => {
    await addSmartWallet({ address: "ShadowW1", stats: { winrate: 0.9 } }); // follow_mode defaults to shadow
    const signals = detectSmartMoneySignals({ minWinRate: 0.6 });
    expect(signals).toHaveLength(0);
    expect(getWalletSignalStats().inertReason).toMatch(/follow_mode=shadow/);
  });

  it("produces signals (and clears nothing) for active wallets", async () => {
    await addSmartWallet({ address: "ActiveW1", stats: { winrate: 0.9 }, selection: { follow_mode: "active" } });
    const signals = detectSmartMoneySignals({ minWinRate: 0.6 });
    expect(signals).toHaveLength(1);
    expect(signals[0].followMode).toBe("active");
  });
});
