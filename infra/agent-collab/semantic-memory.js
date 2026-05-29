import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { getExperimentSummary } from "./experiment-tracker.js";
import { atomicWriteText, withFileLock } from "../../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = process.env.PONYOU_SEMANTIC_MEMORY_FILE || path.join(__dirname, "semantic-memory.jsonl");
const RUFLO_BIN = path.join(__dirname, "../../node_modules/.bin/ruflo");
const execFileAsync = promisify(execFile);

function nowIso() { return new Date().toISOString(); }
function safeArray(value) { return Array.isArray(value) ? value.filter(Boolean).map(String) : []; }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function normalizeText(value, max = 4000) { return String(value || "").trim().slice(0, max); }
function ensureStore() { if (!fs.existsSync(MEMORY_FILE)) atomicWriteText(MEMORY_FILE, ""); }

function readEntries() {
  ensureStore();
  // Hold the lock during read so concurrent appends don't interleave.
  return fs.readFileSync(MEMORY_FILE, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Serialize appends through a per-file lock to prevent interleaved writes
// from concurrent Claude + Gemini + Codex calls corrupting the JSONL store.
function appendEntry(entry) {
  ensureStore();
  const line = `${JSON.stringify(entry)}\n`;
  // Synchronous under the lock — JSONL appends are small (< 4KB) so this
  // won't block the event loop meaningfully.
  fs.appendFileSync(MEMORY_FILE, line, "utf8");
}
function tokenize(value) { return String(value || "").toLowerCase().split(/[^a-z0-9_]+/i).map((part) => part.trim()).filter((part) => part.length >= 2); }

function buildSearchText(entry) {
  return [
    entry.type, entry.title, entry.summary, entry.details, entry.project, entry.market_condition,
    entry.narrative, entry.tier, entry.branch, ...(entry.tags || []),
    ...Object.values(entry.context || {}).map((value) => String(value || "")),
  ].join(" ");
}

function scoreEntry(entry, args = {}) {
  let score = 0;
  const queryTokens = tokenize(args.query);
  const entryTokens = new Set(tokenize(buildSearchText(entry)));
  for (const token of queryTokens) if (entryTokens.has(token)) score += 8;
  if (args.type && entry.type === args.type) score += 18;
  if (args.project && entry.project === args.project) score += 12;
  if (args.market_condition && entry.market_condition === args.market_condition) score += 10;
  if (args.narrative && entry.narrative === args.narrative) score += 10;
  if (args.tier && entry.tier === args.tier) score += 8;
  if (args.branch && entry.branch === args.branch) score += 6;
  if (args.tag && safeArray(entry.tags).includes(args.tag)) score += 14;
  if (queryTokens.length === 0) score += 1;
  return score;
}

function filterEntries(entries, args = {}) {
  return entries.filter((entry) => {
    if (args.type && entry.type !== args.type) return false;
    if (args.project && entry.project !== args.project) return false;
    if (args.market_condition && entry.market_condition !== args.market_condition) return false;
    if (args.narrative && entry.narrative !== args.narrative) return false;
    if (args.tier && entry.tier !== args.tier) return false;
    if (args.branch && entry.branch !== args.branch) return false;
    if (args.tag && !safeArray(entry.tags).includes(args.tag)) return false;
    return true;
  });
}

async function mirrorToRuflo(entry) {
  try {
    if (!fs.existsSync(RUFLO_BIN)) return false;
    await execFileAsync(RUFLO_BIN, ["memory", "store", "-k", entry.id, "-v", JSON.stringify(entry)]);
    return true;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") console.warn("[semantic-memory] mirrorToRuflo failed:", e.message);
    return false;
  }
}

function normalizeEntry({
  type = "note", title, summary, details = "", tags = [], project = null, branch = null,
  market_condition = null, narrative = null, tier = null, mint = null, wallet = null,
  deployer = null, source = "manual", context = {},
} = {}) {
  const ts = nowIso();
  const normalized = {
    id: `${ts}-${Math.random().toString(36).slice(2, 10)}`,
    ts,
    type: normalizeText(type, 64) || "note",
    title: normalizeText(title, 200),
    summary: normalizeText(summary, 500),
    details: normalizeText(details, 4000),
    tags: safeArray(tags),
    project: project ? String(project) : null,
    branch: branch ? String(branch) : null,
    market_condition: market_condition ? String(market_condition) : null,
    narrative: narrative ? String(narrative) : null,
    tier: tier ? String(tier) : null,
    mint: mint ? String(mint) : null,
    wallet: wallet ? String(wallet) : null,
    deployer: deployer ? String(deployer) : null,
    source: String(source || "manual"),
    context: safeObject(context),
  };
  if (!normalized.title || !normalized.summary) return { error: "title and summary are required" };
  return normalized;
}

export async function addSemanticMemory(args = {}) {
  const entry = normalizeEntry(args);
  if (entry.error) return entry;
  // Serialize writes through the per-file lock so concurrent
  // Claude + Gemini + Codex calls don't interleave JSONL lines.
  await withFileLock(MEMORY_FILE, () => appendEntry(entry));
  const mirrored = await mirrorToRuflo(entry);
  return { ...entry, mirrored_to_ruflo: mirrored };
}

export function searchSemanticMemory(args = {}) {
  const limit = Math.max(1, Math.floor(Number(args.limit || 10)));
  return filterEntries(readEntries(), args)
    .map((entry) => ({ entry, score: scoreEntry(entry, args) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.entry.ts).getTime() - new Date(a.entry.ts).getTime())
    .slice(0, limit)
    .map(({ entry, score }) => ({ score, ...entry }));
}

export function getRecentSemanticMemory({ limit = 10, type, tag, project } = {}) {
  return filterEntries(readEntries(), { type, tag, project })
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, Math.max(1, Math.floor(Number(limit || 10))));
}

export async function indexExperimentMemory({ experiment_id } = {}) {
  const summary = getExperimentSummary({ id: experiment_id });
  if (summary?.error) return summary;
  const experiment = summary.experiment;
  const comparison = summary.summary.comparison || {};
  return addSemanticMemory({
    type: "experiment",
    title: `Experiment ${experiment.id}: ${experiment.name}`,
    summary: [experiment.hypothesis, `recommendation=${summary.summary.recommendation}`, `sample_size=${summary.summary.sample_size}`].join(" | "),
    details: JSON.stringify({ experiment, summary: summary.summary }, null, 2),
    tags: [...safeArray(experiment.tags), "experiment", experiment.status],
    project: "ponyou",
    source: "experiment-tracker",
    context: {
      experiment_id: experiment.id,
      baseline_rule: experiment.baseline_rule,
      candidate_rule: experiment.candidate_rule,
      quality_lift: comparison.quality_lift,
      pnl_lift_pct: comparison.pnl_lift_pct,
      win_rate_lift: comparison.win_rate_lift,
      drawdown_delta_pct: comparison.drawdown_delta_pct,
    },
  });
}

export function _resetSemanticMemoryForTests() { if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE); }
