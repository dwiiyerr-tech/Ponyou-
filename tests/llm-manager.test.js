import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// llm-manager.js reads/writes `user-config.json` and `.env` from cwd. We
// snapshot+restore so tests are hermetic and don't trash the user's real
// config. The module caches nothing — every call re-reads from disk.

const CWD = process.cwd();
const USER_CONFIG = path.join(CWD, "user-config.json");
const ENV_FILE = path.join(CWD, ".env");

let _ucBackup = null;
let _envBackup = null;

beforeEach(() => {
  _ucBackup = fs.existsSync(USER_CONFIG) ? fs.readFileSync(USER_CONFIG, "utf8") : null;
  _envBackup = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : null;
  // Start from a known clean slate
  fs.writeFileSync(USER_CONFIG, JSON.stringify({}, null, 2));
  fs.writeFileSync(ENV_FILE, "LLM_PROVIDER=openrouter\n");
});

afterEach(() => {
  if (_ucBackup != null) fs.writeFileSync(USER_CONFIG, _ucBackup);
  else fs.unlinkSync(USER_CONFIG);
  if (_envBackup != null) fs.writeFileSync(ENV_FILE, _envBackup);
  else if (fs.existsSync(ENV_FILE)) fs.unlinkSync(ENV_FILE);
});

describe("addCustomProvider / removeCustomProvider", () => {
  it("adds a new custom provider", async () => {
    const { addCustomProvider, findCustomProvider } = await import("../llm-manager.js");
    const result = addCustomProvider({
      id: "test1",
      baseUrl: "https://api.test1.example/v1",
    });
    expect(result.success).toBe(true);
    expect(result.action).toBe("added");

    const found = findCustomProvider("test1");
    expect(found).not.toBeNull();
    expect(found.baseUrl).toBe("https://api.test1.example/v1");
  });

  it("normalizes default apiKeyEnv to <ID>_API_KEY", async () => {
    const { addCustomProvider } = await import("../llm-manager.js");
    addCustomProvider({ id: "myllm", baseUrl: "https://x.test" });
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
    expect(cfg.customProviders[0].apiKeyEnv).toBe("MYLLM_API_KEY");
  });

  it("updates instead of duplicating when id already exists", async () => {
    const { addCustomProvider } = await import("../llm-manager.js");
    addCustomProvider({ id: "dup", baseUrl: "https://v1.test" });
    const result = addCustomProvider({ id: "dup", baseUrl: "https://v2.test" });
    expect(result.action).toBe("updated");

    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
    expect(cfg.customProviders).toHaveLength(1);
    expect(cfg.customProviders[0].baseUrl).toBe("https://v2.test");
  });

  it("rejects id collision with built-in providers", async () => {
    const { addCustomProvider } = await import("../llm-manager.js");
    expect(() => addCustomProvider({ id: "openai", baseUrl: "https://x.test" }))
      .toThrow(/collides/);
  });

  it("rejects entries missing required fields", async () => {
    const { addCustomProvider } = await import("../llm-manager.js");
    expect(() => addCustomProvider({ baseUrl: "https://x.test" })).toThrow(/id/);
    expect(() => addCustomProvider({ id: "x" })).toThrow(/baseUrl/);
  });

  it("removes by id", async () => {
    const { addCustomProvider, removeCustomProvider, findCustomProvider } = await import("../llm-manager.js");
    addCustomProvider({ id: "removeme", baseUrl: "https://x.test" });
    expect(findCustomProvider("removeme")).not.toBeNull();
    const result = removeCustomProvider("removeme");
    expect(result.success).toBe(true);
    expect(findCustomProvider("removeme")).toBeNull();
  });

  it("returns success=false when removing nonexistent id", async () => {
    const { removeCustomProvider } = await import("../llm-manager.js");
    const result = removeCustomProvider("nope");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no custom provider/i);
  });
});

describe("addPreset", () => {
  it("scaffolds gemini preset with correct baseUrl", async () => {
    const { addPreset } = await import("../llm-manager.js");
    const result = addPreset("gemini");
    expect(result.success).toBe(true);
    expect(result.entry.baseUrl).toMatch(/generativelanguage\.googleapis\.com/);
    expect(result.entry.apiKeyEnv).toBe("GEMINI_API_KEY");
  });

  it("allows override via second argument", async () => {
    const { addPreset } = await import("../llm-manager.js");
    const result = addPreset("deepseek", { defaultModel: "deepseek-reasoner" });
    expect(result.entry.defaultModel).toBe("deepseek-reasoner");
  });

  it("throws on unknown preset id", async () => {
    const { addPreset } = await import("../llm-manager.js");
    expect(() => addPreset("nonexistent")).toThrow(/Unknown preset/);
  });
});

describe("quickSwitch — env LLM_MODEL update (regression for switch-pinning bug)", () => {
  it("writes LLM_MODEL to .env on switch to built-in provider", async () => {
    fs.writeFileSync(ENV_FILE, "LLM_PROVIDER=openrouter\nLLM_MODEL=old-model\n");
    const { quickSwitch } = await import("../llm-manager.js");
    quickSwitch("groq");
    const env = fs.readFileSync(ENV_FILE, "utf8");
    expect(env).toMatch(/LLM_PROVIDER=groq/);
    // Groq's first model is mixtral-8x7b-32768
    expect(env).toMatch(/LLM_MODEL=mixtral-8x7b-32768/);
    expect(env).not.toMatch(/LLM_MODEL=old-model/);
  });

  it("writes LLM_MODEL to .env on switch to custom provider", async () => {
    fs.writeFileSync(ENV_FILE, "LLM_MODEL=old-model\n");
    const { addCustomProvider, quickSwitch } = await import("../llm-manager.js");
    addCustomProvider({
      id: "myllm",
      baseUrl: "https://x.test",
      defaultModel: "my-new-model",
    });
    const result = quickSwitch("myllm");
    expect(result.success).toBe(true);
    const env = fs.readFileSync(ENV_FILE, "utf8");
    expect(env).toMatch(/LLM_MODEL=my-new-model/);
  });

  it("returns success=false for unknown provider id", async () => {
    const { quickSwitch } = await import("../llm-manager.js");
    const result = quickSwitch("ghost-provider");
    expect(result.success).toBe(false);
  });
});

describe("CUSTOM_PRESETS catalog", () => {
  it("exposes the 12 expected presets", async () => {
    const { CUSTOM_PRESETS } = await import("../llm-manager.js");
    const expected = ["gemini", "deepseek", "xai", "perplexity", "cohere",
                      "fireworks", "deepinfra", "nvidia", "cerebras",
                      "sambanova", "hyperbolic", "azure"];
    for (const id of expected) {
      expect(CUSTOM_PRESETS[id]).toBeDefined();
      expect(CUSTOM_PRESETS[id].baseUrl).toBeTruthy();
      expect(CUSTOM_PRESETS[id].defaultModel).toBeTruthy();
    }
  });
});
