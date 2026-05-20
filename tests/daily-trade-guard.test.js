import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetDailyTradeGuardForTests,
  decideDailyTradeGuard,
  getDailyTradeGuardStatus,
  isDailyTradeGuardEntryBlocked,
  recordDailyTradeOutcome,
} from "../daily-trade-guard.js";

const enabled = {
  enabled: true,
  maxWinsPerDay: 3,
  maxLossesPerDay: 3,
  learningModeDurationMin: 60,
};

beforeEach(() => {
  _resetDailyTradeGuardForTests();
});

afterEach(() => {
  _resetDailyTradeGuardForTests();
});

describe("daily trade guard", () => {
  it("stays inert when disabled", () => {
    const result = recordDailyTradeOutcome(false, {}, { ...enabled, enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.triggered).toBe(false);
    expect(isDailyTradeGuardEntryBlocked({ ...enabled, enabled: false }).blocked).toBe(false);
  });

  it("opens a Telegram decision gate when the daily loss limit is hit", () => {
    expect(recordDailyTradeOutcome(false, { symbol: "A" }, enabled).triggered).toBe(false);
    expect(recordDailyTradeOutcome(false, { symbol: "B" }, enabled).triggered).toBe(false);
    const third = recordDailyTradeOutcome(false, { symbol: "C", pnl_pct: -12 }, enabled);

    expect(third.triggered).toBe(true);
    expect(third.status).toBe("pending_decision");
    expect(third.pending_decision.threshold).toBe("loss");

    const gate = isDailyTradeGuardEntryBlocked(enabled);
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toContain("DAILY_TRADE_GUARD");
  });

  it("continue acknowledges the hit for the rest of that day", () => {
    recordDailyTradeOutcome(true, {}, enabled);
    recordDailyTradeOutcome(true, {}, enabled);
    recordDailyTradeOutcome(true, {}, enabled);

    const continued = decideDailyTradeGuard("continue", enabled);
    expect(continued.status).toBe("continued");
    expect(isDailyTradeGuardEntryBlocked(enabled).blocked).toBe(false);

    const fourth = recordDailyTradeOutcome(true, {}, enabled);
    expect(fourth.triggered).toBe(false);
    expect(fourth.wins).toBe(4);
  });

  it("stop blocks entries until reset or the next day", () => {
    recordDailyTradeOutcome(false, {}, enabled);
    recordDailyTradeOutcome(false, {}, enabled);
    recordDailyTradeOutcome(false, {}, enabled);

    const stopped = decideDailyTradeGuard("stop", enabled);
    expect(stopped.status).toBe("stopped");
    expect(isDailyTradeGuardEntryBlocked(enabled).blocked).toBe(true);

    const reset = decideDailyTradeGuard("reset", enabled);
    expect(reset.status).toBe("running");
    expect(getDailyTradeGuardStatus(enabled).losses).toBe(0);
  });
});
