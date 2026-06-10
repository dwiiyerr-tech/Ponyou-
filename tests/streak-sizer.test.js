import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordStreakOutcome,
  getStreakMultiplier,
  getStreakStatus,
  resetStreak,
  STREAK_DEFAULTS,
  _resetStreakForTests,
} from "../streak-sizer.js";

beforeEach(() => {
  _resetStreakForTests();
});

const CFG = {
  lossScaleDown:  0.20,
  winScaleUp:     0.10,
  minMultiplier:  0.25,
  maxMultiplier:  1.50,
};

// ─── STREAK_DEFAULTS ──────────────────────────────────────────────────────────

describe("STREAK_DEFAULTS", () => {
  it("exports correct defaults", () => {
    expect(STREAK_DEFAULTS.lossScaleDown).toBe(0.20);
    expect(STREAK_DEFAULTS.winScaleUp).toBe(0.10);
    expect(STREAK_DEFAULTS.minMultiplier).toBe(0.25);
    expect(STREAK_DEFAULTS.maxMultiplier).toBe(1.50);
  });
});

// ─── initial state ────────────────────────────────────────────────────────────

describe("initial state", () => {
  it("multiplier starts at 1.0", () => {
    expect(getStreakMultiplier(CFG)).toBe(1.0);
  });

  it("status shows zero streaks initially", () => {
    const s = getStreakStatus(CFG);
    expect(s.multiplier).toBe(1.0);
    expect(s.win_streak).toBe(0);
    expect(s.loss_streak).toBe(0);
    expect(s.total_wins).toBe(0);
    expect(s.total_losses).toBe(0);
    expect(s.at_floor).toBe(false);
    expect(s.at_ceiling).toBe(false);
  });
});

// ─── win streak ───────────────────────────────────────────────────────────────

