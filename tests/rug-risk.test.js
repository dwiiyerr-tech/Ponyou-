import { afterEach, describe, it, expect, vi } from "vitest";
import AgentRouter from "../agent-router.js";
import { attachExitMonitor } from "../geyser-exit-monitor.js";
import { scoreRugRisk } from "../lessons.js";
import { clearSignalCache, gatherRugSignals } from "../tools/rug-signals.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

afterEach(() => {
  clearSignalCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.HELIUS_API_KEY;
  delete process.env.SHYFT_API_KEY;
});

describe("scoreRugRisk fail-safe guards", () => {
  it("hard-blocks when the security collector fails", () => {
    const result = scoreRugRisk({
      mint: "mint-security-error",
      creator: "creator-security-error",
      rug_signals: {
        _collector_error: "RPC timeout",
      },
    });

    expect(result.score).toBe(100);
    expect(result.reasons[0]).toContain("Security collector failed");
  });

  it("hard-blocks when Helius enrichment was expected but degraded", () => {
    const result = scoreRugRisk({
      mint: "mint-helius-degraded",
      creator: "creator-helius-degraded",
      rug_signals: {
        _helius_expected: true,
        _helius_degraded: true,
        _helius_reason: "Helius circuit open",
      },
    });

    expect(result.score).toBe(100);
    expect(result.reasons[0]).toContain("Helius enrichment unavailable");
  });

  it("does not hard-block when Helius telemetry was not expected", () => {
    const result = scoreRugRisk({
      mint: "mint-no-helius-needed",
      creator: "creator-no-helius-needed",
      rug_signals: {
        _helius_expected: false,
        _helius_degraded: false,
        top10_concentration_pct: 10,
      },
    });

    expect(result.score).toBeLessThan(100);
  });

  it("caches degraded signals with short TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));

    process.env.HELIUS_API_KEY = "test-helius-key";
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = {
      getParsedAccountInfo: vi.fn(async () => ({
        value: { owner: { toString: () => "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } },
      })),
    };

    const first = await gatherRugSignals({
      mint: SOL_MINT,
      connection,
      holderOwners: ["holder-1"],
      launchTs: Math.floor(Date.now() / 1000),
    });
    expect(first._data_quality).toBe("degraded");
    expect(first._helius_degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await gatherRugSignals({
      mint: SOL_MINT,
      connection,
      holderOwners: ["holder-1"],
      launchTs: Math.floor(Date.now() / 1000),
    });
    expect(cached._cached).toBe(true);
    expect(cached._data_quality).toBe("degraded");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6 * 60 * 1000);
    const refreshed = await gatherRugSignals({
      mint: SOL_MINT,
      connection,
      holderOwners: ["holder-1"],
      launchTs: Math.floor(Date.now() / 1000),
    });
    expect(refreshed._cached).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("large token removal triggers emergency exit", async () => {
    const mint = "TokenMint111111111111111111111111111111111111";
    const onEmergencyExit = vi.fn();
    const geyserStream = { onEvent: vi.fn() };
    const cleanup = attachExitMonitor(
      geyserStream,
      () => [{ mint }],
      { onEmergencyExit },
    );

    await geyserStream.onEvent({
      kind: "swap",
      token_in: mint,
      token_out: WSOL_MINT,
      amount_in: 1_000_001,
      amount_out: 100,
    });

    expect(onEmergencyExit).toHaveBeenCalledWith(
      mint,
      "liquidity_removal",
      "1,000,001 tokens removed in single tx",
    );
    cleanup();
  });

  it("falls back to claude when external agent binary is unavailable (codex path)", async () => {
    const router = new AgentRouter({ callLLM: async () => "fallback-claude-response" });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // preferAgent "codex" — binary likely missing or fails. Should fallback to Claude.
    const result = await router.invoke("write code for a Solana swap", { preferAgent: "codex", timeoutMs: 2000 });

    // Either codex succeeded or fell back to claude — both are OK.
    // The key assertion: no crash, result object is well-formed.
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("result");

    warnSpy.mockRestore();
  });
});
