import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Narrative feedback for slow-rug exits ────────────────────────────────────
import { recordRuggedNarrativesForExit } from "../narrative-contagion.js";

describe("narrative contagion — exit path", () => {
  it("records narrative for rug exit reason (normalizes to uppercase)", () => {
    const result = recordRuggedNarrativesForExit({
      reason: "rug detected",
      token: { narrative_tags: ["ai agent"] },
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].narrative).toBe("AI AGENT");
  });

  it("does not record for non-rug reason", () => {
    const result = recordRuggedNarrativesForExit({
      reason: "trailing stop",
      token: { narrative_tags: ["ai agent"] },
    });
    expect(result).toHaveLength(0);
  });
});

// ─── Zombie wallet decay filter ───────────────────────────────────────────────
vi.mock("fs");
import fs from "fs";

const RECENT = Date.now() - 1 * 24 * 60 * 60 * 1000;         // 1 day ago → multiplier 1.0
const ZOMBIE = Date.now() - 100 * 24 * 60 * 60 * 1000;        // 100 days ago → multiplier 0.2

describe("listSmartWallets — decay filter", () => {
  beforeEach(() => {
    const wallets = {
      recent1: { address: "recent1", last_active: RECENT },
      recent2: { address: "recent2", last_active: RECENT },
      zombie1: { address: "zombie1", last_active: ZOMBIE },
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(wallets));
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it("returns all wallets with default minDecayMultiplier=0", async () => {
    const { listSmartWallets } = await import("../smart-wallets.js");
    const result = listSmartWallets();
    expect(result.length).toBe(3);
  });

  it("filters out zombie wallets at minDecayMultiplier=0.5", async () => {
    const { listSmartWallets } = await import("../smart-wallets.js");
    const result = listSmartWallets({ minDecayMultiplier: 0.5 });
    expect(result.find(w => w.address === "zombie1")).toBeUndefined();
    expect(result.length).toBe(2);
  });
});