describe("win streak — multiplier grows by 10% per win", () => {
  it("after 1 win: 1.0 × 1.10 = 1.1000", () => {
    recordStreakOutcome(true, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(1.1, 3);
  });

  it("after 2 consecutive wins: 1.0 × 1.10 × 1.10 = 1.2100", () => {
    recordStreakOutcome(true, CFG);
    recordStreakOutcome(true, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(1.21, 2);
  });

  it("caps at maxMultiplier (1.50)", () => {
    for (let i = 0; i < 20; i++) recordStreakOutcome(true, CFG);
    expect(getStreakMultiplier(CFG)).toBe(CFG.maxMultiplier);
    const s = getStreakStatus(CFG);
    expect(s.at_ceiling).toBe(true);
  });

  it("win increments win_streak and resets loss_streak", () => {
    recordStreakOutcome(false, CFG); // loss first
    recordStreakOutcome(true, CFG);
    const s = getStreakStatus(CFG);
    expect(s.win_streak).toBe(1);
    expect(s.loss_streak).toBe(0);
  });

  it("counts total wins independently of streak", () => {
    recordStreakOutcome(true, CFG);
    recordStreakOutcome(false, CFG);
    recordStreakOutcome(true, CFG);
    const s = getStreakStatus(CFG);
    expect(s.total_wins).toBe(2);
    expect(s.total_losses).toBe(1);
  });
});

// ─── loss streak ─────────────────────────────────────────────────────────────

describe("loss streak — multiplier drops by 20% per loss", () => {
  it("after 1 loss: 1.0 × 0.80 = 0.8000", () => {
    recordStreakOutcome(false, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(0.8, 3);
  });

  it("after 2 consecutive losses: 1.0 × 0.80 × 0.80 = 0.6400", () => {
    recordStreakOutcome(false, CFG);
    recordStreakOutcome(false, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(0.64, 2);
  });

  it("after 3 consecutive losses: ≈ 0.512", () => {
    recordStreakOutcome(false, CFG);
    recordStreakOutcome(false, CFG);
    recordStreakOutcome(false, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(0.512, 2);
  });

  it("floors at minMultiplier (0.25)", () => {
    for (let i = 0; i < 20; i++) recordStreakOutcome(false, CFG);
    expect(getStreakMultiplier(CFG)).toBe(CFG.minMultiplier);
    const s = getStreakStatus(CFG);
    expect(s.at_floor).toBe(true);
  });

  it("loss increments loss_streak and resets win_streak", () => {
    recordStreakOutcome(true, CFG);  // win first
    recordStreakOutcome(false, CFG);
    const s = getStreakStatus(CFG);
    expect(s.loss_streak).toBe(1);
    expect(s.win_streak).toBe(0);
  });
});

// ─── recordStreakOutcome return value ─────────────────────────────────────────

describe("recordStreakOutcome return value", () => {
  it("returns multiplier and positive delta on win", () => {
    const r = recordStreakOutcome(true, CFG);
    expect(r.multiplier).toBeCloseTo(1.1, 3);
    expect(r.delta).toBeGreaterThan(0);
    expect(r.winStreak).toBe(1);
    expect(r.lossStreak).toBe(0);
  });

  it("returns multiplier and negative delta on loss", () => {
    const r = recordStreakOutcome(false, CFG);
    expect(r.multiplier).toBeCloseTo(0.8, 3);
    expect(r.delta).toBeLessThan(0);
    expect(r.lossStreak).toBe(1);
    expect(r.winStreak).toBe(0);
  });
});

// ─── alternating win/loss ─────────────────────────────────────────────────────

describe("alternating win/loss — multiplier oscillates", () => {
  it("loss then win: 1.0 × 0.80 × 1.10 = 0.88", () => {
    recordStreakOutcome(false, CFG);
    recordStreakOutcome(true, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(0.88, 2);
  });

  it("win then loss: 1.0 × 1.10 × 0.80 = 0.88", () => {
    recordStreakOutcome(true, CFG);
    recordStreakOutcome(false, CFG);
    expect(getStreakMultiplier(CFG)).toBeCloseTo(0.88, 2);
  });

  it("streaks reset each time direction changes", () => {
    recordStreakOutcome(true, CFG);
    recordStreakOutcome(true, CFG);
    recordStreakOutcome(false, CFG);
    const s = getStreakStatus(CFG);
    expect(s.win_streak).toBe(0);
    expect(s.loss_streak).toBe(1);
  });
});

// ─── custom config overrides ──────────────────────────────────────────────────

describe("custom config overrides", () => {
  it("respects custom lossScaleDown", () => {
    recordStreakOutcome(false, { ...CFG, lossScaleDown: 0.10 });
    expect(getStreakMultiplier(CFG)).toBeCloseTo(0.90, 2);
  });

  it("respects custom winScaleUp", () => {
    recordStreakOutcome(true, { ...CFG, winScaleUp: 0.20 });
    expect(getStreakMultiplier(CFG)).toBeCloseTo(1.20, 2);
  });

  it("getStreakMultiplier clamps to cfg bounds on read", () => {
    // write state at 1.50
    for (let i = 0; i < 10; i++) recordStreakOutcome(true, CFG);
    // now read with a tighter max
    const clamped = getStreakMultiplier({ ...CFG, maxMultiplier: 1.20 });
    expect(clamped).toBe(1.20);
  });
});

// ─── persistence ──────────────────────────────────────────────────────────────

describe("persistence — state is written to disk", () => {
  it("multiplier is persisted to the state file after recording", () => {
    recordStreakOutcome(true, CFG);
    recordStreakOutcome(true, CFG);
    const expected = getStreakMultiplier(CFG);

    const stateFile = process.env.PONYOU_STREAK_SIZER_STATE ||
      path.join(process.cwd(), "streak-sizer-state.json");
    expect(fs.existsSync(stateFile)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(onDisk.multiplier).toBeCloseTo(expected, 3);
    expect(onDisk.totalWins).toBe(2);
    expect(onDisk.winStreak).toBe(2);
  });

  it("reset writes 1.0 to disk", () => {
    recordStreakOutcome(false, CFG);
    resetStreak();
    const stateFile = process.env.PONYOU_STREAK_SIZER_STATE ||
      path.join(process.cwd(), "streak-sizer-state.json");
    const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(onDisk.multiplier).toBe(1.0);
  });
});

// ─── resetStreak ──────────────────────────────────────────────────────────────

describe("resetStreak", () => {
  it("resets multiplier to 1.0 and clears streaks", () => {
    recordStreakOutcome(false, CFG);
    recordStreakOutcome(false, CFG);
    resetStreak();
    const s = getStreakStatus(CFG);
    expect(s.multiplier).toBe(1.0);
    expect(s.win_streak).toBe(0);
    expect(s.loss_streak).toBe(0);
    expect(s.total_wins).toBe(0);
    expect(s.total_losses).toBe(0);
  });

  it("multiplier is 1.0 after reset even if many losses occurred", () => {
    for (let i = 0; i < 10; i++) recordStreakOutcome(false, CFG);
    resetStreak();
    expect(getStreakMultiplier(CFG)).toBe(1.0);
  });
});
