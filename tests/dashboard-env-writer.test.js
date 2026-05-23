import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { _setBasePath, readEnv, writeWalletKeys, walletKeyStatus, WALLET_ENV_PATTERN } from "../dashboard/env-writer.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-env-writer-"));
}

let tmp;
beforeEach(() => {
  tmp = makeTmpDir();
  _setBasePath(tmp);
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("env-writer", () => {
  it("writes WALLET_KEY_N to a fresh .env file", async () => {
    const res = await writeWalletKeys({ WALLET_KEY_1: "aaa", WALLET_KEY_2: "bbb" });
    expect(res.written).toBe(2);
    const text = fs.readFileSync(path.join(tmp, ".env"), "utf8");
    expect(text).toContain("WALLET_KEY_1=aaa");
    expect(text).toContain("WALLET_KEY_2=bbb");
  });

  it("preserves unrelated keys in existing .env", async () => {
    fs.writeFileSync(path.join(tmp, ".env"), "OTHER=foo\nLLM_API_KEY=sk-test\n");
    await writeWalletKeys({ WALLET_KEY_3: "ccc" });
    const text = fs.readFileSync(path.join(tmp, ".env"), "utf8");
    expect(text).toContain("OTHER=foo");
    expect(text).toContain("LLM_API_KEY=sk-test");
    expect(text).toContain("WALLET_KEY_3=ccc");
  });

  it("deletes a wallet key when value is empty string", async () => {
    fs.writeFileSync(path.join(tmp, ".env"), "WALLET_KEY_1=aaa\nWALLET_KEY_2=bbb\n");
    const res = await writeWalletKeys({ WALLET_KEY_1: "" });
    expect(res.deleted).toBe(1);
    const text = fs.readFileSync(path.join(tmp, ".env"), "utf8");
    expect(text).not.toContain("WALLET_KEY_1=");
    expect(text).toContain("WALLET_KEY_2=bbb");
  });

  it("ignores keys outside the WALLET_KEY_1..10 namespace", async () => {
    await writeWalletKeys({ WALLET_KEY_1: "aaa", LLM_API_KEY: "leak", FOO: "bar" });
    const env = readEnv();
    expect(env.get("WALLET_KEY_1")).toBe("aaa");
    expect(env.has("LLM_API_KEY")).toBe(false);
    expect(env.has("FOO")).toBe(false);
  });

  it("rejects WALLET_KEY_11+ via pattern", () => {
    expect(WALLET_ENV_PATTERN.test("WALLET_KEY_10")).toBe(true);
    expect(WALLET_ENV_PATTERN.test("WALLET_KEY_11")).toBe(false);
    expect(WALLET_ENV_PATTERN.test("WALLET_KEY_0")).toBe(false);
  });

  it("serializes concurrent writes via withFileLock", async () => {
    const ops = [];
    for (let i = 1; i <= 5; i++) {
      ops.push(writeWalletKeys({ [`WALLET_KEY_${i}`]: `value-${i}` }));
    }
    await Promise.all(ops);
    const env = readEnv();
    for (let i = 1; i <= 5; i++) {
      expect(env.get(`WALLET_KEY_${i}`)).toBe(`value-${i}`);
    }
  });

  it("walletKeyStatus reports has_key without exposing plaintext", async () => {
    await writeWalletKeys({ WALLET_KEY_1: "secret-a", WALLET_KEY_5: "secret-b" });
    const status = walletKeyStatus();
    expect(status.slots.length).toBe(10);
    const map = Object.fromEntries(status.slots.map((s) => [s.env_ref, s.has_key]));
    expect(map.WALLET_KEY_1).toBe(true);
    expect(map.WALLET_KEY_2).toBe(false);
    expect(map.WALLET_KEY_5).toBe(true);
    // Critical: never leak plaintext.
    expect(JSON.stringify(status)).not.toContain("secret-a");
    expect(JSON.stringify(status)).not.toContain("secret-b");
  });

  it("sets .env permissions to 0o600 after write", async () => {
    await writeWalletKeys({ WALLET_KEY_1: "aaa" });
    const mode = fs.statSync(path.join(tmp, ".env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
