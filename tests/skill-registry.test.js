/**
 * Skill Registry coverage — Phase 4 internal marketplace + vetting gate.
 * Registry/lock paths are redirected to a tmp dir by vitest.config.js, so these
 * never touch live state. Asserts the export→import round-trip, hash-tamper
 * rejection, the params allow-list, and the execution-class quarantine rule.
 */

import { beforeEach, describe, it, expect } from "vitest";
import {
  upsertStrategySkill,
  getStrategySkill,
  setStrategySkillStatus,
  setStrategySkillScorecard,
  getSkillLockEntry,
  _resetRegistryForTests,
} from "../strategy-skills.js";
import {
  exportSkillPackage,
  vetPackage,
  importSkillPackage,
  isQuarantined,
  listImportedSkills,
  PACKAGE_FORMAT_VERSION,
} from "../skill-registry.js";

beforeEach(() => {
  _resetRegistryForTests();
});

function makeLocalSkill(id = "src_skill") {
  return upsertStrategySkill({
    id,
    type: "composite",
    params: {
      filters: { min_mcap_usd: 1000, max_mcap_usd: 100000 },
      stoploss: -0.15,
      minimal_roi: { "0": 0.5 },
    },
    status: "active",
    weight: 0.5,
  });
}

function passingScorecard() {
  const m = { sample: 35, win_rate: 0.5, expectancy_pct: 8, max_drawdown_pct: 25, sharpe: 0.4 };
  return { sample: 50, metrics: { ...m, sample: 50 }, walk_forward: { in_sample: m, out_of_sample: m } };
}

describe("exportSkillPackage", () => {
  it("packages a registered skill with manifest + hash", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    expect(pkg.format_version).toBe(PACKAGE_FORMAT_VERSION);
    expect(pkg.manifest.id).toBe("src_skill");
    expect(pkg.manifest.params.stoploss).toBe(-0.15);
    expect(pkg.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("throws on an unknown skill", () => {
    expect(() => exportSkillPackage("nope")).toThrow(/unknown skill/i);
  });
});

describe("vetPackage", () => {
  it("passes a clean data-only package", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    const v = vetPackage(pkg);
    expect(v.passed).toBe(true);
    expect(v.quarantine).toBe(false);
  });

  it("rejects a hash-tampered package", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    pkg.manifest.params.stoploss = -0.99; // tamper after hashing
    const v = vetPackage(pkg);
    expect(v.passed).toBe(false);
    expect(v.reasons.some(r => /hash mismatch/.test(r))).toBe(true);
  });

  it("rejects a disallowed param key (smuggled directive)", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    pkg.manifest.params.run_command = "rm -rf /";
    pkg.hash = undefined; // skip the hash check to isolate the allow-list
    const v = vetPackage(pkg);
    expect(v.passed).toBe(false);
    expect(v.reasons.some(r => /disallowed param key "run_command"/.test(r))).toBe(true);
  });

  it("flags an execution-class capability for quarantine", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill", { capabilities: ["live_trade"] });
    const v = vetPackage(pkg);
    expect(v.passed).toBe(true); // structurally valid...
    expect(v.quarantine).toBe(true); // ...but quarantined
    expect(v.executionCapabilities).toContain("live_trade");
  });
});

describe("importSkillPackage", () => {
  it("round-trips a clean package and lands it inert (draft, weight 0)", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    _resetRegistryForTests(); // simulate importing into a fresh registry
    const res = importSkillPackage(pkg);
    expect(res.imported).toBe(true);
    expect(res.quarantined).toBe(false);
    const imported = getStrategySkill("src_skill");
    expect(imported.status).toBe("draft");
    expect(imported.weight).toBe(0);
    expect(getSkillLockEntry("src_skill").source).toBe("imported");
  });

  it("throws on a tampered package and does not register it", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    pkg.manifest.params.stoploss = -0.99;
    _resetRegistryForTests();
    expect(() => importSkillPackage(pkg)).toThrow(/vetting failed/i);
    expect(getStrategySkill("src_skill")).toBeNull();
  });

  it("refuses to overwrite an existing skill unless overwrite:true", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill");
    expect(() => importSkillPackage(pkg)).toThrow(/already exists/);
    expect(() => importSkillPackage(pkg, { overwrite: true })).not.toThrow();
  });

  it("quarantines an execution-class import and blocks promotion even with approval", () => {
    makeLocalSkill();
    const pkg = exportSkillPackage("src_skill", { capabilities: ["wallet_access"] });
    _resetRegistryForTests();
    const res = importSkillPackage(pkg);
    expect(res.quarantined).toBe(true);
    expect(isQuarantined("src_skill")).toBe(true);

    // Even a perfect scorecard + approval cannot promote a quarantined skill.
    setStrategySkillScorecard("src_skill", passingScorecard());
    expect(() => setStrategySkillStatus("src_skill", "active", { approved: true }))
      .toThrow(/quarantined execution-class/);
  });
});

describe("listImportedSkills", () => {
  it("lists only imported skills with their vetting metadata", () => {
    makeLocalSkill("native_one");
    const pkg = exportSkillPackage("native_one", { capabilities: ["external_call"] });
    _resetRegistryForTests(); // import into a fresh registry (no id clash)
    importSkillPackage(pkg);
    const list = listImportedSkills();
    expect(list.map(s => s.id)).toEqual(["native_one"]);
    expect(list[0].vetting.quarantined).toBe(true);
  });
});
