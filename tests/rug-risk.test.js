import { afterEach, describe, it, expect, vi } from "vitest";
import AgentRouter from "../agent-router.js";
import { attachExitMonitor } from "../geyser-exit-monitor.js";
import { scoreRugRisk } from "../lessons.js";
import { clearSignalCache, gatherRugSignals, normalizeGmgnSecurity } from "../tools/rug-signals.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const ORIGINAL_GMGN_API_KEY = process.env.GMGN_API_KEY;

afterEach(() => {
  clearSignalCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.HELIUS_API_KEY;
  delete process.env.HELIUS_API_ENABLED;
  delete process.env.HELIUS_FALLBACK;
  delete process.env.SHYFT_API_KEY;
  if (ORIGINAL_GMGN_API_KEY == null) delete process.env.GMGN_API_KEY;
  else process.env.GMGN_API_KEY = ORIGINAL_GMGN_API_KEY;
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

describe("scoreRugRisk Layer 2d: GMGN row risk (rank/trenches pre-computed fields)", () => {
  const base = { mint: "m", creator: "c", rug_signals: { _helius_expected: false, _helius_degraded: false } };

  it("no gmgn_row_risk → no additional score", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: null } });
    expect(r.score).toBe(0);
  });

  it("is_honeypot=true adds 40 points", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { is_honeypot: true } } });
    expect(r.score).toBe(40);
    expect(r.reasons.some(s => /honeypot/i.test(s))).toBe(true);
  });

  it("rug_ratio=0.9 adds 30 points (high confidence)", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { rug_ratio: 0.9 } } });
    expect(r.score).toBe(30);
    expect(r.reasons.some(s => /rug_ratio.*90%/i.test(s))).toBe(true);
  });

  it("rug_ratio=0.6 adds 15 points (medium)", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { rug_ratio: 0.6 } } });
    expect(r.score).toBe(15);
  });

  it("rug_ratio=0.4 adds 8 points (caution)", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { rug_ratio: 0.4 } } });
    expect(r.score).toBe(8);
  });

  it("rug_ratio=0.2 adds no points (below threshold)", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { rug_ratio: 0.2 } } });
    expect(r.score).toBe(0);
  });

  it("bundler_rate=0.6 adds bundle_buy-multiplied score", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { bundler_rate: 0.6 } } });
    expect(r.score).toBeGreaterThanOrEqual(10); // M("bundle_buy", 20) ≥ 10
    expect(r.reasons.some(s => /bundled/i.test(s))).toBe(true);
  });

  it("top70_sniper_hold_rate=0.7 adds 15 points", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { top70_sniper_hold_rate: 0.7 } } });
    expect(r.score).toBe(15);
    expect(r.reasons.some(s => /sniper/i.test(s))).toBe(true);
  });

  it("fresh_wallet_rate=0.8 adds 10 points", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { fresh_wallet_rate: 0.8 } } });
    expect(r.score).toBe(10);
  });

  it("renounced_mint=false adds non-zero score", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: { renounced_mint: false } } });
    expect(r.score).toBeGreaterThan(0); // tier-multiplied M("hidden_control", 8)
    expect(r.reasons.some(s => /mint not renounced/i.test(s))).toBe(true);
  });

  it("clean row risk (all safe values) adds no points", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: {
      rug_ratio: 0.05, bundler_rate: 0.1, top70_sniper_hold_rate: 0.1,
      fresh_wallet_rate: 0.2, rat_trader_amount_rate: 0.1,
      is_honeypot: false, renounced_mint: true, renounced_freeze_account: true,
    } } });
    expect(r.score).toBe(0);
  });

  it("combined: honeypot + high rug_ratio → score >= 60 (HIGH)", () => {
    const r = scoreRugRisk({ ...base, rug_signals: { ...base.rug_signals, gmgn_row_risk: {
      is_honeypot: true, rug_ratio: 0.9,
    } } });
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.risk_level).toBe("HIGH");
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

  it("hard-blocks when critical GMGN rug telemetry is unavailable", () => {
    const result = scoreRugRisk({
      mint: "mint-critical-telemetry",
      creator: "creator-critical-telemetry",
      rug_signals: {
        _critical_rug_telemetry_expected: true,
        _critical_rug_telemetry_degraded: true,
        _critical_rug_telemetry_reason: "GMGN rug telemetry unavailable and Helius fallback disabled",
      },
    });

    expect(result.score).toBe(100);
    expect(result.reasons[0]).toContain("Critical rug telemetry unavailable");
    expect(result.no_autoblacklist).toBe(true);
    expect(result.telemetry_block).toBe(true);
    expect(result.reasons[0]).toContain("GMGN rug telemetry unavailable");
  });

  it("marks GMGN-only rug telemetry as degraded when GMGN throws (auth/network failure)", async () => {
    // Distinguish ERROR (throw) from EMPTY (token not indexed).
    // Only a real failure triggers the critical block — an empty response means the
    // token is too fresh for GMGN's index, which is normal and should fall through
    // to dexscreener-only scoring instead of blocking the token entirely.
    process.env.GMGN_API_KEY = "test-gmgn-key";
    process.env.HELIUS_API_ENABLED = "false";
    process.env.HELIUS_FALLBACK = "false";

    // Simulate GMGN network/auth failure: fetch throws
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/token_top_holders")) throw new Error("401 Unauthorized");
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const connection = {
      getParsedAccountInfo: vi.fn(async () => ({
        value: { owner: { toString: () => "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } },
      })),
    };

    const signals = await gatherRugSignals({
      mint: "GmgnGap11111111111111111111111111111111111",
      connection,
      holderOwners: ["holder-1"],
      launchTs: Math.floor(Date.now() / 1000),
    });

    expect(signals._gmgn_used).toBe(false);
    expect(signals._critical_rug_telemetry_expected).toBe(true);
    expect(signals._critical_rug_telemetry_degraded).toBe(true);

    const result = scoreRugRisk({
      mint: "GmgnGap11111111111111111111111111111111111",
      creator: "creator",
      rug_signals: signals,
    });
    expect(result.score).toBe(100);
    expect(result.reasons[0]).toContain("Critical rug telemetry unavailable");
  });

  it("GMGN empty response (token not indexed) falls through to dexscreener-only, no block", async () => {
    // When GMGN returns empty holders (token not in index — common for fresh/micro-cap mints),
    // the bot should continue with dexscreener-only scoring, not block with score 100.
    process.env.GMGN_API_KEY = "test-gmgn-key";
    process.env.HELIUS_API_ENABLED = "false";
    process.env.HELIUS_FALLBACK = "false";

    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [] }), // empty — token not indexed
    }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = {
      getParsedAccountInfo: vi.fn(async () => ({
        value: { owner: { toString: () => "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } },
      })),
    };

    const signals = await gatherRugSignals({
      mint: "GmgnNotIndexed1111111111111111111111111111",
      connection,
      holderOwners: ["holder-1"],
      launchTs: Math.floor(Date.now() / 1000),
    });

    // Not degraded — just not indexed
    expect(signals._gmgn_used).toBe(false);
    expect(signals._critical_rug_telemetry_degraded).toBe(false);

    const result = scoreRugRisk({
      mint: "GmgnNotIndexed1111111111111111111111111111",
      creator: "creator",
      rug_signals: signals,
    });
    // Should score below 100 — falls through to pattern-based dexscreener scoring
    expect(result.score).toBeLessThan(100);
  });

  it("EVM chain (base): skips Solana-RPC (Token-2022/Helius), uses GMGN, no connection calls", async () => {
    // Phase 2 multi-chain: for non-sol chains, gatherRugSignals must NOT touch
    // the Solana connection (Token-2022 mint extensions) or Helius — those are
    // Solana-only. GMGN security/holders drive the EVM rug signal instead.
    process.env.GMGN_API_KEY = "test-gmgn-key";
    process.env.HELIUS_API_KEY = "real-helius-key";
    process.env.HELIUS_API_ENABLED = "true";

    // GMGN returns holder tags for the EVM token.
    const fetchMock = vi.fn(async (url) => ({
      ok: true, status: 200,
      json: async () => String(url).includes("/token_top_holders")
        ? { data: [{ address: "0xabc", balance: "100", tags: ["bundler"] }] }
        : { data: {} },
    }));
    vi.stubGlobal("fetch", fetchMock);

    // A connection mock that THROWS if called — proves EVM path never touches Solana RPC.
    const connection = {
      getParsedAccountInfo: vi.fn(() => { throw new Error("Solana RPC must not be called for EVM"); }),
    };

    const signals = await gatherRugSignals({
      mint: "0xEvmTokenAddress00000000000000000000000000",
      connection,
      holderOwners: ["0xholder"],
      launchTs: Math.floor(Date.now() / 1000),
      chain: "base",
    });

    expect(signals.chain).toBe("base");
    expect(connection.getParsedAccountInfo).not.toHaveBeenCalled();
    // The GMGN request must carry chain=base.
    const gmgnCalls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(gmgnCalls.some(u => u.includes("chain=base"))).toBe(true);
    expect(gmgnCalls.some(u => u.includes("chain=sol"))).toBe(false);
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
    process.env.HELIUS_API_ENABLED = "true";
    process.env.HELIUS_FALLBACK = "true";
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
