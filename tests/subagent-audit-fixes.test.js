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

// ─── Smart-money token resolution (collab task #15 follow-up) ────────────────
import { resolveSmartMoneyTokenSignals, buildSmartMoneyCandidates } from "../tools/wallet-signal-injector.js";

describe("smart-money token resolution", () => {
  const SIG = { wallet: "WalletAAA", walletLabel: "vip", winRate: 0.9, signalStrength: "STRONG", priority: 1 };
  const nowMs = Date.now();
  const fresh = Math.floor(nowMs / 1000) - 60;          // 1 min ago
  const stale = Math.floor(nowMs / 1000) - 2 * 60 * 60; // 2h ago — outside window

  function deps(rows, updates = []) {
    return {
      getWalletActivity: async () => rows,
      normalizeWalletActivity: (r) => r,
      updateWallet: async (w) => { updates.push(w); return { updated: true }; },
      nowMs,
    };
  }

  it("resolves recent buys into token signals and persists last_active", async () => {
    const updates = [];
    const rows = [
      { side: "buy", token_mint: "MintFresh", symbol: "FRESH", timestamp: fresh, sol_amount: 0.5 },
      { side: "buy", token_mint: "MintStale", symbol: "OLD", timestamp: stale, sol_amount: 0.5 },
      { side: "sell", token_mint: "MintSell", symbol: "SELL", timestamp: fresh, sol_amount: 0.5 },
    ];
    const out = await resolveSmartMoneyTokenSignals([SIG], deps(rows, updates));
    expect(out).toHaveLength(1);
    expect(out[0].mint).toBe("MintFresh");
    expect(out[0].winRate).toBe(0.9);
    expect(updates).toHaveLength(1);
    expect(updates[0].address).toBe("WalletAAA");
  });

  it("survives a failing activity fetch", async () => {
    const out = await resolveSmartMoneyTokenSignals([SIG], {
      getWalletActivity: async () => { throw new Error("429"); },
      normalizeWalletActivity: (r) => r,
      updateWallet: async () => ({}),
    });
    expect(out).toHaveLength(0);
  });

  it("buildSmartMoneyCandidates emits real-mint candidates and drops unresolved signals", () => {
    const candidates = buildSmartMoneyCandidates([
      { ...SIG, mint: "MintFresh", symbol: "FRESH" },
      { ...SIG }, // unresolved wallet-level signal — must be dropped
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].mint).toBe("MintFresh");
    expect(candidates[0].symbol).toBe("FRESH");
    expect(candidates[0]._hunter_source).toBe("smart_money_wallet");
  });
});

// ─── Lesson application tracking ─────────────────────────────────────────────
import { addLesson, getActiveLessonIds, recordLessonOutcome, getLessonAnalytics, clearAllLessons } from "../lessons.js";

describe("lesson application tracking", () => {
  beforeEach(() => clearAllLessons());

  it("getActiveLessonIds mirrors prompt selection (pinned, role, general)", () => {
    const a = addLesson("screener rule", [], { role: "SCREENER" }); // returns id
    const b = addLesson("manager rule", [], { role: "MANAGER" });
    const c = addLesson("general rule", []);
    const ids = getActiveLessonIds({ agentType: "SCREENER" });
    expect(ids).toContain(a);
    expect(ids).toContain(c);
    expect(ids).not.toContain(b);
  });

  it("recordLessonOutcome attributes wins/losses to active lessons", () => {
    const lessonId = addLesson("rule x", [], { role: "SCREENER" });
    const ids = getActiveLessonIds({ agentType: "SCREENER" });
    recordLessonOutcome(ids, 25);   // win
    recordLessonOutcome(ids, -10);  // loss
    const stats = getLessonAnalytics().find((x) => x.id === lessonId);
    expect(stats.times_applied).toBe(2);
    expect(stats.success_count).toBe(1);
    expect(stats.failure_count).toBe(1);
  });
});
