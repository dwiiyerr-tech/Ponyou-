// Vitest globalSetup — backs up production state files at session start
// and restores them at session end so tests cannot wipe live bot state.
// See: tests that write directly to repo-root JSON via __dirname/.. paths.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// State tmp dir — must match STATE_TMP in vitest.config.js. Production state
// files (collab stores, kill-switch flag/state, daily-guard state) are
// redirected here via test.env so tests never touch the live ones; we just
// ensure the dir exists (appendFileSync/withFileLock don't mkdir) and clean
// it up afterwards.
const STATE_TMP = path.join(os.tmpdir(), "ponyou-vitest-state");

// Files that tests overwrite or unlink. Relative to ROOT; subdirectory paths
// are supported (backup filenames are flattened). Keep aligned with any new
// test that writes a JSON under ROOT (see audit grep).
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
  "market-chain-intel.json",
  "state.json",
  "vault-state.json",
  "automation-state.json",
  "automation-command.json",
  "supervisor-state.json",
  "supervisor-command.json",
  // Collab layer + safety rails — now redirected to STATE_TMP via test.env, so
  // they should no longer be touched; guarded as belt-and-suspenders in case a
  // test hardcodes a path or the env override fails to propagate.
  "shared-agent-memory.jsonl",
  "infra/agent-collab/orchestrator-state.json",
  "infra/agent-collab/experiments.json",
  "infra/agent-collab/experiment-runs.jsonl",
  "infra/agent-collab/semantic-memory.jsonl",
  "kill-switch.flag",
  "kill-switch-state.json",
  "daily-trade-guard-state.json",
  "metrics.json",
  "trade-attribution.json",
  "coin-conviction.json",
  "profit-patterns.json",
  "loss-patterns.json",
];

// Flatten a (possibly nested) relative path into a safe flat backup filename.
const backupName = (rel) => rel.replace(/[/\\]/g, "__");

export default function setup() {
  fs.mkdirSync(STATE_TMP, { recursive: true });

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-test-backup-"));
  const existed = new Set();
  for (const rel of GUARDED) {
    const src = path.join(ROOT, rel);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, backupName(rel)));
      existed.add(rel);
    }
  }

  return () => {
    for (const rel of GUARDED) {
      const src = path.join(backupDir, backupName(rel));
      const dst = path.join(ROOT, rel);
      if (existed.has(rel)) {
        try { fs.copyFileSync(src, dst); } catch { /* best-effort */ }
      } else if (fs.existsSync(dst)) {
        // File didn't exist before tests; remove the test-created leftover
        try { fs.unlinkSync(dst); } catch { /* best-effort */ }
      }
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(STATE_TMP, { recursive: true, force: true }); } catch {}
  };
}
