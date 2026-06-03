import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { logScreeningDecision, _getVaultWriterDir } from "../tools/vault-writer.js";

let TMP_DIR;
let NOTES_FILE;

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function autoFilePath() {
  return path.join(_getVaultWriterDir(), "05-Decisions", `auto-${ymd()}.md`);
}

const SAMPLE_CANDS = [
  { symbol: "AAA", mcap: 500000, rug_score: 12, mint: "mintA" },
  { symbol: "BBB", mcap: 300000, rug_score: 45, mint: "mintB" },
  { symbol: "CCC", mcap: 100000, rug_score: 7, mint: "mintC" },
];

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-vw-"));
  // 05-Decisions/ lives next to the notes file's dir
  fs.mkdirSync(path.join(TMP_DIR, "05-Decisions"), { recursive: true });
  NOTES_FILE = path.join(TMP_DIR, "operator-notes.md");
  process.env.PONYOU_VAULT_NOTES_FILE = NOTES_FILE;
});

afterEach(() => {
  delete process.env.PONYOU_VAULT_NOTES_FILE;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("vault-writer", () => {
  it("creates the auto-YYYY-MM-DD.md file with frontmatter when it does not exist", async () => {
    await logScreeningDecision({
      candidates: SAMPLE_CANDS,
      decision: "SKIP: conviction weak",
      marketCondition: "NORMAL",
      deployAmount: 0.2,
    });

    const file = autoFilePath();
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, "utf8");
    expect(body).toContain("tags: [decisions, auto-generated]");
    expect(body).toContain("type: auto-decision-log");
    expect(body).toContain(`# Auto Decision Log — ${ymd()}`);
  });

  it("appends a SKIP entry with correct format", async () => {
    await logScreeningDecision({
      candidates: SAMPLE_CANDS,
      decision: "SKIP: kelly negative, no edge",
      marketCondition: "HOT",
      deployAmount: 0.3,
    });

    const body = fs.readFileSync(autoFilePath(), "utf8");
    expect(body).toContain("HOT | 3 candidates");
    expect(body).toContain("**SKIP** — 0.3 SOL");
    expect(body).toContain("AAA(rug=12)");
    expect(body).toContain("BBB(rug=45)");
    expect(body).toContain("CCC(rug=7)");
    expect(body).toContain("Reason: SKIP: kelly negative, no edge");
  });

  it("detects BUY type when decision contains swap_token", async () => {
    await logScreeningDecision({
      candidates: SAMPLE_CANDS,
      decision: 'Calling swap_token for $AAA {"symbol":"AAA"}',
      marketCondition: "HOT",
      deployAmount: 0.5,
    });

    const body = fs.readFileSync(autoFilePath(), "utf8");
    expect(body).toContain("**BUY**");
    expect(body).toContain("AAA");
    // JSON blob should be stripped from the reason line
    expect(body).not.toContain('{"symbol":"AAA"}');
  });

  it("detects PAPER-BUY type when decision contains dry_run", async () => {
    await logScreeningDecision({
      candidates: SAMPLE_CANDS,
      decision: "swap_token dry_run executed for AAA",
      marketCondition: "COLD",
      deployAmount: 0.1,
    });

    const body = fs.readFileSync(autoFilePath(), "utf8");
    expect(body).toContain("**PAPER-BUY**");
  });

  it("never throws when the vault dir does not exist (swallows error silently)", async () => {
    process.env.PONYOU_VAULT_NOTES_FILE = path.join(TMP_DIR, "nonexistent", "deep", "operator-notes.md");
    await expect(
      logScreeningDecision({
        candidates: SAMPLE_CANDS,
        decision: "SKIP",
        marketCondition: "DEAD",
        deployAmount: 0,
      })
    ).resolves.toBeUndefined();
  });
});
