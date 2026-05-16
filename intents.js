/**
 * Pending Trade Intents — used by Confirm mode.
 *
 * When confirm mode is active, a buy attempt (gmgn_swap SOL → token)
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
  fs.writeFileSync(FILE, JSON.stringify(intents, null, 2));
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
  return loadAll().find(i => Number(i.id) === Number(id)) || null;
}

/**
 * Mark an intent as consumed (approved/rejected/expired/executed).
 * @returns {object|null} updated intent or null if not found / already consumed
 */
export function consumeIntent(id, status, extra = {}) {
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
