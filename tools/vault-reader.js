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

// ─── Vault context (Level B) ──────────────────────────────────────────────
// Compact "[VAULT CONTEXT]" block injected into the LLM screening prompt so
// the agent sees operator notes, recent decisions, and active experiments.
// Separate 5-minute cache from getVaultOverrides(). Never throws.
let _ctxCache = null;
let _ctxCacheTs = 0;

function _truncLine(s, n = 120) {
  if (typeof s !== "string") return s;
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function getVaultContext() {
  if (_ctxCacheTs && (Date.now() - _ctxCacheTs) < CACHE_TTL_MS) return _ctxCache;

  try {
    // Resolve the notes path at call time so tests can repoint the env var
    // after module load (VAULT_FILE is a load-time const).
    const notesFile = process.env.PONYOU_VAULT_NOTES_FILE || VAULT_FILE;
    const vaultDir = path.dirname(notesFile);
    const lines = [];

    // 1. Operator line from operator-notes.md frontmatter
    try {
      const fm = parseFrontmatter(fs.readFileSync(notesFile, "utf8"));
      const notes = typeof fm.notes === "string" ? fm.notes.trim() : "";
      const focus = typeof fm.focus_narrative === "string" && fm.focus_narrative ? fm.focus_narrative : null;
      const blTokens = Array.isArray(fm.blacklist_tokens) ? fm.blacklist_tokens : [];
      if (notes || focus || blTokens.length > 0) {
        const parts = [];
        if (notes) parts.push(notes);
        if (focus) parts.push(`focus=${focus}`);
        if (blTokens.length > 0) parts.push(`blacklist=${blTokens.join(",")}`);
        lines.push(_truncLine(`Operator: ${parts.join(" | ")}`));
      }
    } catch { /* no operator line */ }

    // 2. Decisions: 3 most recent markdown files (by filename date, desc)
    try {
      const decDir = path.join(vaultDir, "05-Decisions");
      const files = fs.readdirSync(decDir)
        .filter(f => f.endsWith(".md") && !f.startsWith("_"))
        .sort()
        .reverse()
        .slice(0, 3);
      const parts = [];
      for (const f of files) {
        const dm = f.match(/(\d{4}-\d{2}-\d{2})/);
        const date = dm ? dm[1] : f.replace(/\.md$/, "");
        let title = "";
        try {
          const h1 = fs.readFileSync(path.join(decDir, f), "utf8").match(/^#\s+(.+)$/m);
          if (h1) title = h1[1].replace(/^Decision:\s*/i, "").trim();
        } catch { /* skip title */ }
        parts.push(title ? `${date}: ${title}` : date);
      }
      if (parts.length > 0) lines.push(_truncLine(`Decisions: ${parts.join(", ")}`));
    } catch { /* no decisions line */ }

    // 3. Experiments: exp-*.md files that carry a non-empty status tag
    try {
      const expDir = path.join(vaultDir, "02-Experiments");
      const files = fs.readdirSync(expDir)
        .filter(f => f.startsWith("exp-") && f.endsWith(".md"))
        .sort();
      const parts = [];
      for (const f of files) {
        let status = "";
        try {
          const fm = parseFrontmatter(fs.readFileSync(path.join(expDir, f), "utf8"));
          status = typeof fm.status === "string" ? fm.status.trim() : "";
        } catch { /* skip */ }
        if (!status) continue;
        parts.push(`${f.replace(/\.md$/, "")} (${status.toUpperCase()})`);
      }
      if (parts.length > 0) lines.push(_truncLine(`Experiments: ${parts.join(", ")}`));
    } catch { /* no experiments line */ }

    _ctxCache = lines.length === 0 ? null : `[VAULT CONTEXT]\n${lines.join("\n")}\n[/VAULT CONTEXT]`;
    _ctxCacheTs = Date.now();
  } catch {
    _ctxCache = null;
    _ctxCacheTs = Date.now();
  }
  return _ctxCache;
}

/** Force-expire vault-context cache (for tests) */
export function _resetVaultContextCache() { _ctxCache = null; _ctxCacheTs = 0; }
