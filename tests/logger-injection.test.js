import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendFile = vi.fn((p, line, cb) => cb && cb());
const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn(() => true);
const mockConsoleLog = vi.fn();

vi.mock("fs", () => ({
  default: {
    appendFile: (...a) => mockAppendFile(...a),
    mkdirSync: (...a) => mockMkdirSync(...a),
    existsSync: (...a) => mockExistsSync(...a),
  },
  appendFile: (...a) => mockAppendFile(...a),
  mkdirSync: (...a) => mockMkdirSync(...a),
  existsSync: (...a) => mockExistsSync(...a),
}));

vi.mock("../telegram.js", () => ({
  sendHTML: vi.fn(() => Promise.resolve()),
  isEnabled: () => false,
}));

const { log } = await import("../logger.js");

beforeEach(() => {
  mockAppendFile.mockClear();
  console.log = mockConsoleLog;
  mockConsoleLog.mockClear();
});

describe("log() sanitization", () => {
  it("strips CRLF from messages (prevents log injection)", () => {
    log("api_error", "First line\n[2026-01-01] [SYSTEM] Bot compromised\nSecond");
    const writtenLine = mockAppendFile.mock.calls[0][1];
    expect(writtenLine).not.toContain("\n[2026-01-01]");
    expect(writtenLine.split("\n")).toHaveLength(2); // single line + trailing \n
  });

  it("strips CR from messages", () => {
    log("api_error", "evil\rmessage");
    const writtenLine = mockAppendFile.mock.calls[0][1];
    expect(writtenLine).not.toContain("\r");
  });

  it("strips ANSI escape sequences", () => {
    log("api_error", "\x1b[31mred error\x1b[0m");
    const writtenLine = mockAppendFile.mock.calls[0][1];
    expect(writtenLine).not.toContain("\x1b");
    expect(writtenLine).toContain("red error");
  });

  it("strips other control chars", () => {
    log("api_error", "evil\x00\x07\x7Fpayload");
    const writtenLine = mockAppendFile.mock.calls[0][1];
    expect(writtenLine).not.toMatch(/[\x00\x07\x7F]/);
  });

  it("truncates oversized messages", () => {
    const huge = "x".repeat(5000);
    log("api_error", huge);
    const writtenLine = mockAppendFile.mock.calls[0][1];
    expect(writtenLine.length).toBeLessThan(2100);
    expect(writtenLine).toContain("…");
  });

  it("sanitizes category too", () => {
    log("api_error\n[FAKE]", "msg");
    const writtenLine = mockAppendFile.mock.calls[0][1];
    expect(writtenLine).not.toContain("\n[FAKE]");
  });
});
