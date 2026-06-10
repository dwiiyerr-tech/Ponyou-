/**
 * Darwin learning → second brain: writeDarwinLearning() writes 60-Learning/_darwin.md
 * and getVaultIntelligenceContext() surfaces it as a "Learning:" line for the LLM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getDarwinAnalytics = vi.fn();
const getShadowStats = vi.fn();

vi.mock("../lessons.js", () => ({ getDarwinAnalytics }));
vi.mock("../tools/shadow-watchlist.js", () => ({ getShadowStats }));

const { writeDarwinLearning } = await import("../tools/vault-writer.js");
const { getVaultIntelligenceContext, _resetVaultIntelligenceCache } = await import("../tools/vault-reader.js");

let TMP_DIR;

const ANALYTICS = [
  { signal: "conviction",  weight: 1.45, success_count: 13, failure_count: 8,  total_uses: 21, win_rate: 13 / 21 },
  { signal: "velocity",    weight: 1.12, success_count: 5,  failure_count: 4,  total_uses: 9,  win_rate: 5 / 9 },
  { signal: "kelly",       weight: 1.00, success_count: 1,  failure_count: 1,  total_uses: 2,  win_rate: 0.5 },
  { signal: "social_buzz", weight: 0.55, success_count: 2,  failure_count: 8,  total_uses: 10, win_rate: 0.2 },
];

const SHADOW = {
  total: 30, watching: 12, rugged: 5, mooned: 2, survived: 11,
  by_source: {
    gmgn_trending: { total: 10, rugged: 3, mooned: 1 },
    dexscreener:   { total: 20, rugged: 2, mooned: 1 },
  },
};

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-darwin-vault-"));
  process.env.PONYOU_VAULT_NOTES_FILE = path.join(TMP_DIR, "operator-notes.md");
  getDarwinAnalytics.mockReturnValue(ANALYTICS);
  getShadowStats.mockReturnValue(SHADOW);
  _resetVaultIntelligenceCache();
});

afterEach(() => {
  delete process.env.PONYOU_VAULT_NOTES_FILE;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
  _resetVaultIntelligenceCache();
});

describe("writeDarwinLearning", () => {
  it("writes 60-Learning/_darwin.md with fitness frontmatter and tables", async () => {
    await writeDarwinLearning();

    const file = path.join(TMP_DIR, "60-Learning", "_darwin.md");
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, "utf8");

    expect(body).toContain("signals_tracked: 4");
    expect(body).toContain('proven_signals: "conviction:1.45|62|21, velocity:1.12|56|9"');
    expect(body).toContain('weak_signals: "social_buzz:0.55|20|10"');
    expect(body).toContain("shadow_rugged: 5");
    expect(body).toContain("shadow_mooned: 2");
    // kelly has only 2 samples — must be in the full table but not proven/weak
    expect(body).toContain("➖ kelly");
    expect(body).toContain("📈 conviction");
    expect(body).toContain("📉 social_buzz");
    // per-source shadow table
    expect(body).toContain("| gmgn_trending | 10 | 3 | 1 |");
  });

  it("handles an empty registry without throwing", async () => {
    getDarwinAnalytics.mockReturnValue([]);
    getShadowStats.mockReturnValue({ total: 0, watching: 0, rugged: 0, mooned: 0, survived: 0, by_source: {} });
    await expect(writeDarwinLearning()).resolves.toBeUndefined();
    const body = fs.readFileSync(path.join(TMP_DIR, "60-Learning", "_darwin.md"), "utf8");
    expect(body).toContain("No learned signals yet");
  });

  it("never throws when vault dir is unwritable (best-effort)", async () => {
    // A path whose parent is a regular file → mkdir fails with ENOTDIR
    const blocker = path.join(TMP_DIR, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    process.env.PONYOU_VAULT_NOTES_FILE = path.join(blocker, "deep", "operator-notes.md");
    await expect(writeDarwinLearning()).resolves.toBeUndefined();
  });
});

describe("getVaultIntelligenceContext — Learning section", () => {
  it("surfaces proven/weak signals and shadow outcomes to the LLM", async () => {
    await writeDarwinLearning();
    _resetVaultIntelligenceCache();

    const ctx = getVaultIntelligenceContext();
    expect(ctx).toContain("Learning:");
    expect(ctx).toContain("↑conviction(w1.45,62%wr,n=21)");
    expect(ctx).toContain("↑velocity(w1.12,56%wr,n=9)");
    expect(ctx).toContain("↓social_buzz(w0.55,20%wr,n=10)");
    expect(ctx).toContain("shadow: 5 rugs avoided, 2 winners missed");
  });

  it("omits the Learning section when the snapshot does not exist", () => {
    const ctx = getVaultIntelligenceContext();
    expect(ctx === null || !ctx.includes("Learning:")).toBe(true);
  });
});
