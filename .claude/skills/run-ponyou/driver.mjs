#!/usr/bin/env node --disable-warning=DEP0040
/**
 * Ponyou Driver — programmatic harness for the trading bot.
 *
 * Communicates with a running Ponyou instance via Dashboard IPC
 * (dashboard-cmd.json / dashboard-response.json). The bot polls
 * the command file every 3 seconds.
 *
 * Usage:
 *   node .claude/skills/run-ponyou/driver.mjs <command> [args]
 *
 * Commands:
 *   launch [demo|live]  Start Ponyou via supervisor
 *   stop                Graceful shutdown
 *   cmd <text>          Send a Telegram-format command (fire-and-forget; ack is generic)
 *   status              Print JSON state snapshot
 *   screenshot <path>   Write state snapshot as JSON file
 *   state <dot.path>    Read one field from the live snapshot (e.g. active-strategy.id)
 *   wait-ready [sec]    Wait for bot responsiveness
 *   is-running          Exit 0 if running
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CMD_FILE = join(ROOT, "dashboard-cmd.json");
const RESP_FILE = join(ROOT, "dashboard-response.json");
const RUN_SCRIPT = join(ROOT, "ops", "run-24x7.sh");

function log(msg) {
  process.stderr.write(`[driver] ${msg}\n`);
}

function isRunning() {
  try {
    const out = execSync(
      "ps aux | grep '[i]ndex.js' | grep -v dashboard | wc -l",
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Send a command via Dashboard IPC. The bot checks dashboard-cmd.json
 * every 3s, executes the command, and writes to dashboard-response.json.
 */
function sendCommandSync(text) {
  const id = `driver-${Date.now()}`;

  // Wait for any in-flight command to be consumed
  let waited = 0;
  while (existsSync(CMD_FILE) && waited < 6000) {
    // file still there → IPC hasn't consumed yet
    const wait = 500;
    execSync(`sleep 0.5`, { stdio: "ignore" });
    waited += wait;
  }

  // Clean stale response
  try { unlinkSync(RESP_FILE); } catch {}

  // Send
  writeFileSync(CMD_FILE, JSON.stringify({ cmd: text.trim(), id, args: [] }));

  // Wait for response (IPC polls every 3s)
  execSync("sleep 4", { stdio: "ignore" });

  // Read
  try {
    const raw = readFileSync(RESP_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { id, response: "(no response)", error: "response file not found" };
  }
}

function readStateSnapshot() {
  const snap = { timestamp: new Date().toISOString(), running: isRunning() };
  const files = {
    "active-strategy": "active-strategy.json",
    "trading-plan": "trading-plan.json",
    "performance": "performance.json",
    "metrics": "metrics.json",
    "state-summary": "state.json",
  };

  for (const [key, filename] of Object.entries(files)) {
    try {
      const path = join(ROOT, filename);
      if (!existsSync(path)) continue;
      let data = JSON.parse(readFileSync(path, "utf8"));
      // Truncate for readability
      if (key === "performance" && data.trades) {
        data._recent_trades = data.trades.slice(-5);
        data.trades = `(${data.trades.length} total, showing last 5)`;
      }
      if (key === "state-summary") {
        if (data.recentEvents) data.recentEvents = data.recentEvents.slice(-5);
        const open = Object.values(data.positions || {}).filter(p => !p?.closed);
        data._open_positions = open.length;
        data._positions = `(${Object.keys(data.positions || {}).length} total, ${open.length} open)`;
        delete data.positions; // too large
      }
      if (key === "metrics" && data.series) {
        data._series_keys = Object.keys(data.series);
      }
      snap[key] = data;
    } catch { /* file may not exist */ }
  }
  return snap;
}

// ─── Main ─────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "launch": {
      const mode = args[0] || "demo";
      if (isRunning()) {
        log(`Ponyou already running.`);
      } else {
        log(`Launching Ponyou in ${mode} mode via supervisor...`);
        spawn("bash", [RUN_SCRIPT, mode], {
          cwd: ROOT, detached: true, stdio: "ignore",
          env: { ...process.env, EXECUTION_MODE: mode === "live" ? "live" : "demo" },
        }).unref();
        // Wait for startup
        for (let i = 0; i < 20; i++) {
          execSync("sleep 1", { stdio: "ignore" });
          if (isRunning()) { log("Ponyou started."); break; }
        }
      }
      break;
    }

    case "stop":
      sendCommandSync("/off");
      log("Shutdown command sent.");
      break;

    case "cmd": {
      if (!args[0]) { log("Usage: driver.mjs cmd <text>"); process.exit(1); }
      const resp = sendCommandSync(args.join(" "));
      console.log(JSON.stringify(resp, null, 2));
      break;
    }

    case "status":
      console.log(JSON.stringify(readStateSnapshot(), null, 2));
      break;

    case "screenshot": {
      const outPath = args[0] || join(ROOT, "ponyou-screenshot.json");
      const dir = dirname(outPath);
      try { mkdirSync(dir, { recursive: true }); } catch {}
      writeFileSync(outPath, JSON.stringify(readStateSnapshot(), null, 2));
      log(`Screenshot saved to ${outPath} (${readFileSync(outPath).length} bytes)`);
      break;
    }

    case "state": {
      // Read a single field from the live snapshot, e.g.
      //   driver state active-strategy.id            → "scalping"
      //   driver state state-summary._open_positions → 3
      if (!args[0]) { log("Usage: driver.mjs state <dot.path>"); process.exit(1); }
      const snap = readStateSnapshot();
      const path = args[0].split(".");
      let cur = snap;
      for (const k of path) {
        if (cur == null || typeof cur !== "object") { cur = undefined; break; }
        cur = cur[k];
      }
      if (cur === undefined) { console.log("null"); process.exit(1); }
      console.log(typeof cur === "string" ? cur : JSON.stringify(cur));
      break;
    }

    case "wait-ready":
      for (let i = 0; i < (parseInt(args[0], 10) || 15); i++) {
        if (isRunning()) { log("ready"); process.exit(0); }
        execSync("sleep 1", { stdio: "ignore" });
      }
      log("timeout");
      process.exit(1);
      break;

    case "is-running":
      if (isRunning()) { log("RUNNING"); process.exit(0); }
      else { log("NOT RUNNING"); process.exit(1); }
      break;

    default:
      console.log(`Ponyou Driver
  launch [demo|live]   Start the bot
  stop                 Graceful shutdown
  cmd "/plan"          Send command (fire-and-forget ack)
  status               Print state snapshot
  screenshot [path]    Save state snapshot
  state <dot.path>     Read one field from snapshot
  wait-ready [sec]     Wait for bot
  is-running           Check if running`);
      process.exit(1);
  }
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exit(2);
}
