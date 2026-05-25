import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_STATE = path.join(__dirname, "..", "automation-state.json");
const AUTOMATION_CMD = path.join(__dirname, "..", "automation-command.json");
const SUPERVISOR_STATE = path.join(__dirname, "..", "supervisor-state.json");
const SUPERVISOR_CMD = path.join(__dirname, "..", "supervisor-command.json");

function cleanFiles() {
  for (const f of [AUTOMATION_STATE, AUTOMATION_CMD, SUPERVISOR_STATE, SUPERVISOR_CMD]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

beforeEach(cleanFiles);
afterEach(cleanFiles);

describe("automation-control — functions export", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../automation-control.js");
    expect(typeof mod.readUserConfig).toBe("function");
    expect(typeof mod.readAutomationState).toBe("function");
    expect(typeof mod.publishAutomationState).toBe("function");
    expect(typeof mod.issueAutomationCommand).toBe("function");
    expect(typeof mod.readAutomationCommand).toBe("function");
    expect(typeof mod.readSupervisorState).toBe("function");
    expect(typeof mod.publishSupervisorState).toBe("function");
    expect(typeof mod.issueSupervisorCommand).toBe("function");
    expect(typeof mod.readSupervisorCommand).toBe("function");
  });
});

describe("automation-control — readAutomationState", () => {
  it("returns default state when no file exists", async () => {
    const { readAutomationState } = await import("../automation-control.js");
    const state = readAutomationState();
    expect(state.enabled).toBe(false);
    expect(state.cronStarted).toBe(false);
    expect(state.telegramPolling).toBe(false);
  });
});

describe("automation-control — publishAutomationState", () => {
  it("publishes state and returns merged result", async () => {
    const { publishAutomationState, readAutomationState } = await import("../automation-control.js");
    const result = await publishAutomationState({ enabled: true, source: "test" });
    expect(result.enabled).toBe(true);
    expect(result.source).toBe("test");
    expect(result.updatedAt).toBeTruthy();
    // Verify persistence
    const state = readAutomationState();
    expect(state.enabled).toBe(true);
  });
});

describe("automation-control — issueAutomationCommand", () => {
  it("creates a command with id and timestamp", async () => {
    const { issueAutomationCommand, readAutomationCommand } = await import("../automation-control.js");
    const cmd = issueAutomationCommand({ action: "set_enabled", enabled: true });
    expect(cmd.id).toBeTruthy();
    expect(cmd.action).toBe("set_enabled");
    expect(cmd.enabled).toBe(true);
    expect(cmd.issuedAt).toBeTruthy();
    // Verify persistence
    const read = readAutomationCommand();
    expect(read.id).toBe(cmd.id);
  });

  it("readAutomationCommand returns null when no file", async () => {
    const { readAutomationCommand } = await import("../automation-control.js");
    expect(readAutomationCommand()).toBeNull();
  });
});

describe("automation-control — supervisor", () => {
  it("readSupervisorState returns defaults", async () => {
    const { readSupervisorState } = await import("../automation-control.js");
    const state = readSupervisorState();
    expect(state.desiredRunning).toBe(false);
    expect(state.agentRunning).toBe(false);
  });

  it("publishSupervisorState persists", async () => {
    const { publishSupervisorState, readSupervisorState } = await import("../automation-control.js");
    await publishSupervisorState({ desiredRunning: true, mode: "auto" });
    const state = readSupervisorState();
    expect(state.desiredRunning).toBe(true);
    expect(state.mode).toBe("auto");
  });

  it("issueSupervisorCommand creates command", async () => {
    const { issueSupervisorCommand, readSupervisorCommand } = await import("../automation-control.js");
    const cmd = issueSupervisorCommand({ action: "set_power", enabled: false });
    expect(cmd.action).toBe("set_power");
    expect(cmd.enabled).toBe(false);
    const read = readSupervisorCommand();
    expect(read.id).toBe(cmd.id);
  });
});
