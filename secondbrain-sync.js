/**
 * secondbrain-sync.js — Second Brain (Obsidian vault) sync configuration.
 *
 * The bot ALWAYS treats a private GitHub repo as the source of truth it pushes
 * to (refresh-brain.js gitSync()). How the operator READS the vault on their
 * devices is a separate, layered choice:
 *
 *   - "obsidian-git"  : free Obsidian Git community plugin auto-pulls from GitHub
 *   - "obsidian-sync" : paid Obsidian Sync subscription (layered on a local clone)
 *   - "git-only"      : plain git clone / GitHub web, no Obsidian app
 *
 * This module holds the pure, testable logic. The interactive wizard lives in
 * scripts/setup-secondbrain.mjs and calls these helpers.
 *
 * Sync method + metadata is persisted to <vault>/.secondbrain-sync.json.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { atomicWriteJson } from "./atomic-write.js";

export const DEFAULT_VAULT_DIR = "/home/ubuntu/ponyou-brain";

export const SYNC_METHODS = ["obsidian-git", "obsidian-sync", "git-only"];

/** Resolve the vault directory (env override → default). */
export function getVaultDir() {
  const notesFile = process.env.PONYOU_VAULT_NOTES_FILE;
  if (notesFile) return path.dirname(notesFile);
  return process.env.PONYOU_VAULT_DIR || DEFAULT_VAULT_DIR;
}

/** Path to the sync config file inside the vault. */
export function syncConfigPath(vaultDir = getVaultDir()) {
  return path.join(vaultDir, ".secondbrain-sync.json");
}

/**
 * Validate a GitHub remote URL. Accepts:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 * Returns { valid, owner, repo, protocol } or { valid:false, reason }.
 */
