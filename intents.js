/**
 * Pending Trade Intents — used by Confirm mode.
 *
 * When confirm mode is active, a buy attempt (swap_token SOL → token)
 * is parked here instead of executing. A Telegram /yes <id> or /no <id>
 * later approves or rejects the intent.
 *
 * Storage: pending-intents.json (simple JSON array).
 * Intents expire after TTL_MIN minutes (default 5) — stale intents are
 * filtered out on every read.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "pending-intents.json");
const TTL_MIN_DEFAULT = 5;

function loadAll() {
  if (!fs.existsSync(FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return []; }
}

function saveAll(intents) {
  atomicWriteJson(FILE, intents);
}

function nextId(intents) {
  const max = intents.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
  return max + 1;
}

function isExpired(intent, now = Date.now()) {
  if (!intent.expires_at) return false;
  return now > new Date(intent.expires_at).getTime();
}

/**
 * Create a pending intent.
 * @param {{type: string, args: object, meta?: object, ttl_min?: number}} input
 * @returns {{id: number, expires_at: string}}
 */
export function createPendingIntent({ type, args, meta = {}, ttl_min = TTL_MIN_DEFAULT } = {}) {
  // INT-1: serialize the load → max-id → write under a file lock. Two
  // parallel callers (e.g., LLM and operator both creating a BUY intent
  // in the same tick) used to read the same baseline max and emit the
  // SAME id — money-related path, so the dedup must be tight.
  return withFileLock(FILE, async () => {
    const intents = loadAll();
    const id = nextId(intents);
    const created_at = new Date().toISOString();
    const expires_at = new Date(Date.now() + ttl_min * 60_000).toISOString();
    const intent = {
      id,
      type,
      args,
      meta,
      status: "pending",
      created_at,
      expires_at,
    };
    intents.push(intent);
    saveAll(intents);
    log("intent", `Created pending intent #${id} (${type})`);
    return intent;
  });
}

export function listPendingIntents() {
  const intents = loadAll();
  const now = Date.now();
  let changed = false;
  for (const i of intents) {
    if (i.status === "pending" && isExpired(i, now)) {
      i.status = "expired";
      changed = true;
    }
  }
  if (changed) saveAll(intents);
  return intents.filter(i => i.status === "pending");
}

export function getIntent(id) {
  const intents = loadAll();
  const intent = intents.find(i => Number(i.id) === Number(id)) || null;
  if (!intent) return null;
  // Lazy expire: if pending but past TTL, persist the new "expired" state so
  // every consumer of getIntent observes the same status.
  if (intent.status === "pending" && isExpired(intent)) {
    intent.status = "expired";
    intent.resolved_at = new Date().toISOString();
    saveAll(intents);
  }
  return intent;
}

/**
 * Mark an intent as consumed (approved/rejected/expired/executed).
 * @returns {object|null} updated intent or null if not found / already consumed
 */
export function consumeIntent(id, status, extra = {}) {
  // INT-1 (companion): consumeIntent also does load-modify-save and could
  // race with createPendingIntent or other consumeIntent calls. Lock so
  // the status transition is atomic.
  return withFileLock(FILE, async () => {
    const intents = loadAll();
    const idx = intents.findIndex(i => Number(i.id) === Number(id));
    if (idx === -1) return null;
    const intent = intents[idx];
    if (intent.status !== "pending") return null;
    intent.status = status;
    intent.resolved_at = new Date().toISOString();
    Object.assign(intent, extra);
    saveAll(intents);
    log("intent", `Intent #${id} → ${status}`);
    return intent;
  });
}

/**
 * Garbage-collect intents older than `keep_hours` (default 24).
 */
export function gcIntents(keep_hours = 24) {
  const intents = loadAll();
  const cutoff = Date.now() - keep_hours * 3600_000;
  const fresh = intents.filter(i => {
    const ts = new Date(i.created_at || 0).getTime();
    return ts >= cutoff;
  });
  if (fresh.length !== intents.length) saveAll(fresh);
  return intents.length - fresh.length;
}
