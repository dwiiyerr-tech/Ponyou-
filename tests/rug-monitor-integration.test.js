import { describe, expect, it, vi } from "vitest";
import { createRugMonitor, SEVERITY } from "../rug-monitor.js";

describe("rug-monitor integration", () => {
  const baseConfig = {
    enabled: true,
    pollingIntervalSec: 30,
    devSellThresholds: { low: -5, medium: -20, high: -50 },
    lpMovementThresholds: { low: -20, medium: -50, high: null },
    holderDumpThresholds: { low: -10, medium: -25, high: -50 },
    actions: { low: {}, medium: {}, high: {} },
  };

  function makeMeta(overrides = {}) {
    return {
      mint: "M",
      deployer_wallet: "D",
      deployer_token_account: "DTok",
      lp_address: "L",
      top_holders_snapshot: [
        { wallet: "H1", balance: 5_000_000 },
        { wallet: "H2", balance: 5_000_000 },
      ],
      authorities: { mint_authority: null, freeze_authority: null },
      deployer_balance_at_entry: 1_000_000,
      lp_usd_at_entry: 25_000,
      entry_ts: Date.now(),
      ...overrides,
    };
  }

  it("3 concurrent positions: signal on 1 does not affect others", () => {
    const handlers = new Map();
    const geyserStream = {
      subscribe: vi.fn((spec, h) => { handlers.set(spec.account, h); return spec.account; }),
      unsubscribe: vi.fn(),
    };
    const callbacks = { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() };
    const fetchers = {
      getTokenBalance: vi.fn(),
      getMintAccount: vi.fn(),
      getLargestAccounts: vi.fn(),
      getPoolLiquidityUsd: vi.fn(),
    };
    const rm = createRugMonitor({ geyserStream, config: baseConfig, callbacks, fetchers });

    rm.attachPosition("M1::W", makeMeta({ mint: "M1", deployer_token_account: "DTok1" }));
    rm.attachPosition("M2::W", makeMeta({ mint: "M2", deployer_token_account: "DTok2" }));
    rm.attachPosition("M3::W", makeMeta({ mint: "M3", deployer_token_account: "DTok3" }));

    handlers.get("DTok2")({ tokenBalance: 0 });

    expect(callbacks.onHigh).toHaveBeenCalledTimes(1);
    expect(callbacks.onHigh.mock.calls[0][0]).toBe("M2::W");
    rm.shutdown();
  });

  it("severity escalation: LOW then MEDIUM both emit, MEDIUM then LOW does not downgrade", () => {
    const handlers = new Map();
    const geyserStream = {
      subscribe: vi.fn((spec, h) => { handlers.set(spec.account, h); return spec.account; }),
      unsubscribe: vi.fn(),
    };
    const callbacks = { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() };
    const fetchers = {
      getTokenBalance: vi.fn(),
      getMintAccount: vi.fn(),
      getLargestAccounts: vi.fn(),
      getPoolLiquidityUsd: vi.fn(),
    };
    const rm = createRugMonitor({ geyserStream, config: baseConfig, callbacks, fetchers });
    rm.attachPosition("M::W", makeMeta());

    handlers.get("DTok")({ tokenBalance: 900_000 }); // -10% → LOW
    handlers.get("DTok")({ tokenBalance: 700_000 }); // -30% → MEDIUM
    handlers.get("DTok")({ tokenBalance: 850_000 }); // -15% → LOW; should not re-emit

    expect(callbacks.onLow).toHaveBeenCalledTimes(1);
    expect(callbacks.onMedium).toHaveBeenCalledTimes(1);
    expect(callbacks.onHigh).not.toHaveBeenCalled();
    rm.shutdown();
  });
});
