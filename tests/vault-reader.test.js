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

beforeEach(async () => {
  process.env.PONYOU_VAULT_NOTES_FILE = TMP_FILE;
  // Re-import fresh each test so the module reads the env-pointed file
  const mod = await import("../tools/vault-reader.js");
  getVaultOverrides = mod.getVaultOverrides;
  _resetVaultCache = mod._resetVaultCache;
  _resetVaultCache();
});

afterEach(() => {
  _resetVaultCache();
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
