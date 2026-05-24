import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
export const AUTOMATION_STATE_PATH = path.join(__dirname, "automation-state.json");
export const AUTOMATION_COMMAND_PATH = path.join(__dirname, "automation-command.json");
export const SUPERVISOR_STATE_PATH = path.join(__dirname, "supervisor-state.json");
export const SUPERVISOR_COMMAND_PATH = path.join(__dirname, "supervisor-command.json");

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  atomicWriteJson(file, value);
}

export function readUserConfig() {
  return readJson(USER_CONFIG_PATH, {}) || {};
}

export async function persistAutomationPreference(enabled) {
  return withFileLock(USER_CONFIG_PATH, async () => {
    const cfg = readUserConfig();
    cfg.automationEnabled = !!enabled;
    writeJson(USER_CONFIG_PATH, cfg);
    return cfg;
  });
}

export function readAutomationState() {
  return readJson(AUTOMATION_STATE_PATH, {
    enabled: false,
    cronStarted: false,
    telegramPolling: false,
    source: "unknown",
    updatedAt: null,
  }) || {};
}

export async function publishAutomationState(state = {}) {
  return withFileLock(AUTOMATION_STATE_PATH, async () => {
    const current = readAutomationState();
    const next = {
      ...current,
      ...state,
      enabled: !!(state.enabled ?? current.enabled),
      cronStarted: !!(state.cronStarted ?? current.cronStarted),
      telegramPolling: !!(state.telegramPolling ?? current.telegramPolling),
      source: state.source || current.source || "runtime",
      updatedAt: new Date().toISOString(),
    };
    writeJson(AUTOMATION_STATE_PATH, next);
    return next;
  });
}

export function issueAutomationCommand({ action = "set_enabled", enabled = null, source = "agent" } = {}) {
  const cmd = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    action,
    enabled: enabled == null ? null : !!enabled,
    source,
    issuedAt: new Date().toISOString(),
  };
  writeJson(AUTOMATION_COMMAND_PATH, cmd);
  return cmd;
}

export function readAutomationCommand() {
  return readJson(AUTOMATION_COMMAND_PATH, null);
}

export function readSupervisorState() {
  return readJson(SUPERVISOR_STATE_PATH, {
    desiredRunning: false,
    agentRunning: false,
    pid: null,
    mode: null,
    updatedAt: null,
    source: "unknown",
  }) || {};
}

export async function publishSupervisorState(state = {}) {
  return withFileLock(SUPERVISOR_STATE_PATH, async () => {
    const current = readSupervisorState();
    const next = {
      ...current,
      ...state,
      desiredRunning: !!(state.desiredRunning ?? current.desiredRunning),
      agentRunning: !!(state.agentRunning ?? current.agentRunning),
      pid: state.pid ?? current.pid ?? null,
      mode: state.mode ?? current.mode ?? null,
      source: state.source || current.source || "supervisor",
      updatedAt: new Date().toISOString(),
    };
    writeJson(SUPERVISOR_STATE_PATH, next);
    return next;
  });
}

export function issueSupervisorCommand({ action = "set_power", enabled = null, source = "agent" } = {}) {
  const cmd = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    action,
    enabled: enabled == null ? null : !!enabled,
    source,
    issuedAt: new Date().toISOString(),
  };
  writeJson(SUPERVISOR_COMMAND_PATH, cmd);
  return cmd;
}

export function readSupervisorCommand() {
  return readJson(SUPERVISOR_COMMAND_PATH, null);
}
