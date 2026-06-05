/**
 * readLogs.ts — tail the bot's supervisor log and parse into typed lines.
 *
 * Log format (logger.js): "[ISO_TS] [TAG] message".
 * We read only the tail (~64KB) each poll, so it stays fast even when the
 * log is hundreds of MB. Works without a WebSocket — pure file read.
 */
import { existsSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { rootPath } from "./paths.js";
import type { LogLine } from "../types.js";

// Static fallback candidates (legacy paths)
const LOG_CANDIDATES_STATIC = [
  "logs/supervisor/agent-demo.log",
  "logs/supervisor/agent-live.log",
  "logs/agent.log",
];

// Daily log format: logs/agent-YYYY-MM-DD.log
function todayAndYesterday(): string[] {
  const d = new Date();
  const fmt = (dt: Date) => dt.toISOString().slice(0, 10);
  const yesterday = new Date(d.getTime() - 86_400_000);
  return [`logs/agent-${fmt(d)}.log`, `logs/agent-${fmt(yesterday)}.log`];
}

const LOG_CANDIDATES = [...todayAndYesterday(), ...LOG_CANDIDATES_STATIC];

const TAIL_BYTES = 64 * 1024;
const LINE_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/;

let _resolved: string | null = null;

function resolveLogPath(): string | null {
  for (const rel of LOG_CANDIDATES) {
    const p = rootPath(rel);
    if (existsSync(p)) { _resolved = p; return p; }
  }
  return null;
}

function parseLine(raw: string): LogLine | null {
  const m = raw.match(LINE_RE);
  if (m) {
    const ts = Date.parse(m[1]);
    return { ts: Number.isNaN(ts) ? Date.now() : ts, tag: m[2].toUpperCase(), text: m[3] };
  }
  if (!raw.trim()) return null;
  // R5: tag as UNKNOWN so log viewers can distinguish parse failures from real INFO.
  return { ts: Date.now(), tag: "UNKNOWN", text: raw };
}

function readTail(path: string): string {
  const size = statSync(path).size;
  if (size <= TAIL_BYTES) return readFileSync(path, "utf-8");
  const buf = Buffer.alloc(TAIL_BYTES);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf-8");
}

/** Read the last `limit` parsed log lines (newest last). */
export function readRecentLogs(limit = 200): LogLine[] {
  const p = resolveLogPath();
  if (!p) return [];
  try {
    return readTail(p)
      .split("\n")
      .map(parseLine)
      .filter((l): l is LogLine => l !== null)
      .slice(-limit);
  } catch {
    return [];
  }
}

export function logPath(): string | null {
  return _resolved || resolveLogPath();
}

export interface ErrorEntry {
  ts: string;
  category: string;
  msg: string;
  cycle: string;
  stack?: string;
}

export interface ErrorGroup {
  category: string;
  cycle: string;
  count: number;
  last: string;
  msgs: string[];
}

/** Read error-log.jsonl and group by category, sorted by count descending. */
export function readErrorGroups(maxLines = 500): ErrorGroup[] {
  const p = rootPath("error-log.jsonl");
  if (!existsSync(p)) return [];
  try {
    const raw = readTail(p);
    const entries: ErrorEntry[] = raw.trim().split("\n").filter(Boolean)
      .slice(-maxLines)
      .map(l => { try { return JSON.parse(l) as ErrorEntry; } catch { return null; } })
      .filter((e): e is ErrorEntry => e !== null);

    const map = new Map<string, ErrorGroup>();
    for (const e of entries) {
      const key = e.category;
      if (!map.has(key)) {
        map.set(key, { category: e.category, cycle: e.cycle || "unknown", count: 0, last: e.ts, msgs: [] });
      }
      const g = map.get(key)!;
      g.count++;
      if (e.ts > g.last) g.last = e.ts;
      if (g.msgs.length < 2 && !g.msgs.includes(e.msg)) g.msgs.push(e.msg);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}
