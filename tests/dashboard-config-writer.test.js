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

describe("URL scheme validation (SSRF guard)", () => {
  it("accepts https rpcUrl", () => {
    writeConfig({ walletAddress: "x", rpcUrl: "https://api.mainnet-beta.solana.com" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });
  it("rejects file:// rpcUrl", () => {
    writeConfig({ walletAddress: "x", rpcUrl: "file:///etc/passwd" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrl).toBeUndefined();
  });
  it("rejects javascript: rpcUrl", () => {
    writeConfig({ walletAddress: "x", rpcUrl: "javascript:alert(1)" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrl).toBeUndefined();
  });
  it("rejects non-string rpcUrl", () => {
    writeConfig({ walletAddress: "x", rpcUrl: 42 });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrl).toBeUndefined();
  });
  it("rejects oversized rpcUrl", () => {
    writeConfig({ walletAddress: "x", rpcUrl: "https://" + "a".repeat(3000) + ".com" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrl).toBeUndefined();
  });
  it("rejects geyserGrpcUrl with bad scheme", () => {
    writeConfig({ walletAddress: "x", geyserGrpcUrl: "ftp://evil.example/" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.geyserGrpcUrl).toBeUndefined();
  });
  it("rejects llmBaseUrl with bad scheme", () => {
    writeConfig({ walletAddress: "x", llmBaseUrl: "data:text/plain,whatever" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.llmBaseUrl).toBeUndefined();
  });
  it("filters rpcUrls array to safe http(s)", () => {
    writeConfig({
      walletAddress: "x",
      rpcUrls: ["https://ok.example", "file:///etc/passwd", "http://also-ok.example", 123, "not a url"]
    });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrls).toEqual(["https://ok.example", "http://also-ok.example"]);
  });
  it("caps rpcUrls array at 16 entries", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://node${i}.example`);
    writeConfig({ walletAddress: "x", rpcUrls: many });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.rpcUrls).toHaveLength(16);
  });
  it("sanitizes customProviders[] entries", () => {
    writeConfig({
      walletAddress: "x",
      customProviders: [
        { id: "good", baseUrl: "https://api.example/v1" },
        { id: "bad-scheme", baseUrl: "file:///etc/passwd" },
        { id: "", baseUrl: "https://api.example/v1" },
        { baseUrl: "https://api.example/v1" },
        "not an object",
        { id: "x".repeat(100), baseUrl: "https://api.example/v1" },
      ]
    });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.customProviders).toHaveLength(1);
    expect(raw.customProviders[0].id).toBe("good");
  });
  it("drops __proto__ and constructor keys", () => {
    writeConfig({ walletAddress: "x", __proto__: { polluted: true }, constructor: { polluted: true } });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.polluted).toBeUndefined();
    expect(raw.__proto__).toEqual({});
  });
  it("drops unknown keys not in allowlist", () => {
    writeConfig({ walletAddress: "x", somethingRandom: "evil" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.somethingRandom).toBeUndefined();
  });
});
