#!/usr/bin/env node
/**
 * promote-demo — graduate knowledge learned during paper trading (demo/) into
 * the LIVE stores, under your explicit control.
 *
 * Model: paper-trade in the isolated demo/ sandbox (see runtime-mode.js
 * applyPaperDataRedirect). When you're happy with the paper results, run this
 * to merge that knowledge into live — WITHOUT clobbering what live already knows.
 *
 * Merge policy = GAP-FILL:
 *   • new keys/coins/patterns the live corpus lacks → added from demo
 *   • keys that already exist in live → LIVE WINS (real data never overwritten)
 *   • arrays → union (demo items not already present are appended)
 *   • scalar aggregates (e.g. total_wins) → kept as live's (sim never inflates them)
 *
 * Only KNOWLEDGE stores are promotable. Runtime/safety/sim-specific stores
 * (positions, kill-switch, daily-guard, trading-plan session, execution-quality,
 * trade-attribution) are intentionally NOT promoted.
 *
 * Usage:
 *   node scripts/promote-demo.js --dry-run   # preview only, no writes
 *   node scripts/promote-demo.js             # promote (backs up live first)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEMO_DIR = path.join(ROOT, "demo");

// Knowledge stores worth graduating to live (filename in both root and demo/).
export const PROMOTABLE_FILES = [
  "coin-conviction.json",
  "profit-patterns.json",
  "loss-patterns.json",
  "lessons.json",
  "performance.json",
  "darwin-weights.json",
  "rug-memory.json",
  "rug-patterns-learned.json",
  "regime-memory.json",
];

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Gap-fill merge: returns { value, added }. `live` is mutated/returned; demo
 * only contributes what live is missing. Live always wins on leaf conflicts.
 */
export function mergeGapFill(live, demo) {
  if (Array.isArray(live) && Array.isArray(demo)) {
    const seen = new Set(live.map((x) => JSON.stringify(x)));
    let added = 0;
    for (const item of demo) {
      const k = JSON.stringify(item);
      if (!seen.has(k)) { live.push(item); seen.add(k); added++; }
    }
    return { value: live, added };
  }
  if (isPlainObject(live) && isPlainObject(demo)) {
    let added = 0;
    for (const key of Object.keys(demo)) {
      if (!(key in live)) {
        live[key] = demo[key];
        added++; // whole new branch
      } else {
        const r = mergeGapFill(live[key], demo[key]);
        live[key] = r.value;
        added += r.added;
      }
    }
    return { value: live, added };
  }
  // primitives / type mismatch → keep live
  return { value: live, added: 0 };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!fs.existsSync(DEMO_DIR)) {
    console.log("Nothing to promote — no demo/ directory (run paper trading first).");
    return;
  }

  console.log(`\n  Promote demo knowledge → live${dryRun ? "  [DRY RUN — no writes]" : ""}`);
  console.log("  " + "─".repeat(58));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let totalAdded = 0;
  let promoted = 0;

  for (const name of PROMOTABLE_FILES) {
    const demoFile = path.join(DEMO_DIR, name);
    const liveFile = path.join(ROOT, name);
    if (!fs.existsSync(demoFile)) continue; // nothing learned for this store

    const demo = readJson(demoFile);
    if (demo == null) { console.log(`  • ${name.padEnd(28)} skip (demo unreadable)`); continue; }

    const live = readJson(liveFile);
    let merged, added;
    if (live == null) {
      merged = demo; added = -1; // live absent → seed entirely from demo
    } else {
      const r = mergeGapFill(live, demo);
      merged = r.value; added = r.added;
    }

    if (added === 0) { console.log(`  • ${name.padEnd(28)} no new knowledge`); continue; }

    if (!dryRun) {
      if (live != null) {
        fs.copyFileSync(liveFile, `${liveFile}.bak-promote-${stamp}`); // backup live first
      }
      atomicWriteJson(liveFile, merged); // tmp+rename — never leave a half-written live store

    }
    const label = added === -1 ? "seeded (live was empty)" : `+${added} new entr${added === 1 ? "y" : "ies"}`;
    console.log(`  • ${name.padEnd(28)} ${label}${dryRun ? "  (would write)" : "  ✓"}`);
    promoted++;
    if (added > 0) totalAdded += added;
  }

  console.log("  " + "─".repeat(58));
  if (promoted === 0) {
    console.log("  Live is already up to date with demo — nothing to promote.\n");
  } else if (dryRun) {
    console.log(`  Would promote ${promoted} store(s), ~${totalAdded} new entries. Re-run without --dry-run to apply.\n`);
  } else {
    console.log(`  Promoted ${promoted} store(s), ~${totalAdded} new entries. Live backups saved as *.bak-promote-${stamp}.\n`);
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
