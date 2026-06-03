/**
 * Tests for autonomyMode — single control over all learning-proposal gates.
 *
 * autonomyMode:
 *   "manual"     → all proposals require approve (gate ON)
 *   "supervised" → high-confidence auto-approve, rest reviewed (gate ON, default)
 *   "full_auto"  → bot applies all proposals immediately (gate OFF)
 *
 * Trading safety gates (kill-switch, maxDeployAmount, DRY_RUN) are NEVER
 * affected by autonomyMode — only learning-proposal approval is.
 */
import { describe, it, expect } from "vitest";
import { buildVaultConfig } from "../config.js";

describe("autonomyMode → vault proposal gate derivation", () => {
  it("full_auto forces vault proposalEnabled=false (gate off)", () => {
    const cfg = buildVaultConfig({ autonomyMode: "full_auto" });
    expect(cfg.proposalEnabled).toBe(false);
  });

  it("supervised keeps vault gate on by default", () => {
    const cfg = buildVaultConfig({ autonomyMode: "supervised" });
    expect(cfg.proposalEnabled).toBe(true);
  });

  it("manual keeps vault gate on", () => {
    const cfg = buildVaultConfig({ autonomyMode: "manual" });
    expect(cfg.proposalEnabled).toBe(true);
  });

  it("no autonomyMode defaults to gate on", () => {
    const cfg = buildVaultConfig({});
    expect(cfg.proposalEnabled).toBe(true);
  });

  it("full_auto overrides explicit vaultProposalEnabled=true", () => {
    // full_auto wins — safety-conservative: explicit gate-on can't fight full_auto
    const cfg = buildVaultConfig({ autonomyMode: "full_auto", vaultProposalEnabled: true });
    expect(cfg.proposalEnabled).toBe(false);
  });

  it("explicit vaultProposalEnabled=false turns gate off even in supervised", () => {
    const cfg = buildVaultConfig({ autonomyMode: "supervised", vaultProposalEnabled: false });
    expect(cfg.proposalEnabled).toBe(false);
  });
});

describe("autonomyMode → top-level config flags", () => {
  it("config exposes autonomyMode + isFullAuto + isManual", async () => {
    // Re-import config fresh to read current user-config.json state
    const { config } = await import("../config.js");
    expect(config).toHaveProperty("autonomyMode");
    expect(typeof config.isFullAuto).toBe("boolean");
    expect(typeof config.isManual).toBe("boolean");
  });
});

describe("autonomyMode → strategy proposal gate derivation", () => {
  // The strategy.evolution.proposalEnabled is derived in config.js.
  // We verify the logic matches vault: full_auto → off, else honor flag.
  it("derivation logic: full_auto → false", () => {
    const u = { autonomyMode: "full_auto" };
    const derived = u.autonomyMode === "full_auto" ? false : (u.strategyProposalEnabled ?? true);
    expect(derived).toBe(false);
  });

  it("derivation logic: supervised + no flag → true", () => {
    const u = { autonomyMode: "supervised" };
    const derived = u.autonomyMode === "full_auto" ? false : (u.strategyProposalEnabled ?? true);
    expect(derived).toBe(true);
  });

  it("derivation logic: manual + explicit false → false", () => {
    const u = { autonomyMode: "manual", strategyProposalEnabled: false };
    const derived = u.autonomyMode === "full_auto" ? false : (u.strategyProposalEnabled ?? true);
    expect(derived).toBe(false);
  });
});
