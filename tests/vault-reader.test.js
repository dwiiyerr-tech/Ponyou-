import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_FILE = path.join(os.tmpdir(), `ponyou-vault-test-${process.pid}.md`);

function writeNotes(frontmatter) {
  fs.writeFileSync(TMP_FILE, `---\n${frontmatter}\n---\n\n# Operator Notes\n`, "utf8");
}

let getVaultOverrides;
let _resetVaultCache;
let getVaultContext;
let _resetVaultContextCache;

beforeEach(async () => {
  process.env.PONYOU_VAULT_NOTES_FILE = TMP_FILE;
  // Re-import fresh each test so the module reads the env-pointed file
  const mod = await import("../tools/vault-reader.js");
  getVaultOverrides = mod.getVaultOverrides;
  _resetVaultCache = mod._resetVaultCache;
  getVaultContext = mod.getVaultContext;
  _resetVaultContextCache = mod._resetVaultContextCache;
  _resetVaultCache();
  _resetVaultContextCache();
});

afterEach(() => {
  _resetVaultCache();
  _resetVaultContextCache?.();
  try { fs.unlinkSync(TMP_FILE); } catch { /* ignore */ }
});

describe("vault-reader", () => {
  it("returns empty overrides when the file is missing (graceful)", () => {
    try { fs.unlinkSync(TMP_FILE); } catch { /* ignore */ }
    _resetVaultCache();
    const o = getVaultOverrides();
    expect(o.pause_trading).toBe(false);
    expect(o.blacklist_tokens).toEqual([]);
    expect(o.blacklist_narratives).toEqual([]);
    expect(o.focus_narrative).toBeNull();
    expect(o.skip_mcap_above).toBeNull();
  });

  it("parses pause_trading: true correctly", () => {
    writeNotes("pause_trading: true\nblacklist_tokens: []\nblacklist_narratives: []\nfocus_narrative: null\nskip_mcap_above: null");
    _resetVaultCache();
    expect(getVaultOverrides().pause_trading).toBe(true);
  });

  it("parses blacklist_tokens array and uppercases symbols", () => {
    writeNotes('pause_trading: false\nblacklist_tokens: ["bonk", "rugme"]\nblacklist_narratives: []');
    _resetVaultCache();
    expect(getVaultOverrides().blacklist_tokens).toEqual(["BONK", "RUGME"]);
  });

  it("parses blacklist_narratives array and lowercases values", () => {
    writeNotes('pause_trading: false\nblacklist_narratives: ["Casino", "TRUMP"]');
    _resetVaultCache();
    expect(getVaultOverrides().blacklist_narratives).toEqual(["casino", "trump"]);
  });

  it("parses skip_mcap_above number and focus_narrative string", () => {
    writeNotes('pause_trading: false\nfocus_narrative: "AI"\nskip_mcap_above: 1500000');
    _resetVaultCache();
    const o = getVaultOverrides();
    expect(o.skip_mcap_above).toBe(1500000);
    expect(o.focus_narrative).toBe("ai");
  });

  it("respects the cache (second call does not pick up file changes)", () => {
    writeNotes("pause_trading: true");
    _resetVaultCache();
    expect(getVaultOverrides().pause_trading).toBe(true);
    // Change file but do NOT reset cache — should still return cached value
    writeNotes("pause_trading: false");
    expect(getVaultOverrides().pause_trading).toBe(true);
  });

  it("_resetVaultCache() forces a re-read", () => {
    writeNotes("pause_trading: true");
    _resetVaultCache();
    expect(getVaultOverrides().pause_trading).toBe(true);
    writeNotes("pause_trading: false");
    _resetVaultCache();
    expect(getVaultOverrides().pause_trading).toBe(false);
  });
});

describe("getVaultContext", () => {
  // Use an isolated vault dir so the Decisions/Experiments scans are deterministic.
  const CTX_DIR = path.join(os.tmpdir(), `ponyou-vaultctx-${process.pid}`);
  const CTX_NOTES = path.join(CTX_DIR, "operator-notes.md");

  function writeCtxNotes(frontmatter) {
    fs.mkdirSync(CTX_DIR, { recursive: true });
    fs.writeFileSync(CTX_NOTES, `---\n${frontmatter}\n---\n\n# Operator Notes\n`, "utf8");
  }
  function writeDecision(name, h1) {
    const dir = path.join(CTX_DIR, "05-Decisions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `---\ntype: decision\n---\n\n# ${h1}\n`, "utf8");
  }
  function writeExperiment(name, status) {
    const dir = path.join(CTX_DIR, "02-Experiments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `---\ntype: experiment\nstatus: ${status}\n---\n\n# ${name}\n`, "utf8");
  }

  beforeEach(() => {
    fs.rmSync(CTX_DIR, { recursive: true, force: true });
    // getVaultContext resolves PONYOU_VAULT_NOTES_FILE at call time.
    process.env.PONYOU_VAULT_NOTES_FILE = CTX_NOTES;
    _resetVaultContextCache();
  });
  afterEach(() => {
    fs.rmSync(CTX_DIR, { recursive: true, force: true });
  });

  it("returns null when the vault dir is empty/missing", () => {
    // No notes file, no Decisions/Experiments dirs at all
    expect(getVaultContext()).toBeNull();
  });

  it("returns an Operator line when the notes field is set", () => {
    writeCtxNotes('notes: "watching AI narrative"\nblacklist_tokens: ["BONK"]\nfocus_narrative: "ai"');
    _resetVaultContextCache();
    const ctx = getVaultContext();
    expect(ctx).toContain("[VAULT CONTEXT]");
    expect(ctx).toContain("Operator: watching AI narrative");
    expect(ctx).toContain("focus=ai");
    expect(ctx).toContain("blacklist=BONK");
  });

  it("returns an Experiments line with status tags", () => {
    writeCtxNotes('notes: ""');
    writeExperiment("exp-1-foo.md", "validated");
    writeExperiment("exp-2-bar.md", "active");
    writeExperiment("exp-3-empty.md", ""); // empty status → excluded
    _resetVaultContextCache();
    const ctx = getVaultContext();
    expect(ctx).toContain("Experiments:");
    expect(ctx).toContain("exp-1-foo (VALIDATED)");
    expect(ctx).toContain("exp-2-bar (ACTIVE)");
    expect(ctx).not.toContain("exp-3-empty");
  });

  it("returns a Decisions line with date + title", () => {
    writeCtxNotes('notes: ""');
    writeDecision("2026-06-03-audit.md", "Decision: Audit and Fixes");
    _resetVaultContextCache();
    const ctx = getVaultContext();
    expect(ctx).toContain("Decisions: 2026-06-03: Audit and Fixes");
  });

  it("returns null when operator notes are empty and there are no decisions/experiments", () => {
    writeCtxNotes('notes: ""\nblacklist_tokens: []\nfocus_narrative: null');
    _resetVaultContextCache();
    expect(getVaultContext()).toBeNull();
  });
});
