import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock fs before importing command-writer ─────────
vi.mock("fs");

const fsMock = await import("fs");
fsMock.writeFileSync = vi.fn();
fsMock.renameSync = vi.fn();

const { writeDashboardCmd, writeAutomationCommand, _setBasePath } = await import("../dashboard/command-writer.js");

// Set a stable base path so path assertions are predictable
_setBasePath("/tmp/ponyou-test");

beforeEach(() => {
  fsMock.writeFileSync.mockClear();
  fsMock.renameSync.mockClear();
});

describe("writeDashboardCmd — atomic write", () => {
  it("writes to .tmp file first, then renames to final path", () => {
    writeDashboardCmd({ id: "test-1", cmd: "status", args: [] });

    // writeFileSync must be called with the .tmp path
    expect(fsMock.writeFileSync).toHaveBeenCalledOnce();
    const writeCall = fsMock.writeFileSync.mock.calls[0];
    expect(writeCall[0]).toMatch(/dashboard-cmd\.json\.tmp$/);

    // renameSync must be called: tmp → final
    expect(fsMock.renameSync).toHaveBeenCalledOnce();
    const [tmpPath, finalPath] = fsMock.renameSync.mock.calls[0];
    expect(tmpPath).toMatch(/dashboard-cmd\.json\.tmp$/);
    expect(finalPath).toMatch(/dashboard-cmd\.json$/);
    expect(finalPath).not.toMatch(/\.tmp$/);

    // Rename must happen after write
    const writeOrder = fsMock.writeFileSync.mock.invocationCallOrder[0];
    const renameOrder = fsMock.renameSync.mock.invocationCallOrder[0];
    expect(renameOrder).toBeGreaterThan(writeOrder);
  });

  it("serializes id, cmd, args, and ts in the written payload", () => {
    writeDashboardCmd({ id: "abc", cmd: "buy", args: ["MINT123"] });

    const writeCall = fsMock.writeFileSync.mock.calls[0];
    const payload = JSON.parse(writeCall[1]);
    expect(payload.id).toBe("abc");
    expect(payload.cmd).toBe("buy");
    expect(payload.args).toEqual(["MINT123"]);
    expect(typeof payload.ts).toBe("string");
  });
});

describe("writeAutomationCommand — atomic write", () => {
  it("writes to .tmp file first, then renames to final path", () => {
    writeAutomationCommand("start");

    expect(fsMock.writeFileSync).toHaveBeenCalledOnce();
    const writeCall = fsMock.writeFileSync.mock.calls[0];
    expect(writeCall[0]).toMatch(/automation-command\.json\.tmp$/);

    expect(fsMock.renameSync).toHaveBeenCalledOnce();
    const [tmpPath, finalPath] = fsMock.renameSync.mock.calls[0];
    expect(tmpPath).toMatch(/automation-command\.json\.tmp$/);
    expect(finalPath).toMatch(/automation-command\.json$/);
    expect(finalPath).not.toMatch(/\.tmp$/);

    const writeOrder = fsMock.writeFileSync.mock.invocationCallOrder[0];
    const renameOrder = fsMock.renameSync.mock.invocationCallOrder[0];
    expect(renameOrder).toBeGreaterThan(writeOrder);
  });

  it("serializes cmd and ts in the written payload", () => {
    writeAutomationCommand("stop");

    const payload = JSON.parse(fsMock.writeFileSync.mock.calls[0][1]);
    expect(payload.cmd).toBe("stop");
    expect(typeof payload.ts).toBe("string");
  });
});
