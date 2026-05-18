import { describe, it, expect } from "vitest";
import { shouldFastBuy } from "../fast-buy.js";

const goodToken = {
  mint: "AAAAA",
  symbol: "GOOD",
  rug_score: 5,
  mcap: 500_000,
  volume: 100_000,
  flags: [],
};

describe("shouldFastBuy — gate logic", () => {
  it("returns ok=false when fast-track disabled", () => {
    const r = shouldFastBuy(goodToken, { enabled: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });

  it("returns ok=true for clean token when enabled", () => {
    const r = shouldFastBuy(goodToken, { enabled: true });
    expect(r.ok).toBe(true);
  });

  it("rejects high rug score", () => {
    const r = shouldFastBuy({ ...goodToken, rug_score: 50 }, { enabled: true, maxRugScore: 20 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rug_score/);
  });

  it("rejects low mcap", () => {
    const r = shouldFastBuy({ ...goodToken, mcap: 50_000 }, { enabled: true, minMcap: 150_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mcap.*<.*150000/);
  });

  it("rejects high mcap", () => {
    const r = shouldFastBuy({ ...goodToken, mcap: 50_000_000 }, { enabled: true, maxMcap: 5_000_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mcap.*>.*5000000/);
  });

  it("rejects low volume", () => {
    const r = shouldFastBuy({ ...goodToken, volume: 1000 }, { enabled: true, minVolumeUsd: 50_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/volume/);
  });

  it("rejects too-old token when maxAgeMinutes set", () => {
    const r = shouldFastBuy(
      { ...goodToken, age_minutes: 100 },
      { enabled: true, maxAgeMinutes: 30 }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/age/);
  });

  it("skips age check when maxAgeMinutes=null", () => {
    const r = shouldFastBuy(
      { ...goodToken, age_minutes: 10000 },
      { enabled: true, maxAgeMinutes: null }
    );
    expect(r.ok).toBe(true);
  });

  it("rejects any flags > maxFlags", () => {
    const r = shouldFastBuy(
      { ...goodToken, flags: ["something bad"] },
      { enabled: true, maxFlags: 0 }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/flags/);
  });

  it("rejects weak smart inflow when minSmartInflowUsd > 0", () => {
    const r = shouldFastBuy(
      { ...goodToken, smart_inflow_usd: 100 },
      { enabled: true, minSmartInflowUsd: 5000 }
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/smart_inflow/);
  });

  it("ignores missing token gracefully", () => {
    expect(shouldFastBuy(null, { enabled: true }).ok).toBe(false);
    expect(shouldFastBuy({}, { enabled: true }).ok).toBe(false);
  });
});
