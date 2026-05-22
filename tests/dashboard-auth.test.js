import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted to the top by Vitest — safe to reference here
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn(() => { throw new Error("no file"); });
const mockRandomBytes = vi.fn(() => Buffer.alloc(32, 0xab));
const mockRenameSync = vi.fn();

vi.mock("fs", () => ({
  default: {
    writeFileSync: (...a) => mockWriteFileSync(...a),
    readFileSync: (...a) => mockReadFileSync(...a),
    renameSync: (...a) => mockRenameSync(...a),
    existsSync: vi.fn(() => false),
  },
  writeFileSync: (...a) => mockWriteFileSync(...a),
  readFileSync: (...a) => mockReadFileSync(...a),
  renameSync: (...a) => mockRenameSync(...a),
  existsSync: vi.fn(() => false),
}));

vi.mock("crypto", () => ({
  default: { randomBytes: (...a) => mockRandomBytes(...a) },
  randomBytes: (...a) => mockRandomBytes(...a),
}));

const { generateToken, getToken, validateToken, authMiddleware } = await import("../dashboard/auth.js");

beforeEach(() => {
  mockWriteFileSync.mockClear();
  mockReadFileSync.mockClear();
  mockRandomBytes.mockClear();
  // Reset mockRandomBytes to default behaviour
  mockRandomBytes.mockImplementation(() => Buffer.alloc(32, 0xab));
});

describe("generateToken", () => {
  it("creates a 64-char hex token and writes it to disk", () => {
    const token = generateToken();
    expect(typeof token).toBe("string");
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]+$/i.test(token)).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });
});

describe("authMiddleware", () => {
  function makeRes() {
    const res = { _status: null, _body: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (body) => { res._body = body; return res; };
    return res;
  }

  it("passes request with valid Bearer token", () => {
    const token = generateToken();
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });

  it("rejects request with missing token (returns 401)", () => {
    generateToken(); // ensure a token is set
    const req = { headers: {}, cookies: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Unauthorized" });
  });

  it("rejects request with wrong Bearer token (returns 401)", () => {
    generateToken();
    const req = { headers: { authorization: "Bearer wrongtoken123" }, cookies: {} };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it("passes request with valid cookie token", () => {
    const token = generateToken();
    const req = { headers: {}, cookies: { dashtoken: token } };
    const res = makeRes();
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });
});
