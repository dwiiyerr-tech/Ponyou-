import { describe, expect, it } from "vitest";
import {
  AgentAction,
  analyzeThreeCandleConfirmation,
  CandleStrategyState,
} from "../tools/three-candle-confirmation-strategy.js";

const baseCandles = [
  { open: 100, high: 104, low: 98, close: 102, volume: 1000 },
  { open: 102, high: 103, low: 95, close: 97, volume: 1400 },
  { open: 97, high: 101, low: 96, close: 100, volume: 1700 },
];

const strongSignals = {
  buyPressurePercent: 64,
  volumeRatio: 1.5,
  greenReversal: true,
  higherLow: true,
  pricePumpPercent: 18,
};

describe("ThreeCandleConfirmationStrategy", () => {
  it("blocks FOMO entry on a sharp red candle", () => {
    const result = analyzeThreeCandleConfirmation({
      candles: [
        baseCandles[0],
        baseCandles[1],
        { open: 100, high: 101, low: 88, close: 90, volume: 3000 },
      ],
      pricePumpPercent: 10,
    });

    expect(result.action).toBe(AgentAction.BLOCK_ENTRY);
    expect(result.nextState).toBe(CandleStrategyState.WAITING_FIRST_DIP);
  });

  it("opens only a 10 percent mark position after first-dip bounce confirmation", () => {
    const result = analyzeThreeCandleConfirmation({
      state: CandleStrategyState.WAITING_FIRST_DIP,
      candles: baseCandles,
      bouncePercent: 4.2,
      basePositionSizeSol: 2,
      ...strongSignals,
    });

    expect(result.action).toBe(AgentAction.MARK_POSITION);
    expect(result.confirmationScore).toBeGreaterThanOrEqual(3);
    expect(result.positionSizing.suggestedSizeSol).toBe(0.2);
  });

  it("waits when first-dip bounce lacks confirmation", () => {
    const result = analyzeThreeCandleConfirmation({
      state: CandleStrategyState.WAITING_FIRST_DIP,
      candles: baseCandles,
      bouncePercent: 1.5,
      buyPressurePercent: 45,
      volumeRatio: 0.8,
      pricePumpPercent: 12,
    });

    expect(result.action).toBe(AgentAction.WAIT);
    expect(result.nextState).toBe(CandleStrategyState.WAITING_BOUNCE);
  });

  it("allows full entry only on second-dip confirmation", () => {
    const result = analyzeThreeCandleConfirmation({
      state: CandleStrategyState.MARK_POSITION_OPEN,
      candles: baseCandles,
      secondDipPercent: -5.5,
      basePositionSizeSol: 1,
      ...strongSignals,
    });

    expect(result.action).toBe(AgentAction.FULL_ENTRY);
    expect(result.nextState).toBe(CandleStrategyState.FULL_ENTRY_READY);
    expect(result.positionSizing.suggestedSizeSol).toBe(0.9);
  });

  it("holds mark when second dip is present but weak", () => {
    const result = analyzeThreeCandleConfirmation({
      state: CandleStrategyState.MARK_POSITION_OPEN,
      candles: baseCandles,
      secondDipPercent: -6,
      buyPressurePercent: 40,
      volumeRatio: 0.9,
      greenReversal: false,
      higherLow: false,
      pricePumpPercent: 20,
    });

    expect(result.action).toBe(AgentAction.HOLD_MARK);
    expect(result.confirmationScore).toBeLessThan(3);
  });

  it("resets invalidated mark setups", () => {
    const result = analyzeThreeCandleConfirmation({
      state: CandleStrategyState.MARK_POSITION_OPEN,
      candles: baseCandles,
      drawdownFromMarkPercent: -14,
      ...strongSignals,
    });

    expect(result.action).toBe(AgentAction.RESET);
    expect(result.nextState).toBe(CandleStrategyState.INVALIDATED);
  });

  it("waits when fewer than three candles are available", () => {
    const result = analyzeThreeCandleConfirmation({
      candles: [baseCandles[0], baseCandles[1]],
      ...strongSignals,
    });

    expect(result.action).toBe(AgentAction.WAIT);
    expect(result.confirmationScore).toBeGreaterThanOrEqual(0);
  });
});
