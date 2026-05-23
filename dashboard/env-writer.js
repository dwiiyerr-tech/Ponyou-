import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { withFileLock, atomicWriteTextAsync } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

function envPath() { return path.join(BASE_PATH, ".env"); }

export const WALLET_ENV_PATTERN = /^WALLET_KEY_(?:10|[1-9])$/;

/**
 * Parse .env into a Map preserving insertion order. Skips comments and blanks.
 * Does NOT expand escapes (matches `dotenv` defaults for our use case).
 */
export function readEnv() {
  const file = envPath();
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) map.set(k, v);
  }
  return map;
}

function serialize(map) {
  const lines = [];
  for (const [k, v] of map) lines.push(`${k}=${v}`);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/**
 * Atomically update WALLET_KEY_1..10 in .env. Non-wallet keys are preserved.
 * `keys` is an object: { WALLET_KEY_1: "bs58...", WALLET_KEY_3: "" }.
 * Empty/null value deletes the entry. Keys outside WALLET_KEY_1..10 are
 * silently ignored to keep the write surface small.
 *
 * Returns { written: number, deleted: number }.
 */
export async function writeWalletKeys(keys = {}) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("writeWalletKeys: keys must be an object");
  }
  return withFileLock(envPath(), async () => {
    const current = readEnv();
    let written = 0;
    let deleted = 0;
    for (const [k, raw] of Object.entries(keys)) {
      if (!WALLET_ENV_PATTERN.test(k)) continue;
      const v = raw == null ? "" : String(raw).trim();
      if (v) {
        const prev = current.get(k);
        current.set(k, v);
        if (prev !== v) written++;
      } else if (current.has(k)) {
        current.delete(k);
        deleted++;
      }
    }
    const text = serialize(current);
    const target = envPath();
    await atomicWriteTextAsync(target, text);
    try { await fs.promises.chmod(target, 0o600); } catch { /* best-effort */ }
    return { written, deleted };
  });
}

/**
 * Return which WALLET_KEY_1..10 slots currently have a value set in .env.
 * Never returns the plaintext value — only existence.
 */
export function walletKeyStatus() {
  const env = readEnv();
  const slots = [];
  for (let i = 1; i <= 10; i++) {
    const name = `WALLET_KEY_${i}`;
    slots.push({ index: i, env_ref: name, has_key: Boolean(env.get(name)) });
  }
  return { slots };
}
