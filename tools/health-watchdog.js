/**
 * health-watchdog.js — liveness assertions against silent failure.
 *
 * Ponyou's recurring failure mode is not crashing — it is running while dead:
 * paper exits silently skipped for 5 days, learning listeners killed by a
 * TypeError, the LLM unreachable for 8 days. Heartbeats and "started" log
 * lines all looked fine the whole time. This module asserts PROOF OF LIFE:
 * recent output, not recent existence.
 *
 * Read-only and alert-only by design: the watchdog never restarts, toggles,
 * or mutates anything. It reports transitions (alive→dead, dead→alive) to
 * Telegram, throttled, and serves an on-demand /alive report.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getAllAgentStatuses } from "../agents/agent-registry.js";
import { getState } from "../state.js";
import { getLastLlmSuccessTs } from "../llm-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Max heartbeat age per running agent before it counts as dead. Cron-driven
// agents get cron interval + slack; event-driven agents get a long leash.
const AGENT_CADENCE_MS = {
  management:  25 * 60 * 1000,        // 10m cron
  screening:   75 * 60 * 1000,        // 30m cron
  hunters:     75 * 60 * 1000,
  "trash-layer": 75 * 60 * 1000,
  default:     6 * 60 * 60 * 1000,    // event-driven (learning, portfolio, ...)
};

const CRITICAL_CHECKS = new Set(["book_frozen", "llm_liveness", "agent:management"]);

function _mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function _defaultDeps() {
  return {
    now: Date.now(),
    uptimeMs: process.uptime() * 1000,
    agentStatuses: getAllAgentStatuses(),
    state: getState(),
    lastLlmSuccessTs: getLastLlmSuccessTs(),
    maxPositions: config?.risk?.maxPositions ?? 3,
    frozenHours: config?.watchdog?.frozenHours ?? 6,
    fileMtime: _mtimeMs,
    paths: {
      learning: path.join(__dirname, "../open-trades-learning.json"),
      shadow:   path.join(__dirname, "../shadow-watchlist.json"),
      vaultDarwin: path.join(
        path.dirname(process.env.PONYOU_VAULT_NOTES_FILE || "/home/ubuntu/ponyou-brain/operator-notes.md"),
        "60-Learning", "_darwin.md",
      ),
    },
  };
}

const _fmtAge = (ms) => {
  if (ms == null) return "?";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
};

/**
 * Run every liveness assertion. Pure given deps — tests inject everything.
 * Returns [{ id, ok, critical, detail }].
 */
export function collectLiveness(overrides = {}) {
  const base = _defaultDeps();
  const d = { ...base, ...overrides, paths: { ...base.paths, ...(overrides.paths || {}) } };
  const checks = [];
  const push = (id, ok, detail) =>
    checks.push({ id, ok, critical: CRITICAL_CHECKS.has(id), detail });

  // ── 1. Agent heartbeats vs expected cadence ────────────────────────────
  for (const a of d.agentStatuses || []) {
    if (a.status !== "running") continue; // stopped/error agents surface elsewhere
    const limit = AGENT_CADENCE_MS[a.name] ?? AGENT_CADENCE_MS.default;
    const hb = a.lastHeartbeat ? Date.parse(a.lastHeartbeat) : null;
    const age = hb ? d.now - hb : null;
    const ok = age != null && age <= limit;
    push(`agent:${a.name}`, ok, ok
      ? `heartbeat ${_fmtAge(age)} ago`
      : `heartbeat ${_fmtAge(age)} ago (limit ${_fmtAge(limit)}) — agent claims running but isn't producing`);
  }

  // ── 2. Book frozen — the exact 06-05..06-10 freeze symptom ────────────
  // Positions at/over the limit AND no close for hours = exits are dead and
  // the bot can't trade. (A full book that recently closed something is fine.)
  {
    const positions = Object.values(d.state?.positions || {});
    const open = positions.filter(p => !p.closed).length;
    const closes = (d.state?.recentEvents || [])
      .filter(e => e.action === "close")
      .map(e => Date.parse(e.ts))
      .filter(Number.isFinite);
    const lastClose = closes.length ? Math.max(...closes) : null;
    const frozenMs = d.frozenHours * 60 * 60 * 1000;
    const frozen = open >= d.maxPositions
      && (lastClose == null || (d.now - lastClose) > frozenMs)
      && d.uptimeMs > frozenMs; // fresh boot can't have closed anything yet
    push("book_frozen", !frozen, frozen
      ? `book FULL (${open}/${d.maxPositions}) with no close in ${_fmtAge(lastClose ? d.now - lastClose : null)} — exit pipeline likely dead`
      : `open ${open}/${d.maxPositions}${lastClose ? `, last close ${_fmtAge(d.now - lastClose)} ago` : ""}`);
  }

  // ── 3. Learning writes — buys must leave a trace in the learning file ──
  {
    const deploys = (d.state?.recentEvents || [])
      .filter(e => e.action === "deploy")
      .map(e => Date.parse(e.ts))
      .filter(Number.isFinite);
    const lastDeploy = deploys.length ? Math.max(...deploys) : null;
    const recentDeploy = lastDeploy != null && (d.now - lastDeploy) < 24 * 60 * 60 * 1000;
    if (!recentDeploy) {
      push("learning_writes", true, "no buys in 24h — nothing to assert");
    } else {
      const mtime = d.fileMtime(d.paths.learning);
      // 5-min slack: the listener writes right after the deploy event
      const ok = mtime != null && mtime >= lastDeploy - 5 * 60 * 1000;
      push("learning_writes", ok, ok
        ? `learning file fresh (${_fmtAge(d.now - mtime)} ago)`
        : `buy ${_fmtAge(d.now - lastDeploy)} ago but learning file ${mtime ? `stale ${_fmtAge(d.now - mtime)}` : "missing"} — buy/exit listeners may be dead`);
    }
  }

  // ── 4. LLM liveness — a "running" LLM that never succeeds is dead ─────
  {
    const graceMs = 3 * 60 * 60 * 1000;
    const ts = d.lastLlmSuccessTs;
    if (ts == null) {
      // No success since boot: fine while young, dead once past the grace window.
      const ok = d.uptimeMs < graceMs;
      push("llm_liveness", ok, ok
        ? `no LLM call yet (uptime ${_fmtAge(d.uptimeMs)})`
        : `ZERO successful LLM calls in ${_fmtAge(d.uptimeMs)} uptime — provider unreachable or misconfigured`);
    } else {
      const age = d.now - ts;
      const ok = age <= graceMs;
      push("llm_liveness", ok, ok
        ? `last LLM success ${_fmtAge(age)} ago`
        : `last LLM success ${_fmtAge(age)} ago — provider likely down`);
    }
  }

  // ── 5/6. Snapshot freshness — crons that write files must keep writing ─
  for (const [id, file, limitMs] of [
    ["vault_freshness",  d.paths.vaultDarwin, 20 * 60 * 1000],  // 5m cron
    ["shadow_freshness", d.paths.shadow,      75 * 60 * 1000],  // 30m cycle
  ]) {
    const mtime = d.fileMtime(file);
    if (mtime == null) {
      push(id, d.uptimeMs < limitMs, `file not written yet (uptime ${_fmtAge(d.uptimeMs)})`);
      continue;
    }
    const age = d.now - mtime;
    push(id, age <= limitMs, age <= limitMs
      ? `fresh (${_fmtAge(age)} ago)`
      : `stale ${_fmtAge(age)} (limit ${_fmtAge(limitMs)}) — writer loop may be dead`);
  }

  return checks;
}

