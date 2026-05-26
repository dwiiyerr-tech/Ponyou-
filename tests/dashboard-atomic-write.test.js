import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — define mock fns before factory
const mockWriteFileSync = vi.fn();
const mockRenameSync = vi.fn();
const mockOpenSync = vi.fn(() => 42); // fake fd
const mockFsyncSync = vi.fn();
const mockCloseSync = vi.fn();

vi.mock("fs", () => ({
  default: {
    writeFileSync: (...a) => mockWriteFileSync(...a),
    renameSync: (...a) => mockRenameSync(...a),
    openSync: (...a) => mockOpenSync(...a),
    fsyncSync: (...a) => mockFsyncSync(...a),
    closeSync: (...a) => mockCloseSync(...a),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  },
  writeFileSync: (...a) => mockWriteFileSync(...a),
  renameSync: (...a) => mockRenameSync(...a),
  openSync: (...a) => mockOpenSync(...a),
  fsyncSync: (...a) => mockFsyncSync(...a),
  closeSync: (...a) => mockCloseSync(...a),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

const { writeDashboardCmd, writeAutomationCommand, _setBasePath } = await import("../dashboard/command-writer.js");

_setBasePath("/tmp/ponyou-test");

beforeEach(() => {
  mockWriteFileSync.mockClear();
  mockRenameSync.mockClear();
});

describe("writeDashboardCmd — atomic write", () => {
  it("writes to .tmp file first, then renames to final path", () => {
    writeDashboardCmd({ id: "test-1", cmd: "status", args: [] });

    // writeFileSync must be called with the .tmp path
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const writeCall = mockWriteFileSync.mock.calls[0];
    expect(writeCall[0]).toMatch(/dashboard-cmd\.json\.tmp\.\d+\.\d+$/);

    // renameSync must be called: tmp → final
    expect(mockRenameSync).toHaveBeenCalledOnce();
    const [tmpPath, finalPath] = mockRenameSync.mock.calls[0];
    expect(tmpPath).toMatch(/dashboard-cmd\.json\.tmp\.\d+\.\d+$/);
    expect(finalPath).toMatch(/dashboard-cmd\.json$/);
    expect(finalPath).not.toMatch(/\.tmp$/);

    // Rename must happen after write
    const writeOrder = mockWriteFileSync.mock.invocationCallOrder[0];
    const renameOrder = mockRenameSync.mock.invocationCallOrder[0];
    expect(renameOrder).toBeGreaterThan(writeOrder);
  });

  it("serializes id, cmd, args, and ts in the written payload", () => {
    writeDashboardCmd({ id: "abc", cmd: "buy", args: ["MINT123"] });

    const writeCall = mockWriteFileSync.mock.calls[0];
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

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const writeCall = mockWriteFileSync.mock.calls[0];
    expect(writeCall[0]).toMatch(/automation-command\.json\.tmp\.\d+\.\d+$/);

    expect(mockRenameSync).toHaveBeenCalledOnce();
    const [tmpPath, finalPath] = mockRenameSync.mock.calls[0];
    expect(tmpPath).toMatch(/automation-command\.json\.tmp\.\d+\.\d+$/);
    expect(finalPath).toMatch(/automation-command\.json$/);
    expect(finalPath).not.toMatch(/\.tmp$/);

    const writeOrder = mockWriteFileSync.mock.invocationCallOrder[0];
    const renameOrder = mockRenameSync.mock.invocationCallOrder[0];
    expect(renameOrder).toBeGreaterThan(writeOrder);
  });

  it("serializes cmd and ts in the written payload", () => {
    writeAutomationCommand("stop");

    const payload = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(payload.cmd).toBe("stop");
    expect(typeof payload.ts).toBe("string");
  });
});
