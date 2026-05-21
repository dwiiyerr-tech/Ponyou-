import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PriorityFeeManager, PriorityFeeMode, createPriorityFeeManager } from "../tools/priorityFeeManager.js";

describe("PriorityFeeManager", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockFees(fees) {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: fees.map((f) => ({ prioritizationFee: f, slot: 1 })) }),
    });
  }

  it("returns p25 for LOW mode", async () => {
    // 100 fees: 1..100 → p25 = index 24 = 25
    mockFees(Array.from({ length: 100 }, (_, i) => i + 1));
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    const fee = await mgr.getFee(PriorityFeeMode.LOW);
    expect(fee).toBe(25);
  });

  it("returns p50 for MEDIUM mode", async () => {
    mockFees(Array.from({ length: 100 }, (_, i) => i + 1));
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    const fee = await mgr.getFee(PriorityFeeMode.MEDIUM);
    expect(fee).toBe(50);
  });

  it("returns p75 for HIGH mode", async () => {
    mockFees(Array.from({ length: 100 }, (_, i) => i + 1));
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    const fee = await mgr.getFee(PriorityFeeMode.HIGH);
    expect(fee).toBe(75);
  });

  it("uses p90 for AUTO when network is congested (p90 > p50 * 3)", async () => {
    // 80 low fees + 20 high fees: sorted[80..99]=10000, p90=index89=10000, p50=index49=100
    const fees = [...Array(80).fill(100), ...Array(20).fill(10_000)];
    mockFees(fees);
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    const fee = await mgr.getFee(PriorityFeeMode.AUTO);
    // p90 index = floor(0.9 * 99) = 89 → fees[89] = 10000
    // 10000 > 100 * 3 = 300 → congested → use p90
    expect(fee).toBe(10_000);
  });

  it("uses p50 for AUTO when network is not congested", async () => {
    // Uniform fees
    mockFees(Array.from({ length: 100 }, (_, i) => i + 1));
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    const fee = await mgr.getFee(PriorityFeeMode.AUTO);
    // p90=90, p50=50, 90 > 50*3=150? No → use p50
    expect(fee).toBe(50);
  });

  it("returns fallback values when RPC fails", async () => {
    fetch.mockRejectedValue(new Error("network error"));
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    expect(await mgr.getFee(PriorityFeeMode.LOW)).toBe(1_000);
    expect(await mgr.getFee(PriorityFeeMode.MEDIUM)).toBe(5_000);
    expect(await mgr.getFee(PriorityFeeMode.HIGH)).toBe(25_000);
    expect(await mgr.getFee(PriorityFeeMode.AUTO)).toBe(10_000);
  });

  it("returns fallback when RPC returns empty array", async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ result: [] }) });
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    expect(await mgr.getFee(PriorityFeeMode.MEDIUM)).toBe(5_000);
  });

  it("throws on unknown mode", async () => {
    const mgr = new PriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    await expect(mgr.getFee("TURBO")).rejects.toThrow(/Unknown fee mode/);
  });

  it("createPriorityFeeManager factory works", async () => {
    fetch.mockRejectedValue(new Error("offline"));
    const mgr = createPriorityFeeManager({ rpcUrl: "https://rpc.example.com" });
    expect(await mgr.getFee("LOW")).toBe(1_000);
  });
});
