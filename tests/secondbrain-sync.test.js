/**
 * Tests for secondbrain-sync.js — pure logic for the Second Brain setup wizard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  validateRemoteUrl,
  buildVaultGitignore,
  buildSetupPlan,
  detectSyncState,
  readSyncConfig,
  saveSyncConfig,
  syncConfigPath,
  buildSyncStatus,
  SYNC_METHODS,
} from "../secondbrain-sync.js";

describe("validateRemoteUrl", () => {
  it("accepts https github URL", () => {
    const v = validateRemoteUrl("https://github.com/me/ponyou-brain.git");
    expect(v.valid).toBe(true);
    expect(v.owner).toBe("me");
    expect(v.repo).toBe("ponyou-brain");
    expect(v.protocol).toBe("https");
  });

  it("accepts https URL without .git", () => {
    const v = validateRemoteUrl("https://github.com/me/brain");
    expect(v.valid).toBe(true);
    expect(v.repo).toBe("brain");
  });

  it("accepts scp-style ssh URL", () => {
    const v = validateRemoteUrl("git@github.com:me/brain.git");
    expect(v.valid).toBe(true);
    expect(v.protocol).toBe("ssh");
    expect(v.owner).toBe("me");
  });

  it("accepts ssh:// URL", () => {
    const v = validateRemoteUrl("ssh://git@github.com/me/brain.git");
    expect(v.valid).toBe(true);
    expect(v.protocol).toBe("ssh");
  });

  it("rejects non-github URL", () => {
    expect(validateRemoteUrl("https://gitlab.com/me/brain").valid).toBe(false);
  });

  it("rejects empty/garbage", () => {
    expect(validateRemoteUrl("").valid).toBe(false);
    expect(validateRemoteUrl("not a url").valid).toBe(false);
    expect(validateRemoteUrl(null).valid).toBe(false);
  });
});

describe("buildVaultGitignore", () => {
  it("ignores obsidian workspace state but not vault content", () => {
    const gi = buildVaultGitignore();
    expect(gi).toContain(".obsidian/workspace.json");
    expect(gi).toContain(".refresh.log");
    expect(gi).toContain("obsidian-git/data.json"); // token-bearing plugin data
    // Should NOT ignore the markdown content dirs
    expect(gi).not.toContain("05-Decisions");
    expect(gi).not.toContain("*.md");
  });
});

describe("buildSetupPlan", () => {
  it("git-init step when not yet a repo", () => {
    const plan = buildSetupPlan({ method: "git-only", remoteUrl: null, state: { isGitRepo: false } });
    expect(plan.gitSteps).toContain("git init");
  });

  it("no git-init when already a repo", () => {
    const plan = buildSetupPlan({ method: "git-only", remoteUrl: "https://github.com/me/b.git", state: { isGitRepo: true, hasRemote: false } });
    expect(plan.gitSteps).not.toContain("git init");
    expect(plan.gitSteps).toContain("add remote origin");
  });

  it("update remote when one already exists", () => {
    const plan = buildSetupPlan({ method: "git-only", remoteUrl: "https://github.com/me/b.git", state: { isGitRepo: true, hasRemote: true } });
    expect(plan.gitSteps).toContain("update remote origin");
  });

  it("obsidian-git method gives plugin instructions", () => {
    const plan = buildSetupPlan({ method: "obsidian-git", remoteUrl: "https://github.com/me/b.git", state: {} });
    expect(plan.deviceInstructions.join(" ")).toMatch(/Obsidian Git/i);
    expect(plan.deviceInstructions.join(" ")).toContain("github.com/me/b.git");
  });

  it("obsidian-sync method warns it cannot run on headless server", () => {
    const plan = buildSetupPlan({ method: "obsidian-sync", remoteUrl: "https://github.com/me/b.git", state: {} });
    expect(plan.warnings.join(" ")).toMatch(/headless/i);
    expect(plan.deviceInstructions.join(" ")).toMatch(/Sync/i);
  });

  it("warns when no remote URL given", () => {
    const plan = buildSetupPlan({ method: "git-only", remoteUrl: null, state: { isGitRepo: true } });
    expect(plan.warnings.join(" ")).toMatch(/remote/i);
    expect(plan.gitSteps).not.toContain("push -u origin (main)");
  });

  it("unknown method falls back to git-only with warning", () => {
    const plan = buildSetupPlan({ method: "bogus", remoteUrl: null, state: {} });
    expect(plan.method).toBe("git-only");
    expect(plan.warnings.join(" ")).toMatch(/unknown method/i);
  });

  it("all SYNC_METHODS produce a valid plan", () => {
    for (const method of SYNC_METHODS) {
      const plan = buildSetupPlan({ method, remoteUrl: "https://github.com/me/b.git", state: { isGitRepo: true, hasRemote: true } });
      expect(plan.deviceInstructions.length).toBeGreaterThan(0);
      expect(plan.method).toBe(method);
    }
  });
});

describe("sync config persistence", () => {
  let TMP;
  beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sync-")); });
  afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("readSyncConfig returns null when no file", () => {
    expect(readSyncConfig(TMP)).toBeNull();
  });

  it("saveSyncConfig writes and readSyncConfig reads it back", () => {
    const saved = saveSyncConfig({ method: "obsidian-git", remoteUrl: "https://github.com/me/b.git" }, TMP);
    expect(saved.method).toBe("obsidian-git");
    expect(saved.autoPush).toBe(true);
    expect(saved.configuredAt).toBeTruthy();

    const read = readSyncConfig(TMP);
    expect(read.method).toBe("obsidian-git");
    expect(read.remoteUrl).toBe("https://github.com/me/b.git");
  });

  it("saveSyncConfig defaults autoPush true, can be set false", () => {
    const saved = saveSyncConfig({ method: "git-only", remoteUrl: null, autoPush: false }, TMP);
    expect(saved.autoPush).toBe(false);
  });

  it("syncConfigPath points inside the vault", () => {
    expect(syncConfigPath(TMP)).toBe(path.join(TMP, ".secondbrain-sync.json"));
  });
});

describe("detectSyncState (injected runner)", () => {
  let TMP;
  beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sb-state-")); });
  afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("reports non-existent vault", () => {
    const s = detectSyncState("/nonexistent/path/xyz", () => null);
    expect(s.exists).toBe(false);
    expect(s.isGitRepo).toBe(false);
  });

  it("reports git repo with remote via injected runner", () => {
    const fakeRun = (cmd) => {
      if (cmd.includes("rev-parse")) return "true";
      if (cmd.includes("remote get-url")) return "https://github.com/me/b.git";
      return null;
    };
    const s = detectSyncState(TMP, fakeRun);
    expect(s.exists).toBe(true);
    expect(s.isGitRepo).toBe(true);
    expect(s.hasRemote).toBe(true);
    expect(s.remoteUrl).toBe("https://github.com/me/b.git");
  });

  it("reports git repo without remote", () => {
    const fakeRun = (cmd) => cmd.includes("rev-parse") ? "true" : null;
    const s = detectSyncState(TMP, fakeRun);
    expect(s.isGitRepo).toBe(true);
    expect(s.hasRemote).toBe(false);
  });
});

describe("buildSyncStatus", () => {
  it("guides to wizard when not a git repo", () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sb-status-"));
    try {
      const msg = buildSyncStatus(TMP, () => null);
      expect(msg).toMatch(/wizard/i);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  });

  it("shows remote + method when fully configured", () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sb-status2-"));
    try {
      saveSyncConfig({ method: "obsidian-git", remoteUrl: "https://github.com/me/b.git" }, TMP);
      const fakeRun = (cmd) => {
        if (cmd.includes("rev-parse")) return "true";
        if (cmd.includes("remote get-url")) return "https://github.com/me/b.git";
        return null;
      };
      const msg = buildSyncStatus(TMP, fakeRun);
      expect(msg).toContain("github.com/me/b.git");
      expect(msg).toMatch(/Obsidian Git/i);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  });
});
