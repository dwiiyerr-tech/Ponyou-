/**
 * Dev (deployer) blocklist — persistent, mirrored into rug-memory.json so that
 * isDevBlocked() in lessons.js sees the same entries as the agent tools.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUG_FILE = path.join(__dirname, "rug-memory.json");

function loadMem() {
  if (!fs.existsSync(RUG_FILE)) {
    return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [], dev_meta: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(RUG_FILE, "utf8"));
    data.patterns ||= [];
    data.blacklisted_devs ||= [];
    data.blacklisted_tokens ||= [];
    data.dev_meta ||= {};
    return data;
  } catch {
    return { patterns: [], blacklisted_devs: [], blacklisted_tokens: [], dev_meta: {} };
  }
}

function saveMem(mem) {
  fs.writeFileSync(RUG_FILE, JSON.stringify(mem, null, 2));
}

export function blockDev({ address, reason = "" } = {}) {
  if (!address) return { error: "address required" };
  const mem = loadMem();
  if (!mem.blacklisted_devs.includes(address)) mem.blacklisted_devs.push(address);
  mem.dev_meta[address] = { reason, added_at: new Date().toISOString() };
  saveMem(mem);
  return { saved: true, address, reason };
}

export function unblockDev({ address } = {}) {
  if (!address) return { error: "address required" };
  const mem = loadMem();
  const before = mem.blacklisted_devs.length;
  mem.blacklisted_devs = mem.blacklisted_devs.filter(a => a !== address);
  delete mem.dev_meta[address];
  const removed = mem.blacklisted_devs.length !== before;
  if (removed) saveMem(mem);
  return { removed, address };
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
