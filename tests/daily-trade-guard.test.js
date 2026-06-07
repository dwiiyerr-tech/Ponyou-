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
  it("stays inert when disabled", async () => {
    const result = await recordDailyTradeOutcome(false, {}, { ...enabled, enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.triggered).toBe(false);
    expect(isDailyTradeGuardEntryBlocked({ ...enabled, enabled: false }).blocked).toBe(false);
  });

  it("opens a Telegram decision gate when the daily loss limit is hit", async () => {
    expect((await recordDailyTradeOutcome(false, { symbol: "A" }, enabled)).triggered).toBe(false);
    expect((await recordDailyTradeOutcome(false, { symbol: "B" }, enabled)).triggered).toBe(false);
    const third = await recordDailyTradeOutcome(false, { symbol: "C", pnl_pct: -12 }, enabled);

    expect(third.triggered).toBe(true);
    expect(third.status).toBe("pending_decision");
    expect(third.pending_decision.threshold).toBe("loss");

    const gate = isDailyTradeGuardEntryBlocked(enabled);
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toContain("DAILY_TRADE_GUARD");
  });

  it("continue acknowledges the hit for the rest of that day", async () => {
    await recordDailyTradeOutcome(true, {}, enabled);
    await recordDailyTradeOutcome(true, {}, enabled);
    await recordDailyTradeOutcome(true, {}, enabled);

    const continued = await decideDailyTradeGuard("continue", enabled);
    expect(continued.status).toBe("continued");
    expect(isDailyTradeGuardEntryBlocked(enabled).blocked).toBe(false);

    const fourth = await recordDailyTradeOutcome(true, {}, enabled);
    expect(fourth.triggered).toBe(false);
    expect(fourth.wins).toBe(4);
  });

  it("stop blocks entries until reset or the next day", async () => {
    await recordDailyTradeOutcome(false, {}, enabled);
    await recordDailyTradeOutcome(false, {}, enabled);
    await recordDailyTradeOutcome(false, {}, enabled);

    const stopped = await decideDailyTradeGuard("stop", enabled);
    expect(stopped.status).toBe("stopped");
    expect(isDailyTradeGuardEntryBlocked(enabled).blocked).toBe(true);

    const reset = await decideDailyTradeGuard("reset", enabled);
    expect(reset.status).toBe("running");
    expect(getDailyTradeGuardStatus(enabled).losses).toBe(0);
  });
});
