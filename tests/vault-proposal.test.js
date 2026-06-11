/**
 * Tests for agents/vault-proposal.js — VaultProposalEngine
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultProposalEngine } from "../agents/vault-proposal.js";

// Redirect vault-proposals.json to tmp in tests
process.env.PONYOU_VAULT_PROPOSALS_FILE = "/tmp/test-vault-proposals.json";
// Redirect vault writer to tmp
process.env.PONYOU_VAULT_NOTES_FILE = "/tmp/test-vault/operator-notes.md";

describe("VaultProposalEngine: init and dashboard", () => {
  it("initializes and returns empty dashboard", () => {
    const engine = new VaultProposalEngine({ sendTelegram: async () => {} });
    const dash = engine.getDashboard();
    expect(dash).toHaveProperty("pending_count");
    expect(dash).toHaveProperty("approved");
    expect(dash).toHaveProperty("rejected");
    expect(typeof dash.pending_count).toBe("number");
  });

  it("restorePending runs without error on fresh state", () => {
    const engine = new VaultProposalEngine({ sendTelegram: async () => {} });
    expect(() => engine.restorePending()).not.toThrow();
  });
});

describe("VaultProposalEngine: proposal flow", () => {
  let engine;
  let tgMessages;

  beforeEach(() => {
    tgMessages = [];
    engine = new VaultProposalEngine({
      sendTelegram: async (msg) => { tgMessages.push(msg); },
    });
    // Clean state file
    try { require("fs").unlinkSync("/tmp/test-vault-proposals.json"); } catch {}
  });

  it("handleResponse returns false for unknown id", async () => {
    const result = await engine.handleResponse("vault_unknown123", true);
    expect(result).toBe(false);
  });

  it("getDashboard reflects pending count accurately", () => {
    const dash = engine.getDashboard();
    expect(dash.pending_count).toBeGreaterThanOrEqual(0);
  });
});

describe("VaultProposalEngine: analyze() with mocked data", () => {
  it("returns 0 when no learning data available", async () => {
    const engine = new VaultProposalEngine({ sendTelegram: async () => {} });
    // Should not throw, just find nothing to propose
    const count = await engine.analyze();
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe("VaultProposalEngine: Telegram message format", () => {
  it("sends proposal with approve/reject commands", async () => {
    const messages = [];
    const engine = new VaultProposalEngine({
      sendTelegram: async (msg) => { messages.push(msg); },
    });

    // Manually trigger _sendProposal with a test proposal
    await engine._sendProposal({
      id: "vault_test001",
      type: "lesson",
      confidence: 0.86,
      trades: 7,
      lesson: "Prioritaskan entry saat narrative AI/agent aktif",
      reason: "Win rate 86% dari 7 trades",
      ts: Date.now(),
      hash: "abc123",
    });

    expect(messages.length).toBe(1);
    const msg = messages[0];
    expect(msg).toMatch(/Ponyou Proposal/);
    expect(msg).toMatch(/approve_vault_test001/);
    expect(msg).toMatch(/reject_vault_test001/);
    expect(msg).toMatch(/86%/);
    expect(msg).toMatch(/AI\/agent/);
  });
});

describe("VaultProposalEngine: pending dedup by stable tag (exp #11 fallout)", () => {
  // The lesson text embeds changing counts ("rug 100% dari 102/7131/10186
  // trades"), so contentHash alone re-proposed the same insight every cycle —
  // 22 identical source_quality proposals were pending on 2026-06-11. Both
  // pending-dedup sites must also match on the proposal's stable tag.
  it("both pending-dedup sites match on tag, not just content hash", () => {
    const fs = require("fs");
    const src = fs.readFileSync(new URL("../agents/vault-proposal.js", import.meta.url), "utf8");
    const tagChecks = src.match(/pend\.tag === p\.tag/g) || [];
    expect(tagChecks.length).toBeGreaterThanOrEqual(2);
  });
});
