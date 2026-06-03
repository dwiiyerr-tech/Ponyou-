import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { withFileLock, atomicWriteText, atomicWriteTextAsync } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

function envPath() { return path.join(BASE_PATH, ".env"); }

// ── GMGN OpenAPI credential file (separate from the bot .env) ──────────────────
// gmgn-cli reads GMGN_API_KEY + GMGN_PRIVATE_KEY from ~/.config/gmgn/.env. The
// private key is an Ed25519 PEM used for LOCAL trade signing only. Env-overridable
// so tests don't touch the real homedir file.
function gmgnEnvDir() { return process.env.PONYOU_GMGN_ENV_DIR || path.join(os.homedir(), ".config", "gmgn"); }
function gmgnEnvPath() { return path.join(gmgnEnvDir(), ".env"); }

/** Which GMGN credentials are already present in ~/.config/gmgn/.env. */
export function gmgnKeyStatus() {
  try {
    const f = gmgnEnvPath();
    if (!fs.existsSync(f)) return { hasApiKey: false, hasPrivateKey: false };
    const c = fs.readFileSync(f, "utf8");
    return {
      hasApiKey: /^\s*GMGN_API_KEY\s*=\s*\S/m.test(c),
      hasPrivateKey: /GMGN_PRIVATE_KEY\s*=\s*"?\S/.test(c),
    };
  } catch { return { hasApiKey: false, hasPrivateKey: false }; }
}

/**
 * Upsert GMGN_PRIVATE_KEY (Ed25519 PEM) into ~/.config/gmgn/.env, preserving
 * GMGN_API_KEY and any other lines. The PEM is double-quoted (multiline; PEM
 * never contains a `"` so the existing-block removal is safe). File is written
 * 0600 — it holds a signing secret and must never be world-readable.
 */
export function writeGmgnPrivateKey(pem) {
  if (typeof pem !== "string" || !/PRIVATE KEY/.test(pem)) throw new Error("invalid Ed25519 PEM private key");
  // P3-6: validate base64 body decodes to a plausible key length (>= 32 bytes).
  // Previously any string containing "PRIVATE KEY" passed the check.
  try {
    const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const decoded = Buffer.from(b64, "base64");
    if (decoded.length < 32) throw new Error("decoded key too short");
  } catch {
    throw new Error("invalid Ed25519 PEM: base64 body does not decode to a valid key");
  }
  const dir = gmgnEnvDir();
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch {} // dir holds a signing secret
  let content = "";
  try { if (fs.existsSync(gmgnEnvPath())) content = fs.readFileSync(gmgnEnvPath(), "utf8"); } catch {}
  // Strip any existing GMGN_PRIVATE_KEY (quoted multiline OR bare single line).
  content = content.replace(/GMGN_PRIVATE_KEY\s*=\s*"[^"]*"\s*/g, "").replace(/^\s*GMGN_PRIVATE_KEY\s*=.*$/gm, "");
  content = content.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (content.length) content += "\n";
  content += `GMGN_PRIVATE_KEY="${pem.trimEnd()}"\n`;
  atomicWriteText(gmgnEnvPath(), content); // atomic temp+rename (atomic-write.js)
  try { fs.chmodSync(gmgnEnvPath(), 0o600); } catch {} // 0600 — never world-readable
}

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
