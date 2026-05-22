/**
 * state-pruner.js — Archive stale closed positions to keep state.json lean.
 *
 * Closed positions older than maxAgeDays are moved (appended) to
 * closed-positions-archive.json and removed from live state.
 *
 * Atomic sequence:
 *   1. Read full state via getState()
 *   2. Identify expired closed positions
 *   3. Append them to archive file
 *   4. Remove from state.positions and persist via setState()
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_FILE = path.join(__dirname, "closed-positions-archive.json");

/**
 * Move closed positions older than maxAgeDays from state.json to the archive.
 *
 * @param {number} maxAgeDays - Positions closed more than this many days ago are pruned. Default: 7.
 * @returns {{ pruned: number, archived: number }}
 */
export function pruneClosedPositions(maxAgeDays = 7) {
  const state = getState();
  const positions = state.positions || {};
  const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const archivedAt = new Date().toISOString();

  const toArchive = [];
  const toDelete = [];

  for (const [key, pos] of Object.entries(positions)) {
    if (!pos.closed) continue;
    if (!pos.closed_at) continue;
    const closedMs = new Date(pos.closed_at).getTime();
    if (isNaN(closedMs)) continue;
    if (now - closedMs > cutoffMs) {
      toArchive.push({ ...pos, archived_at: archivedAt });
      toDelete.push(key);
    }
  }

  if (toArchive.length === 0) {
    return { pruned: 0, archived: 0 };
  }

  // Step 1: append to archive file
  let existing = [];
  if (fs.existsSync(ARCHIVE_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  const merged = existing.concat(toArchive);
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(merged, null, 2));

  // Step 2: remove from live state and persist
  for (const key of toDelete) {
    delete positions[key];
  }
  // Persist synchronously by writing directly (mirrors the state module's save path
  // but avoids the async queue — pruner is called at startup before any concurrent writes).
  const STATE_FILE = path.join(__dirname, "state.json");
  state.lastUpdated = archivedAt;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  return { pruned: toArchive.length, archived: toArchive.length };
}
