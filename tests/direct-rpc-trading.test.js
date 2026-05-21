import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DirectRpcTrading, createDirectRpcTrading } from "../tools/directRpcTrading.js";

// Mock child_process spawn at module level
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";

function makeSpawnMock(stdout, exitCode = 0) {
  return {
    stdout: {
      on: (event, cb) => { if (event === "data") cb(Buffer.from(stdout)); },
    },
    stderr: {
      on: (event, cb) => { if (event === "data") cb(Buffer.from("")); },
    },
    on: (event, cb) => { if (event === "close") cb(exitCode); },
  };
}

const VALID_PARAMS = {
  mint: "So11111111111111111111111111111111111111112",
  direction: "buy",
  amountSOL: 0.1,
  slippageBps: 100,
  balanceSOL: 2.0,
};

const SIM_OK = JSON.stringify({ success: true, err: null, logs: [], fee: 5000 });
const SIM_SLIPPAGE = JSON.stringify({ success: false, err: null, logs: ["Program log: Slippage exceeded"], fee: 0 });
const SIM_ERR = JSON.stringify({ success: false, err: { InstructionError: [0, "Custom(6000)"] }, logs: [] });

describe("DirectRpcTrading — dry run (default)", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: [] }) })); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  function makeTrader(overrides = {}) {
    return new DirectRpcTrading({
      rpcEndpoints: ["https://rpc.example.com"],
      dryRun: true,
      liveTradingEnabled: false,
      ...overrides,
    });
  }

  it("returns dryRun=true and success=true when sim passes", async () => {
    spawn.mockReturnValue(makeSpawnMock(SIM_OK));
    const t = makeTrader();
    const r = await t.trade(VALID_PARAMS);
    expect(r.success).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.txid).toBeNull();
    expect(r.reason).toBeNull();
  });

  it("does NOT call execute spawn when dryRun=true", async () => {
    spawn.mockReturnValue(makeSpawnMock(SIM_OK));
    const t = makeTrader();
    await t.trade(VALID_PARAMS);
    // spawn called once (simulate), never for execute
    const calls = spawn.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toContain("simulate");
    expect(calls[0][1]).not.toContain("execute");
  });

  it("blocks execute when liveTradingEnabled=false even if dryRun=false", async () => {
    spawn.mockReturnValue(makeSpawnMock(SIM_OK));
    const t = makeTrader({ dryRun: false, liveTradingEnabled: false });
    const r = await t.trade(VALID_PARAMS);
    expect(r.success).toBe(true);
    expect(r.dryRun).toBe(true); // forced dry
    const calls = spawn.mock.calls;
    expect(calls.every((c) => c[1].includes("simulate"))).toBe(true);
    expect(calls.some((c) => c[1].includes("execute"))).toBe(false);
  });

  it("aborts when simulation returns err field", async () => {
    spawn.mockReturnValue(makeSpawnMock(SIM_ERR));
    const t = makeTrader();
    const r = await t.trade(VALID_PARAMS);
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/simulation_failed/);
  });

  it("aborts when simulation logs contain slippage", async () => {
    spawn.mockReturnValue(makeSpawnMock(SIM_SLIPPAGE));
    const t = makeTrader();
    const r = await t.trade(VALID_PARAMS);
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/slippage/i);
  });

  it("returns rust_cli_not_built when binary missing", async () => {
    spawn.mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
    const t = makeTrader();
    const r = await t.trade(VALID_PARAMS);
    expect(r.success).toBe(false);
    expect(r.reason).toBe("rust_cli_not_built");
  });
});

describe("DirectRpcTrading — risk guard integration", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: [] }) })); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("blocks when balance below 1 SOL", async () => {
    const t = new DirectRpcTrading({ rpcEndpoints: ["https://rpc.example.com"], dryRun: true });
    const r = await t.trade({ ...VALID_PARAMS, balanceSOL: 0.5 });
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/risk_guard/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("blocks trade > 0.25 SOL", async () => {
    const t = new DirectRpcTrading({ rpcEndpoints: ["https://rpc.example.com"], dryRun: true });
    const r = await t.trade({ ...VALID_PARAMS, amountSOL: 0.5 });
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/risk_guard/);
  });
});

describe("DirectRpcTrading — circuit breaker", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("returns rpc_failover error when circuit is PAUSED", async () => {
    // All endpoints fail 3 times to trigger PAUSED
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const t = new DirectRpcTrading({ rpcEndpoints: ["https://rpc.example.com"], dryRun: true });
    await t._failover.checkHealth();
    await t._failover.checkHealth();
    await t._failover.checkHealth();
    const r = await t.trade(VALID_PARAMS);
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/rpc_failover/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("createDirectRpcTrading factory", () => {
  it("creates DirectRpcTrading instance", () => {
    const t = createDirectRpcTrading({ rpcEndpoints: ["https://rpc.example.com"] });
    expect(t).toBeInstanceOf(DirectRpcTrading);
    expect(t.dryRun).toBe(true);
    expect(t.liveEnabled).toBe(false);
  });
});
