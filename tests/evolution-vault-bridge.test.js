/**
 * Evolution↔Vault bridge (task #22) — strategy evolution reports itself to the
 * vault, narrative-rug data is actually reachable by the proposal engine, and
 * the LLM context surfaces evolution status.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { atomicWriteJson } from "../atomic-write.js";

let dir, prevNotes, prevReg, prevProps;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-bridge-"));
  prevNotes = process.env.PONYOU_VAULT_NOTES_FILE;
  prevReg   = process.env.PONYOU_STRATEGY_REGISTRY_FILE;
  prevProps = process.env.PONYOU_VAULT_PROPOSALS_FILE;
  process.env.PONYOU_VAULT_NOTES_FILE        = path.join(dir, "operator-notes.md");
  process.env.PONYOU_STRATEGY_REGISTRY_FILE  = path.join(dir, "strategy-registry.json");
  process.env.PONYOU_VAULT_PROPOSALS_FILE    = path.join(dir, "vault-proposals.json");
  fs.writeFileSync(process.env.PONYOU_VAULT_NOTES_FILE, "---\npause_trading: false\n---\n\n# Notes\n");
});

afterEach(async () => {
  // assigning undefined stores the string "undefined" — delete instead
  for (const [k, v] of [
    ["PONYOU_VAULT_NOTES_FILE", prevNotes],
    ["PONYOU_STRATEGY_REGISTRY_FILE", prevReg],
    ["PONYOU_VAULT_PROPOSALS_FILE", prevProps],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { _resetVaultCache, _resetVaultIntelligenceCache } = await import("../tools/vault-reader.js");
  _resetVaultCache();
  _resetVaultIntelligenceCache();
  const { clearRuggedNarratives } = await import("../narrative-contagion.js");
  clearRuggedNarratives();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedRegistry(records) {
  atomicWriteJson(process.env.PONYOU_STRATEGY_REGISTRY_FILE, { strategies: records });
}

describe("getRuggedNarratives", () => {
  it("exposes rug counts recorded inside the contagion window", async () => {
    const { recordRuggedNarrativesForExit, getRuggedNarratives, clearRuggedNarratives } =
      await import("../narrative-contagion.js");
    clearRuggedNarratives();
    const now = Date.now();
    recordRuggedNarrativesForExit({ reason: "rug detected", token: { narrative: "dogwifhat" }, nowMs: now });
    recordRuggedNarrativesForExit({ reason: "lp drain",     token: { narrative: "dogwifhat" }, nowMs: now + 1000 });
    const out = getRuggedNarratives({ nowMs: now + 2000 });
    expect(out).toEqual([{ narrative: "DOGWIFHAT", rug_count: 2, last_rug_at: new Date(now + 1000).toISOString() }]);
  });

  it("prunes entries older than the 2h contagion window", async () => {
    const { recordRuggedNarrativesForExit, getRuggedNarratives, clearRuggedNarratives } =
      await import("../narrative-contagion.js");
    clearRuggedNarratives();
    const now = Date.now();
    recordRuggedNarrativesForExit({ reason: "rug", token: { narrative: "oldnews" }, nowMs: now });
    expect(getRuggedNarratives({ nowMs: now + 3 * 60 * 60 * 1000 })).toEqual([]);
  });
});

describe("vault-proposal narrative analyzer (was a permanent no-op)", () => {
  it("fires a narrative_block proposal once a narrative hits 2 rugs", async () => {
    const { recordRuggedNarrativesForExit, clearRuggedNarratives } = await import("../narrative-contagion.js");
    clearRuggedNarratives();
    const now = Date.now();
    recordRuggedNarrativesForExit({ reason: "honeypot", token: { narrative: "ai-agents" }, nowMs: now });
    recordRuggedNarrativesForExit({ reason: "rug pull", token: { narrative: "ai-agents" }, nowMs: now + 500 });

    const { _analyzeNarrativeHeat } = await import("../agents/vault-proposal.js");
    const proposals = await _analyzeNarrativeHeat();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe("narrative_block");
    expect(proposals[0].tag).toBe("narrative:AI-AGENTS");
    expect(proposals[0].lesson).toContain("AI-AGENTS");
  });

  it("stays quiet below 2 rugs", async () => {
    const { recordRuggedNarrativesForExit, clearRuggedNarratives } = await import("../narrative-contagion.js");
    clearRuggedNarratives();
    recordRuggedNarrativesForExit({ reason: "rug", token: { narrative: "solo-rug" } });
    const { _analyzeNarrativeHeat } = await import("../agents/vault-proposal.js");
    expect(await _analyzeNarrativeHeat()).toEqual([]);
  });
});

describe("writeEvolutionStatus", () => {
  it("snapshots the registry with status counts and pending proposals", async () => {
    seedRegistry([
      { id: "a1", name: "hot-regime-sniper", type: "llm", status: "active", source: "evolution",
        rules: {}, regime: "HOT", scores: { live: 0.8 }, activatedAt: "2026-06-12T10:00:00.000Z",
        createdAt: "2026-06-12T09:00:00.000Z", updatedAt: "2026-06-12T10:00:00.000Z" },
      { id: "c1", name: "cold-dip-buyer", type: "llm", status: "candidate", source: "evolution",
        rules: {}, regime: "COLD", scores: {}, createdAt: "2026-06-12T11:00:00.000Z" },
      { id: "r1", name: "bad-idea", type: "llm", status: "rejected", source: "evolution",
        rules: {}, rejectReason: "gate failed: backtest WR 20%", createdAt: "2026-06-12T08:00:00.000Z" },
    ]);
    atomicWriteJson(process.env.PONYOU_VAULT_PROPOSALS_FILE, {
      pending: { vault_abc: { id: "vault_abc", type: "lesson", lesson: "Prioritaskan X", ts: Date.now() } },
      history: [],
    });

    const { writeEvolutionStatus } = await import("../tools/vault-writer.js");
    await writeEvolutionStatus();

    const body = fs.readFileSync(path.join(dir, "60-Learning", "_evolution.md"), "utf8");
    expect(body).toContain("active_count: 1");
    expect(body).toContain("candidate_count: 1");
    expect(body).toContain("rejected_count: 1");
    expect(body).toContain("pending_proposals: 1");
    expect(body).toContain('latest_active: "hot-regime-sniper"');
    expect(body).toContain("| active | hot-regime-sniper | llm | HOT | evolution | live=0.8 |");
    expect(body).toContain("gate failed: backtest WR 20%");
    expect(body).toContain("/approve_vault_abc");
  });

  it("does nothing when the registry file does not exist", async () => {
    const { writeEvolutionStatus } = await import("../tools/vault-writer.js");
    await writeEvolutionStatus();
    expect(fs.existsSync(path.join(dir, "60-Learning", "_evolution.md"))).toBe(false);
  });
});

describe("intelligence context Evolution line", () => {
  it("surfaces registry counts from the _evolution.md frontmatter", async () => {
    seedRegistry([
      { id: "a1", name: "hot-regime-sniper", type: "llm", status: "active", source: "evolution",
        rules: {}, scores: {}, activatedAt: "2026-06-12T10:00:00.000Z", createdAt: "2026-06-12T09:00:00.000Z" },
      { id: "c1", name: "cold-dip-buyer", type: "llm", status: "candidate", source: "evolution",
        rules: {}, scores: {}, createdAt: "2026-06-12T11:00:00.000Z" },
    ]);
    const { writeEvolutionStatus } = await import("../tools/vault-writer.js");
    await writeEvolutionStatus();

    const { getVaultIntelligenceContext, _resetVaultCache, _resetVaultIntelligenceCache } =
      await import("../tools/vault-reader.js");
    _resetVaultCache();
    _resetVaultIntelligenceCache();
    const ctx = getVaultIntelligenceContext();
    expect(ctx).toContain("Evolution: 1 active, 1 candidate | latest: hot-regime-sniper");
  });
});
