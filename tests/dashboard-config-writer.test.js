import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig, maskPrivateKey, _setBasePath } from "../dashboard/config-writer.js";

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-dash-cfg-"));
  _setBasePath(tmpDir);
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe("maskPrivateKey", () => {
  it("masks keys longer than 8 chars", () => {
    expect(maskPrivateKey("abcdefghijklmnop")).toBe("abcd…mnop");
  });
  it("returns empty string for missing key", () => {
    expect(maskPrivateKey(undefined)).toBe("");
    expect(maskPrivateKey("")).toBe("");
  });
});

describe("readConfig", () => {
  it("returns empty object when file missing", () => {
    expect(readConfig()).toEqual({});
  });
  it("masks privateKey in output", () => {
    fs.writeFileSync(
      path.join(tmpDir, "user-config.json"),
      JSON.stringify({ walletAddress: "abc", privateKey: "secretsecret1234" })
    );
    const cfg = readConfig();
    expect(cfg.walletAddress).toBe("abc");
    expect(cfg.privateKey).toBe("secr…1234");
  });
});

describe("writeConfig", () => {
  it("writes valid JSON to user-config.json", () => {
    writeConfig({ walletAddress: "test123", deployAmountSol: 0.05 });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.walletAddress).toBe("test123");
    expect(raw.deployAmountSol).toBe(0.05);
  });
  it("never writes masked privateKey (abcd…xxxx) to disk", () => {
    writeConfig({ privateKey: "abcd…1234", walletAddress: "x" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.privateKey).toBeUndefined();
  });
});
