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

const LOG_CANDIDATES = [
  "logs/supervisor/agent-demo.log",
  "logs/supervisor/agent-live.log",
  "logs/agent.log",
];

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
  return { ts: Date.now(), tag: "INFO", text: raw };
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
