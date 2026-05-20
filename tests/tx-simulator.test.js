import { describe, expect, it, vi } from "vitest";
import { simulatePreflight, classifySimulationError } from "../tools/tx-simulator.js";

describe("classifySimulationError", () => {
  it("proceeds on success (no err)", () => {
    const r = classifySimulationError({ err: null, logs: [] });
    expect(r.action).toBe("proceed");
  });
  it("blocks on insufficient funds", () => {
    const r = classifySimulationError({ err: "InsufficientFundsForRent", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("insufficient_balance");
  });
  it("blocks on slippage exceeded (Jupiter custom 6001)", () => {
    const r = classifySimulationError({ err: { InstructionError: [0, { Custom: 6001 }] }, logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("slippage_exceeded");
  });
  it("blocks on ExceededSlippage err string", () => {
    const r = classifySimulationError({ err: "ExceededSlippage", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("slippage_exceeded");
  });
  it("blocks on AccountNotFound (honeypot)", () => {
    const r = classifySimulationError({ err: "AccountNotFound", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("honeypot_account_missing");
  });
  it("blocks on InvalidAccountData in token program", () => {
    const r = classifySimulationError({ err: "InvalidAccountData", logs: ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke", "InvalidAccountData"] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("honeypot_invalid_account");
  });
  it("bump_cu on ComputeBudgetExceeded", () => {
    const r = classifySimulationError({ err: "ComputeBudgetExceeded", logs: [] });
    expect(r.action).toBe("bump_cu");
    expect(r.reason).toBe("needs_more_cu");
  });
  it("retry on stale blockhash", () => {
    const r = classifySimulationError({ err: "BlockhashNotFound", logs: [] });
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("stale_blockhash");
  });
  it("retry on sim timeout (network)", () => {
    const r = classifySimulationError({ err: "__timeout__", logs: [] });
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("sim_timeout");
  });
  it("blocks on unknown error (fail-closed)", () => {
    const r = classifySimulationError({ err: "WeirdMysteriousError", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("unknown_sim_error");
  });
});

describe("simulatePreflight integration", () => {
  it("returns proceed when sim succeeds", async () => {
    const rpcQuorum = { quorumCall: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }) };
    const res = await simulatePreflight({ tx: {}, rpcQuorum });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("proceed");
  });
});
