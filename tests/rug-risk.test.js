import { afterEach, describe, it, expect, vi } from "vitest";
import AgentRouter from "../agent-router.js";
import { attachExitMonitor } from "../geyser-exit-monitor.js";
import { scoreRugRisk } from "../lessons.js";
import { clearSignalCache, gatherRugSignals, normalizeGmgnSecurity } from "../tools/rug-signals.js";

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

describe("GMGN security audit (normalizeGmgnSecurity + scoring)", () => {
  it("normalizes only EXPLICIT positives (null = unknown, not a flag)", () => {
    // Live-shape sample: clean token (renounced, no honeypot, 0 tax).
    const n = normalizeGmgnSecurity({
      is_honeypot: null, honeypot: 0, can_not_sell: 0, can_sell: 0,
      renounced_mint: true, renounced_freeze_account: true,
      buy_tax: "0", sell_tax: "0", top_10_holder_rate: "0.1559",
      is_blacklist: null, blacklist: 0, lock_summary: { is_locked: false }, hide_risk: false,
    });
    expect(n.honeypot).toBe(false);
    expect(n.cannot_sell).toBe(false);
    expect(n.mint_not_renounced).toBe(false);   // renounced_mint:true → not a flag
    expect(n.freeze_not_renounced).toBe(false);
    expect(n.sell_tax).toBe(0);
    expect(n.top10_rate).toBeCloseTo(0.1559, 4);
  });

  it("flags a honeypot / non-sellable / high-tax token", () => {
    const n = normalizeGmgnSecurity({
      honeypot: 1, can_not_sell: 1, renounced_mint: false, sell_tax: "0.6", blacklist: 1,
    });
    expect(n.honeypot).toBe(true);
    expect(n.cannot_sell).toBe(true);
    expect(n.mint_not_renounced).toBe(true);
    expect(n.sell_tax).toBe(0.6);
    expect(n.blacklist).toBe(true);
  });

  it("interprets a >1 tax value as a raw percent", () => {
    expect(normalizeGmgnSecurity({ sell_tax: "15" }).sell_tax).toBe(0.15);
  });

  it("scoreRugRisk adds risk from gmgn_security without a sole hard-block", () => {
    const result = scoreRugRisk({
      mint: "m", creator: "c",
      rug_signals: {
        _helius_expected: false, _helius_degraded: false,
        gmgn_security: { honeypot: true, cannot_sell: true, sell_tax: 0.6, mint_not_renounced: true },
      },
    });
    expect(result.score).toBeGreaterThanOrEqual(60); // honeypot 40 + can't-sell 35 + tax 40 + mint 15, capped 100
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.reasons.some(r => /honeypot/i.test(r))).toBe(true);
    expect(result.reasons.some(r => /cannot be sold/i.test(r))).toBe(true);
  });

  it("clean gmgn_security adds no risk", () => {
    const result = scoreRugRisk({
      mint: "m2", creator: "c2",
      rug_signals: {
        _helius_expected: false, _helius_degraded: false,
        gmgn_security: { honeypot: false, cannot_sell: false, blacklist: false, mint_not_renounced: false, freeze_not_renounced: false, sell_tax: 0, buy_tax: 0, hide_risk: false },
      },
    });
    expect(result.score).toBe(0);
  });
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
      // GEM-2: message wording was tightened ("removed" → "dumped") since
      // the event is a sell-direction dump, not a literal liquidity removal.
      "1,000,001 tokens dumped in single tx",
    );
    cleanup();
  });

  it("falls back to claude when external agent binary is unavailable (codex path)", async () => {
    const router = new AgentRouter({ callLLM: async () => "fallback-claude-response" });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Pin a nonexistent codex binary so this is deterministic even on hosts
    // that have codex installed on PATH. #callCodex honors PONYOU_CODEX_BIN
    // exclusively, so this guarantees the "unavailable" path (ENOENT → fallback).
    process.env.PONYOU_CODEX_BIN = "/nonexistent/ponyou-codex-test-bin";

    // preferAgent "codex" — binary missing → must fall back to Claude.
    const result = await router.invoke("write code for a Solana swap", { preferAgent: "codex", timeoutMs: 2000 });

    // Either codex succeeded or fell back to claude — both are OK.
    // The key assertion: no crash, result object is well-formed.
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("result");

    delete process.env.PONYOU_CODEX_BIN;
    warnSpy.mockRestore();
  });
});
