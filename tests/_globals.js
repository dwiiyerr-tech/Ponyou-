// Vitest globalSetup — backs up production state files at session start
// and restores them at session end so tests cannot wipe live bot state.
// See: tests that write directly to repo-root JSON via __dirname/.. paths.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Files that tests overwrite or unlink at repo root. Keep this list aligned
// with any new test that touches a JSON in ROOT (see audit grep).
const GUARDED = [
  "trading-plan.json",
  "active-strategy.json",
  "strategies-overrides.json",
  "learning-state.json",
  "loss-analysis.json",
  "lessons.json",
  "performance.json",
  "rug-memory.json",
  "darwin-weights.json",
  "observed-tokens.json",
  "market-intel.json",
  "state.json",
  "vault-state.json",
  "automation-state.json",
  "automation-command.json",
  "supervisor-state.json",
  "supervisor-command.json",
];

export default function setup() {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-test-backup-"));
  const existed = new Set();
  for (const rel of GUARDED) {
    const src = path.join(ROOT, rel);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, rel));
      existed.add(rel);
    }
  }

  return () => {
    for (const rel of GUARDED) {
      const src = path.join(backupDir, rel);
      const dst = path.join(ROOT, rel);
      if (existed.has(rel)) {
        try { fs.copyFileSync(src, dst); } catch { /* best-effort */ }
      } else if (fs.existsSync(dst)) {
        // File didn't exist before tests; remove the test-created leftover
        try { fs.unlinkSync(dst); } catch { /* best-effort */ }
      }
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  };
}
