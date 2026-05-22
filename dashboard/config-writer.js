import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

function cfgPath() { return path.join(BASE_PATH, "user-config.json"); }

export function maskPrivateKey(key) {
  if (!key || typeof key !== "string" || key.length < 8) return key || "";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function readConfig() {
  try {
    if (!fs.existsSync(cfgPath())) return {};
    const raw = JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
    if (raw.privateKey) raw.privateKey = maskPrivateKey(raw.privateKey);
    return raw;
  } catch { return {}; }
}

export function writeConfig(data) {
  const safe = { ...data };
  if (safe.privateKey && /…/.test(safe.privateKey)) delete safe.privateKey;
  let existing = {};
  try {
    if (fs.existsSync(cfgPath())) existing = JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
  } catch {}
  const merged = { ...existing, ...safe };
  atomicWriteJson(cfgPath(), merged);
}
