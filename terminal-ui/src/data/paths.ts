/**
 * paths.ts — resolve the Ponyou project root and store file locations.
 *
 * The TUI lives in <root>/terminal-ui, so root is one level up. In paper /
 * demo mode the bot writes some stores under a demo/ subdir; storePath()
 * honours that redirect so the TUI reads the same data the bot wrote.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root — env override wins (handy for tests / non-standard installs). */
export const ROOT = process.env.PONYOU_ROOT || resolve(__dirname, "..", "..", "..");

export function rootPath(name: string): string {
  return resolve(ROOT, name);
}

/** True when the bot is running in paper / demo mode. */
export function isPaperMode(config: Record<string, unknown> = {}): boolean {
  const mode = String(config.executionMode || process.env.EXECUTION_MODE || "").toLowerCase();
  return mode === "demo" || config.paperTrading === true || process.env.DRY_RUN === "true";
}

/** Resolve a store filename, redirecting to demo/ when in paper mode. */
export function storePath(name: string, paper: boolean): string {
  if (paper) {
    const demo = resolve(ROOT, "demo", name);
    if (existsSync(demo)) return demo;
  }
  return resolve(ROOT, name);
}

/** Read + parse JSON, returning fallback on any error. */
export function readJson<T>(fpath: string, fallback: T): T {
  try {
    if (!existsSync(fpath)) return fallback;
    return JSON.parse(readFileSync(fpath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}
