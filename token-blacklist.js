/**
 * Token blacklist — persistent, single source of truth in rug-memory.json.
 * Mirrored so screening filters (lessons.js scoreRugRisk / isTokenBlacklisted)
 * see the same data as the agent-callable tools.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUG_FILE = path.join(__dirname, "rug-memory.json");

function loadMem() {
  if (!fs.existsSync(RUG_FILE)) {
    return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [], blacklist_meta: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(RUG_FILE, "utf8"));
    data.patterns ||= [];
    data.blacklisted_devs ||= [];
    data.blacklisted_tokens ||= [];
    data.blacklist_meta ||= {};
    return data;
  } catch {
    return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [], blacklist_meta: {} };
  }
}

function saveMem(mem) {
  fs.writeFileSync(RUG_FILE, JSON.stringify(mem, null, 2));
}

export function addToBlacklist({ mint, reason = "" } = {}) {
  if (!mint) return { error: "mint required" };
  const mem = loadMem();
  if (!mem.blacklisted_tokens.includes(mint)) mem.blacklisted_tokens.push(mint);
  mem.blacklist_meta[mint] = { reason, added_at: new Date().toISOString() };
  saveMem(mem);
  return { saved: true, mint, reason };
}

export function removeFromBlacklist({ mint } = {}) {
  if (!mint) return { error: "mint required" };
  const mem = loadMem();
  const before = mem.blacklisted_tokens.length;
  mem.blacklisted_tokens = mem.blacklisted_tokens.filter(m => m !== mint);
  delete mem.blacklist_meta[mint];
  const removed = mem.blacklisted_tokens.length !== before;
  if (removed) saveMem(mem);
  return { removed, mint };
}

export function isBlacklisted(mint) {
  if (!mint) return false;
  return loadMem().blacklisted_tokens.includes(mint);
}

export function listBlacklist() {
  const mem = loadMem();
  return mem.blacklisted_tokens.map(mint => ({
    mint,
    ...(mem.blacklist_meta[mint] || {}),
  }));
}
