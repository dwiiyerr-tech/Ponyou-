/**
 * Dev (deployer) blocklist — persistent, mirrored into rug-memory.json so that
 * isDevBlocked() in lessons.js sees the same entries as the agent tools.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUG_FILE = path.join(__dirname, "rug-memory.json");

let _cachedMem = null;
let _cachedMtime = 0;
let _lastStatTime = 0;

function loadMem() {
  try {
    const now = Date.now();
    if (_cachedMem && (now - _lastStatTime < 1000)) {
      return _cachedMem;
    }
    if (!fs.existsSync(RUG_FILE)) {
      _cachedMem = null;
      _cachedMtime = 0;
      _lastStatTime = now;
      return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [], dev_meta: {} };
    }
    const stat = fs.statSync(RUG_FILE);
    _lastStatTime = now;
    if (_cachedMem && stat.mtimeMs === _cachedMtime) {
      return _cachedMem;
    }
    const data = JSON.parse(fs.readFileSync(RUG_FILE, "utf8"));
    data.patterns ||= [];
    data.blacklisted_devs ||= [];
    data.blacklisted_tokens ||= [];
    data.dev_meta ||= {};
    _cachedMem = data;
    _cachedMtime = stat.mtimeMs;
    return data;
  } catch {
    return _cachedMem || { patterns: [], blacklisted_devs: [], blacklisted_tokens: [], dev_meta: {} };
  }
}

function saveMem(mem) {
  atomicWriteJson(RUG_FILE, mem);
  _cachedMem = mem;
  try {
    _cachedMtime = fs.statSync(RUG_FILE).mtimeMs;
  } catch {
    _cachedMtime = Date.now();
  }
}

export async function blockDev({ address, reason = "" } = {}) {
  if (!address) return { error: "address required" };
  return withFileLock(RUG_FILE, async () => {
    const mem = JSON.parse(JSON.stringify(loadMem()));
    if (!mem.blacklisted_devs.includes(address)) mem.blacklisted_devs.push(address);
    mem.dev_meta[address] = { reason, added_at: new Date().toISOString() };
    saveMem(mem);
    return { saved: true, address, reason };
  });
}

export async function unblockDev({ address } = {}) {
  if (!address) return { error: "address required" };
  return withFileLock(RUG_FILE, async () => {
    const mem = JSON.parse(JSON.stringify(loadMem()));
    const before = mem.blacklisted_devs.length;
    mem.blacklisted_devs = mem.blacklisted_devs.filter(a => a !== address);
    delete mem.dev_meta[address];
    const removed = mem.blacklisted_devs.length !== before;
    if (removed) saveMem(mem);
    return { removed, address };
  });
}

export function isBlockedDev(address) {
  if (!address) return false;
  return loadMem().blacklisted_devs.includes(address);
}

export function listBlockedDevs() {
  const mem = loadMem();
  return mem.blacklisted_devs.map(addr => ({
    address: addr,
    ...(mem.dev_meta[addr] || {}),
  }));
}

export const listBlockedDeployers = listBlockedDevs;
