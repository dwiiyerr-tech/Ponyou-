/**
 * Vault Control Plane v2 (task #21) — frontmatter operator-notes menyetir
 * knob mesin dengan clamp, dan Engine Reality doc menyatakan parameter LIVE.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let dir, prevNotes;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cp-"));
  prevNotes = process.env.PONYOU_VAULT_NOTES_FILE;
  process.env.PONYOU_VAULT_NOTES_FILE = path.join(dir, "operator-notes.md");
});

afterEach(async () => {
  // assigning undefined would store the string "undefined" and poison other suites
  if (prevNotes === undefined) delete process.env.PONYOU_VAULT_NOTES_FILE;
  else process.env.PONYOU_VAULT_NOTES_FILE = prevNotes;
  const { _resetVaultCache, _resetVaultIntelligenceCache } = await import("../tools/vault-reader.js");
  _resetVaultCache();
  _resetVaultIntelligenceCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeNotes(frontmatter) {
  fs.writeFileSync(process.env.PONYOU_VAULT_NOTES_FILE, `---\n${frontmatter}\n---\n\n# Notes\n`);
}

describe("max_entry_rug_score override (clamped engine knob)", () => {
  it("parses an in-range value", async () => {
    writeNotes("max_entry_rug_score: 45");
    const { getVaultOverrides, _resetVaultCache } = await import("../tools/vault-reader.js");
    _resetVaultCache();
    expect(getVaultOverrides().max_entry_rug_score).toBe(45);
  });

  it("ignores out-of-range values — a typo can never disable the gate", async () => {
    const { getVaultOverrides, _resetVaultCache } = await import("../tools/vault-reader.js");
    for (const bad of ["max_entry_rug_score: 999", "max_entry_rug_score: 5", "max_entry_rug_score: abc"]) {
      writeNotes(bad);
      _resetVaultCache();
      expect(getVaultOverrides().max_entry_rug_score, bad).toBeNull();
    }
  });

  it("defaults to null when the key is absent (identity behavior)", async () => {
    writeNotes("pause_trading: false");
    const { getVaultOverrides, _resetVaultCache } = await import("../tools/vault-reader.js");
    _resetVaultCache();
    expect(getVaultOverrides().max_entry_rug_score).toBeNull();
  });

  it("surfaces an active override loudly in the intelligence context", async () => {
    writeNotes("max_entry_rug_score: 45");
    const { getVaultIntelligenceContext, _resetVaultCache, _resetVaultIntelligenceCache } = await import("../tools/vault-reader.js");
    _resetVaultCache();
    _resetVaultIntelligenceCache();
    expect(getVaultIntelligenceContext()).toContain("ENGINE OVERRIDE: entry rug gate = 45");
  });
});

describe("writeEngineReality", () => {
  it("writes the live-parameter doc with gate source and guard states", async () => {
    writeNotes("max_entry_rug_score: 45");
    const { _resetVaultCache } = await import("../tools/vault-reader.js");
    _resetVaultCache();
    const { writeEngineReality } = await import("../tools/vault-writer.js");
    await writeEngineReality();
    const body = fs.readFileSync(path.join(dir, "00-Overview", "_engine-reality.md"), "utf8");
    expect(body).toContain("Engine Reality");
    expect(body).toContain("**45** (OVERRIDE operator-notes frontmatter");
    expect(body).toContain("AUTO-GENERATED");
    expect(body).toMatch(/Capital guard: (ON|off)/);
  });
});