// ── Alerting on transitions, throttled ─────────────────────────────────────

const _alertState = new Map(); // id → { ok, lastAlertTs }

export function _resetWatchdogState() { _alertState.clear(); }

/**
 * Run one watchdog cycle: collect, diff against last cycle, send alerts for
 * new failures (re-alert while persisting, throttled) and recovery notes.
 * `send` is injected (telegram sendMessage) so this module stays import-light.
 */
export async function runWatchdogCycle({ send, overrides = {} } = {}) {
  if (config?.watchdog?.enabled === false) return null;
  let checks;
  try {
    checks = collectLiveness(overrides);
  } catch (e) {
    log("watchdog_error", `collect failed: ${e.message}`);
    return null;
  }

  const reAlertMs = (config?.watchdog?.reAlertHours ?? 6) * 60 * 60 * 1000;
  const now = overrides.now ?? Date.now();

  for (const c of checks) {
    const prev = _alertState.get(c.id) || { ok: true, lastAlertTs: 0 };
    if (!c.ok) {
      const isNew = prev.ok;
      const due = now - prev.lastAlertTs >= reAlertMs;
      if ((isNew || due) && typeof send === "function") {
        const icon = c.critical ? "🚨" : "⚠️";
        try {
          await send(`${icon} WATCHDOG ${isNew ? "DOWN" : "STILL DOWN"}: ${c.id}\n${c.detail}`);
        } catch (e) { log("watchdog_error", `alert send failed: ${e.message}`); }
        _alertState.set(c.id, { ok: false, lastAlertTs: now });
      } else if (isNew) {
        _alertState.set(c.id, { ok: false, lastAlertTs: now });
      }
      log("watchdog", `FAIL ${c.id}: ${c.detail}`);
    } else {
      if (!prev.ok && typeof send === "function") {
        try { await send(`✅ WATCHDOG RECOVERED: ${c.id}\n${c.detail}`); }
        catch (e) { log("watchdog_error", `recovery send failed: ${e.message}`); }
      }
      _alertState.set(c.id, { ok: true, lastAlertTs: prev.lastAlertTs });
    }
  }
  // One summary line per cycle even when all green — a watchdog whose health
  // is itself only inferable from silence would repeat the disease it treats.
  const fails = checks.filter(c => !c.ok).length;
  log("watchdog", `cycle: ${checks.length - fails}/${checks.length} alive${fails ? ` — FAILING: ${checks.filter(c => !c.ok).map(c => c.id).join(", ")}` : ""}`);
  return checks;
}

/** HTML table for the /alive Telegram command. */
export function formatLivenessReport(checks) {
  const fails = checks.filter(c => !c.ok).length;
  const lines = [
    `🫀 <b>Liveness</b> — ${checks.length - fails}/${checks.length} alive`,
  ];
  for (const c of checks) {
    const icon = c.ok ? "🟢" : c.critical ? "🚨" : "🔴";
    lines.push(`${icon} <b>${c.id}</b> — ${c.detail}`);
  }
  lines.push("", "<i>Bukti hidup = output nyata, bukan baris \"started\".</i>");
  return lines.join("\n");
}
