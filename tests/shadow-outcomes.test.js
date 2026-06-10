/**
 * Shadow-watchlist terminal outcomes:
 *   - expired token that peaked ≥ +50% → "mooned" + shadow:winner_missed +
 *     positive darwin feedback
 *   - expired flat token → "survived", no darwin feedback
 *   - rug (LP pull) → negative darwin feedback alongside shadow:rug_detected
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateDarwinWeights, emit, marketInfo, files } = vi.hoisted(() => ({
  updateDarwinWeights: vi.fn(),
  emit: vi.fn(),
  marketInfo: vi.fn(),
  files: new Map(),
}));

vi.mock("../lessons.js", () => ({ updateDarwinWeights }));
vi.mock("../agents/agent-bus.js", () => ({ agentBus: { emit, subscribe: vi.fn(() => vi.fn()) } }));
vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../config.js", () => ({ config: { darwin: { enabled: true, boostFactor: 1.05 } } }));
vi.mock("../tools/dexscreener.js", () => ({ getTokenMarketInfo: marketInfo }));
vi.mock("../atomic-write.js", () => ({
  withFileLock: vi.fn((_f, fn) => fn()),
  atomicWriteJson: vi.fn((f, data) => files.set(f, JSON.stringify(data))),
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  const patched = {
    ...actual,
    existsSync: vi.fn((f) => files.has(f) || actual.existsSync(f)),
    readFileSync: vi.fn((f, enc) => (files.has(f) ? files.get(f) : actual.readFileSync(f, enc))),
  };
  return { ...patched, default: patched };
});

const { checkAll } = await import("../tools/shadow-watchlist.js");

const WATCHLIST_KEY = () => [...files.keys()].find(k => k.includes("shadow-watchlist")) || null;

function seedWatchlist(tokens) {
  // The module path-joins from tools/ — match any key by writing via the same
  // file name the module reads (resolve by letting load() miss first is not
  // possible, so precompute the path the module uses).
  const path = new URL("../shadow-watchlist.json", import.meta.url).pathname.replace("/tests/", "/");
  files.set(path, JSON.stringify({ tokens }));
  return path;
}

beforeEach(() => {
  updateDarwinWeights.mockReset();
  emit.mockReset();
  marketInfo.mockReset();
  files.clear();
});

describe("shadow-watchlist terminal outcomes", () => {
  it("expired peaked token → mooned + winner_missed + positive darwin", async () => {
    seedWatchlist([{
      mint: "MoonMint", symbol: "MOON", name: "Moon", hunt_source: "pumpfun",
      entry_price: 1, peak_price: 1.8, entry_liq: 5000,
      active_signals: ["conviction", "velocity"],
      added_at: 0, expires_at: Date.now() - 1000,
      checks: [], status: "watching",
    }]);
    await checkAll();

    const winnerEvents = emit.mock.calls.filter(c => c[0] === "shadow:winner_missed");
    expect(winnerEvents).toHaveLength(1);
    expect(winnerEvents[0][1].peak_gain_pct).toBeCloseTo(80, 1);
    expect(updateDarwinWeights).toHaveBeenCalledWith(
      ["conviction", "velocity"], expect.closeTo(80, 1), expect.any(Object),
    );
  });

  it("expired flat token → survived, no darwin feedback", async () => {
    seedWatchlist([{
      mint: "FlatMint", symbol: "FLAT", name: "Flat", hunt_source: "jupiter",
      entry_price: 1, peak_price: 1.1, entry_liq: 5000,
      active_signals: ["conviction"],
      added_at: 0, expires_at: Date.now() - 1000,
      checks: [], status: "watching",
    }]);
    await checkAll();

    expect(emit.mock.calls.some(c => c[0] === "shadow:winner_missed")).toBe(false);
    expect(updateDarwinWeights).not.toHaveBeenCalled();
  });

  it("LP pull rug → rug_detected + negative darwin", async () => {
    seedWatchlist([{
      mint: "RugMint", symbol: "RUG", name: "Rug", hunt_source: "pumpfun",
      entry_price: 1, peak_price: 1, entry_liq: 5000,
      active_signals: ["velocity", "social_buzz"],
      added_at: Date.now(), expires_at: Date.now() + 60 * 60 * 1000,
      checks: [], status: "watching",
    }]);
    marketInfo.mockResolvedValue({ price: 0.9, liquidity: 50 }); // liq < $200 → LP pull
    await checkAll();

    expect(emit.mock.calls.some(c => c[0] === "shadow:rug_detected")).toBe(true);
    expect(updateDarwinWeights).toHaveBeenCalledWith(
      ["velocity", "social_buzz"], -100, expect.any(Object),
    );
  });
});