export function validateRemoteUrl(url) {
  if (!url || typeof url !== "string") return { valid: false, reason: "empty" };
  const u = url.trim();

  // https
  let m = u.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return { valid: true, owner: m[1], repo: m[2], protocol: "https" };

  // scp-style ssh: git@github.com:owner/repo.git
  m = u.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return { valid: true, owner: m[1], repo: m[2], protocol: "ssh" };

  // ssh:// form
  m = u.match(/^ssh:\/\/git@github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return { valid: true, owner: m[1], repo: m[2], protocol: "ssh" };

  return { valid: false, reason: "not a recognised github URL (https/ssh)" };
}

/** Recommended .gitignore for an Obsidian vault synced to GitHub. */
export function buildVaultGitignore() {
  return [
    "# Obsidian workspace state (per-session, machine-specific — never sync)",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    "",
    "# Obsidian plugin local data that can carry tokens (Obsidian Git auth, etc.)",
    ".obsidian/plugins/obsidian-git/data.json",
    "",
    "# Refresh log (server-only, noisy)",
    ".refresh.log",
    "",
    "# OS cruft",
    ".DS_Store",
    "Thumbs.db",
    "",
  ].join("\n");
}

/**
 * Inspect the current sync state of a vault directory.
 * Pure read — no mutations. Uses an injectable runner so tests don't shell out.
 *
 * @param {string} vaultDir
 * @param {(cmd:string)=>string|null} run  — exec helper (returns trimmed stdout or null)
 */
export function detectSyncState(vaultDir = getVaultDir(), run = _defaultRun) {
  const exists = fs.existsSync(vaultDir);
  if (!exists) {
    return { exists: false, isGitRepo: false, hasRemote: false, remoteUrl: null, method: null };
  }
  const isGitRepo = !!run(`git -C "${vaultDir}" rev-parse --is-inside-work-tree`);
  const remoteUrl = isGitRepo ? run(`git -C "${vaultDir}" remote get-url origin`) : null;
  const cfg = readSyncConfig(vaultDir);
  return {
    exists: true,
    isGitRepo,
    hasRemote: !!remoteUrl,
    remoteUrl: remoteUrl || null,
    method: cfg?.method || null,
    configuredAt: cfg?.configuredAt || null,
  };
}

/** Read the persisted sync config (or null). */
export function readSyncConfig(vaultDir = getVaultDir()) {
  try {
    const p = syncConfigPath(vaultDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Persist the chosen sync config. Returns the written object.
 * @param {object} cfg  — { method, remoteUrl, ...extra }
 */
export function saveSyncConfig(cfg, vaultDir = getVaultDir()) {
  const out = {
    version: 1,
    method: cfg.method || "git-only",
    remoteUrl: cfg.remoteUrl || null,
    autoPush: cfg.autoPush !== false,
    configuredAt: new Date().toISOString(),
    ...(cfg.extra || {}),
  };
  atomicWriteJson(syncConfigPath(vaultDir), out);
  return out;
}

/**
 * Build the ordered list of setup steps for a chosen method.
 * Pure — returns a plan the wizard executes / prints. No side effects.
 */
export function buildSetupPlan({ method, remoteUrl, state }) {
  const plan = { gitSteps: [], deviceInstructions: [], warnings: [] };

  if (!SYNC_METHODS.includes(method)) {
    plan.warnings.push(`unknown method "${method}" — defaulting to git-only`);
    method = "git-only";
  }

  // Git side — identical for every method (bot always pushes to GitHub).
  if (!state?.isGitRepo) plan.gitSteps.push("git init");
  plan.gitSteps.push("write .gitignore");
  if (remoteUrl) {
    plan.gitSteps.push(state?.hasRemote ? "update remote origin" : "add remote origin");
  }
  plan.gitSteps.push("stage + initial commit");
  if (remoteUrl) plan.gitSteps.push("push -u origin (main)");

  // Device side — depends on chosen method.
  if (method === "obsidian-git") {
    plan.deviceInstructions = [
      "Di perangkat kamu, install Obsidian + community plugin 'Obsidian Git'.",
      `Clone repo private ini sebagai vault: ${remoteUrl || "<repo-url>"}`,
      "Obsidian Git → Settings → 'Auto pull interval' = 5 (menit).",
      "Bot push tiap refresh; Obsidian Git auto-pull → kamu lihat update otomatis.",
    ];
  } else if (method === "obsidian-sync") {
    plan.deviceInstructions = [
      "Obsidian Sync (berbayar) jalan di sisi perangkat, bukan di server headless.",
      `Di mesin lokal kamu: git clone ${remoteUrl || "<repo-url>"} sebagai vault.`,
      "Buka vault itu di Obsidian → Settings → Sync → aktifkan (butuh langganan).",
      "Obsidian Sync fan-out ke device lain (HP/tablet). GitHub = jembatan bot→lokal.",
      "Opsional: pasang juga Obsidian Git di mesin lokal untuk auto-pull dari bot.",
    ];
    plan.warnings.push("Obsidian Sync tidak bisa jalan di server headless — ia sinkron antar perangkat kamu, GitHub tetap jembatan dari bot.");
  } else {
    plan.deviceInstructions = [
      `Akses vault lewat GitHub web, atau: git clone ${remoteUrl || "<repo-url>"}`,
      "Tarik update manual dengan: git -C <vault> pull",
    ];
  }

  if (!remoteUrl) {
    plan.warnings.push("Tidak ada remote URL — bot menulis vault lokal saja, tidak push (gitSync no-op sampai remote diset).");
  }

  return { ...plan, method };
}

/** One-line human status for dashboard / CLI. */
export function buildSyncStatus(vaultDir = getVaultDir(), run = _defaultRun) {
  const s = detectSyncState(vaultDir, run);
  if (!s.exists) return "Vault belum ada — jalankan setup wizard.";
  if (!s.isGitRepo) return "Vault ada tapi belum git repo — jalankan setup wizard.";
  if (!s.hasRemote) return "Vault git repo, belum ada remote GitHub — push dinonaktifkan.";
  const methodLabel = { "obsidian-git": "Obsidian Git plugin", "obsidian-sync": "Obsidian Sync (berbayar)", "git-only": "Git only" }[s.method] || "belum dipilih";
  return `Sync: ${s.remoteUrl} | metode baca: ${methodLabel}`;
}

// Default exec runner (used outside tests).
function _defaultRun(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
