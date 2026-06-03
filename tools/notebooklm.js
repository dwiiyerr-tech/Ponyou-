/**
 * tools/notebooklm.js — Node.js ESM wrapper around scripts/notebooklm_client.py
 *
 * All exported functions degrade gracefully: they return null (never throw)
 * when the Python process fails, times out, or returns {"ok": false}.
 *
 * Auth is handled externally via Playwright cookie capture.
 * Storage path: PONYOU_NLM_STORAGE env var
 *               or ~/.notebooklm/profiles/default/storage_state.json
 *
 * Timeouts (ms):
 *   status / list  → 10 000
 *   ask            → 30 000
 *   upload_text    → 60 000
 */

import { execFile as _execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { log } from "../logger.js";

const execFile = promisify(_execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "../scripts/notebooklm_client.py");

const TIMEOUT_STATUS = 10_000;
const TIMEOUT_LIST   = 10_000;
const TIMEOUT_ASK    = 30_000;
const TIMEOUT_UPLOAD = 60_000;

// ── Storage path resolution ───────────────────────────────────────────────────

/**
 * Returns the absolute path to the Playwright storage state JSON.
 * Priority: PONYOU_NLM_STORAGE env → default location.
 */
export function getNlmStoragePath() {
  return (
    process.env.PONYOU_NLM_STORAGE ||
    path.join(os.homedir(), ".notebooklm", "profiles", "default", "storage_state.json")
  );
}

/**
 * Returns true if the storage state file exists (i.e. auth has been completed).
 */
export function isNlmConfigured() {
  try {
    return fs.existsSync(getNlmStoragePath());
  } catch {
    return false;
  }
}

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Run the Python CLI and return the parsed JSON result, or null on any error.
 *
 * @param {string[]} args   - positional + flag arguments after the script path
 * @param {number}   timeout - ms before we kill the child process
 * @returns {Promise<object|null>}
 */
async function runPy(args, timeout) {
  const storagePath = getNlmStoragePath();
  const fullArgs = [...args, "--storage", storagePath];

  let stdout;
  try {
    ({ stdout } = await execFile("python3", [SCRIPT, ...fullArgs], {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — for large notebook answers
      env: { ...process.env },
    }));
  } catch (err) {
    const detail = err.killed
      ? `timed out after ${timeout}ms`
      : (err.stderr || err.message || String(err)).slice(0, 300);
    log("notebooklm error", `exec failed [${args[0]}]: ${detail}`);
    return null;
  }

  const line = (stdout || "").trim().split("\n").pop() || "";
  if (!line) {
    log("notebooklm error", `no output from Python script [${args[0]}]`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (parseErr) {
    log("notebooklm error", `JSON parse failed [${args[0]}]: ${line.slice(0, 200)}`);
    return null;
  }

  if (!parsed.ok) {
    log(
      "notebooklm error",
      `command=${args[0]} error=${parsed.error} detail=${parsed.detail || ""}`,
    );
    return null;
  }

  return parsed;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check NotebookLM auth status.
 *
 * @returns {Promise<{ok: true, authenticated: boolean, email: string|null}|null>}
 */
export async function nlmStatus() {
  return runPy(["status"], TIMEOUT_STATUS);
}

/**
 * Find a notebook by title, or create it if it doesn't exist.
 *
 * @param {string} title
 * @returns {Promise<{ok: true, notebook_id: string, created: boolean}|null>}
 */
export async function nlmFindOrCreate(title) {
  if (!title || typeof title !== "string") {
    log("notebooklm error", "nlmFindOrCreate: title must be a non-empty string");
    return null;
  }
  return runPy(["find_or_create", title], TIMEOUT_LIST);
}

/**
 * Upload a plain-text source to a notebook.
 *
 * @param {string} notebookId  - notebook ID from nlmFindOrCreate / list
 * @param {string} title       - display name for the source
 * @param {string} content     - text content to upload
 * @returns {Promise<{ok: true, source_id: string}|null>}
 */
export async function nlmUploadText(notebookId, title, content) {
  if (!notebookId || !title || typeof content !== "string") {
    log("notebooklm error", "nlmUploadText: notebookId, title, and content are required");
    return null;
  }
  return runPy(["upload_text", notebookId, title, content], TIMEOUT_UPLOAD);
}

/**
 * Ask a question against a notebook.
 *
 * @param {string} notebookId
 * @param {string} question
 * @returns {Promise<{ok: true, answer: string, sources: Array}|null>}
 */
export async function nlmAsk(notebookId, question) {
  if (!notebookId || !question) {
    log("notebooklm error", "nlmAsk: notebookId and question are required");
    return null;
  }
  return runPy(["ask", notebookId, question], TIMEOUT_ASK);
}
