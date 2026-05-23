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

describe("sanitizeWallets (multi-wallet schema)", () => {
  it("accepts valid wallets array and strips inline key", () => {
    writeConfig({
      walletAddress: "x",
      wallets: [
        { label: "main",  env_ref: "WALLET_KEY_1", capital_pct: 60, key: "should-be-stripped" },
        { label: "scout", env_ref: "WALLET_KEY_2", capital_pct: 40 },
      ],
    });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.wallets).toHaveLength(2);
    expect(raw.wallets[0]).toEqual({ label: "main", env_ref: "WALLET_KEY_1", capital_pct: 60 });
    expect(raw.wallets[0].key).toBeUndefined();
  });

  it("caps wallets at 10 entries", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      label: `w${i}`,
      env_ref: `WALLET_KEY_${(i % 10) + 1}`,
      capital_pct: 10,
    }));
    writeConfig({ walletAddress: "x", wallets: many });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.wallets).toHaveLength(10);
  });

  it("rejects rows with invalid env_ref / label / capital_pct", () => {
    writeConfig({
      walletAddress: "x",
      wallets: [
        { label: "ok",        env_ref: "WALLET_KEY_1", capital_pct: 50 },
        { label: "bad-env",   env_ref: "FOO_BAR",      capital_pct: 25 },
        { label: "bad pct",   env_ref: "WALLET_KEY_3", capital_pct: 0 },
        { label: "over",      env_ref: "WALLET_KEY_4", capital_pct: 200 },
        { label: "@@@",       env_ref: "WALLET_KEY_5", capital_pct: 10 },
      ],
    });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.wallets.map(w => w.label)).toEqual(["ok"]);
  });

  it("returns empty array when wallets is not an array", () => {
    writeConfig({ walletAddress: "x", wallets: "not-an-array" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "user-config.json"), "utf8"));
    expect(raw.wallets).toEqual([]);
  });
});
