import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_FILE = path.join(__dirname, "..", "dev-reputation.json");

let backup = null;

beforeEach(() => {
  // Preserve any real dev-reputation.json so the test never clobbers live state.
  backup = fs.existsSync(DEV_FILE) ? fs.readFileSync(DEV_FILE, "utf8") : null;
});

afterEach(() => {
  if (backup === null) {
    try { fs.unlinkSync(DEV_FILE); } catch (_) {}
  } else {
    fs.writeFileSync(DEV_FILE, backup);
  }
});

// BUG 3 regression: totalLaunches used `dev.coins_launched || 1`, which fell
// back to 1 whenever the counter was 0 — even if dev.launches held real launch
// records. That inflated successRate (badCount / 1 instead of badCount / N).
// The fix uses `dev.coins_launched || dev.launches?.length || 1` so the array
// length is honored, while still guarding the undefined-launches crash case.
describe("community-detector — totalLaunches fallback (BUG 3)", () => {
  it("uses dev.launches.length when coins_launched is 0", async () => {
    const wallet = "BugThreeDevWallet";
    // coins_launched=0 but 3 launch records present, with 1 prior rug already.
    fs.writeFileSync(DEV_FILE, JSON.stringify({
      devs: {
        [wallet]: {
          creator: wallet,
          first_seen_at: new Date().toISOString(),
          coins_launched: 0,
          coins_active: 0,
          coins_rugged: 1,
          coins_abandoned: 0,
          total_holder_count: 0,
          total_longevity_hours: 0,
          launches: [{ mint: "a" }, { mint: "b" }, { mint: "c" }],
          tier: "NEUTRAL",
          score: 50,
        },
      },
    }, null, 2));

    const { markDevCoinOutcome } = await import("../tools/community-detector.js");
    // Mark a NON-bad outcome; this must not crash and must score against the
    // real launch count (3), not the inflated fallback of 1.
    await markDevCoinOutcome({ creatorWallet: wallet, mint: "c", outcome: "active", longevityHours: 24 });

    const store = JSON.parse(fs.readFileSync(DEV_FILE, "utf8"));
    const dev = store.devs[wallet];
    // successRate = (3 - 1 rug) / 3 ≈ 0.667 → score base ~40. If the bug were
    // present, totalLaunches would be 1, successRate (1-1)/1 = 0, score base 0.
    // The -20 rug penalty applies in both cases, so the surviving signal is a
    // clearly non-zero, non-floored score driven by the 3-launch denominator.
    expect(dev.score).toBeGreaterThan(0);
  });

  it("does not throw when launches is undefined and coins_launched is 0", async () => {
    const wallet = "BugThreeNoLaunches";
    fs.writeFileSync(DEV_FILE, JSON.stringify({
      devs: {
        [wallet]: {
          creator: wallet,
          first_seen_at: new Date().toISOString(),
          coins_launched: 0,
          coins_active: 0,
          coins_rugged: 0,
          coins_abandoned: 0,
          total_holder_count: 0,
          total_longevity_hours: 0,
          // launches intentionally omitted — the original crash case.
          tier: "NEUTRAL",
          score: 50,
        },
      },
    }, null, 2));

    const { markDevCoinOutcome } = await import("../tools/community-detector.js");
    const res = await markDevCoinOutcome({ creatorWallet: wallet, mint: "x", outcome: "active" });
    expect(res).not.toBeNull();
    const store = JSON.parse(fs.readFileSync(DEV_FILE, "utf8"));
    expect(Number.isFinite(store.devs[wallet].score)).toBe(true);
  });
});
