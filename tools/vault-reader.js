/**
 * vault-reader.js — reads operator-notes.md from the Obsidian vault and
 * returns parsed overrides. Cached for 5 minutes so screening cycles don't
 * re-read every run. Graceful: any error returns empty overrides.
 *
 * Env override: PONYOU_VAULT_NOTES_FILE (for tests)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const DEFAULT_VAULT_FILE = "/home/ubuntu/ponyou-brain/operator-notes.md";
const VAULT_FILE = process.env.PONYOU_VAULT_NOTES_FILE || DEFAULT_VAULT_FILE;
const CACHE_TTL_MS = 5 * 60_000;

let _cache = null;
let _cacheTs = 0;

function parseFrontmatter(content) {
  // Extract YAML between first pair of --- delimiters
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result = {};

  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const val = raw.trim();

    if (val === "true")  { result[key] = true;  continue; }
    if (val === "false") { result[key] = false; continue; }
    if (val === "null" || val === "") { result[key] = null; continue; }

    // Array: ["a", "b"] or ['a', 'b']
    const arr = val.match(/^\[([^\]]*)\]$/);
    if (arr) {
      result[key] = arr[1]
        .split(",")
        .map(s => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      continue;
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(val)) { result[key] = Number(val); continue; }

    // String (strip quotes)
    result[key] = val.replace(/^['"]|['"]$/g, "");
  }
  return result;
}

export function getVaultOverrides() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;

  try {
    const content = fs.readFileSync(VAULT_FILE, "utf8");
    const parsed = parseFrontmatter(content);
    _cache = {
      pause_trading:       parsed.pause_trading       === true,
      blacklist_tokens:    Array.isArray(parsed.blacklist_tokens)    ? parsed.blacklist_tokens.map(s => String(s).toUpperCase())    : [],
      blacklist_narratives:Array.isArray(parsed.blacklist_narratives) ? parsed.blacklist_narratives.map(s => String(s).toLowerCase()) : [],
      focus_narrative:     typeof parsed.focus_narrative === "string" ? parsed.focus_narrative.toLowerCase() : null,
      skip_mcap_above:     Number.isFinite(parsed.skip_mcap_above)   ? parsed.skip_mcap_above : null,
    };
    _cacheTs = Date.now();
  } catch (e) {
    // File missing or malformed — return empty overrides, never throw
    _cache = { pause_trading: false, blacklist_tokens: [], blacklist_narratives: [], focus_narrative: null, skip_mcap_above: null };
    _cacheTs = Date.now();
  }
  return _cache;
}

/** Force-expire cache (for tests) */
export function _resetVaultCache() { _cache = null; _cacheTs = 0; }
