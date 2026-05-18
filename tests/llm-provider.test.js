import { describe, it, expect } from "vitest";
import {
  detectProvider,
  getProviderConfig,
  listProviders,
  validateProviderConfig,
  mapModelName,
  handleProviderError,
} from "../llm-provider.js";
import llmProviderDefault from "../llm-provider.js";

const PROVIDER_CONFIGS = llmProviderDefault.PROVIDER_CONFIGS;

describe("detectProvider", () => {
  it("returns the configured provider when it matches a built-in", () => {
    expect(detectProvider({ llmProvider: "openrouter" })).toBe("openrouter");
    expect(detectProvider({ llmProvider: "groq" })).toBe("groq");
  });

  it("returns custom id when listed in customProviders[]", () => {
    const cfg = {
      llmProvider: "mygw",
      customProviders: [
        { id: "mygw", baseUrl: "https://api.example.com/v1" },
      ],
    };
    expect(detectProvider(cfg)).toBe("mygw");
  });

  it("custom provider shadows built-in with same id", () => {
    const cfg = {
      llmProvider: "openrouter",
      customProviders: [
        { id: "openrouter", baseUrl: "https://override.example.com/v1" },
      ],
    };
    // detectProvider still returns "openrouter" but getProviderConfig should
    // resolve from the custom entry, not the built-in.
    expect(detectProvider(cfg)).toBe("openrouter");
    const resolved = getProviderConfig("openrouter", cfg);
    expect(resolved.baseURL).toBe("https://override.example.com/v1");
    expect(resolved.isCustom).toBe(true);
  });

  it("falls back to model-name heuristics for unknown providers", () => {
    expect(detectProvider({ llmProvider: "weird", llmModel: "claude-3.5-sonnet" })).toBe("anthropic");
    expect(detectProvider({ llmProvider: "weird", llmModel: "gpt-4o" })).toBe("openai");
    expect(detectProvider({ llmProvider: "weird", llmModel: "mistral-large" })).toBe("mistral");
  });

  it("defaults to openrouter when nothing matches", () => {
    expect(detectProvider({})).toBe("openrouter");
    expect(detectProvider({ llmProvider: "totally-unknown" })).toBe("openrouter");
  });
});

describe("getProviderConfig", () => {
  it("returns built-in config when no custom override", () => {
    expect(getProviderConfig("openai").name).toBe("OpenAI");
  });

  it("returns openrouter config as default fallback", () => {
    expect(getProviderConfig("nonexistent").name).toBe("OpenRouter");
  });

  it("custom provider overrides built-in when matching id", () => {
    const cfg = {
      customProviders: [
        {
          id: "openai",
          name: "Custom OpenAI",
          baseUrl: "https://custom.openai.example/v1",
          apiKeyEnv: "MY_KEY",
          defaultModel: "custom-model",
        },
      ],
    };
    const resolved = getProviderConfig("openai", cfg);
    expect(resolved.name).toBe("Custom OpenAI");
    expect(resolved.baseURL).toBe("https://custom.openai.example/v1");
    expect(resolved.defaultModel).toBe("custom-model");
  });

  it("custom provider gets sensible feature defaults", () => {
    const cfg = {
      customProviders: [{ id: "x", baseUrl: "https://x.test" }],
    };
    const c = getProviderConfig("x", cfg);
    expect(c.features.systemRole).toBe(true);
    expect(c.features.toolChoice).toBe(true);
    expect(c.features.streaming).toBe(true);
  });
});

describe("listProviders", () => {
  it("returns all built-in providers", () => {
    const ps = listProviders();
    const ids = ps.map((p) => p.id);
    for (const expected of ["openrouter", "openai", "anthropic", "groq", "mistral", "together", "lmstudio", "ollama"]) {
      expect(ids).toContain(expected);
    }
  });

  it("includes custom providers when config given", () => {
    const ps = listProviders({
      customProviders: [{ id: "mygw", baseUrl: "https://x.test" }],
    });
    const custom = ps.find((p) => p.id === "mygw");
    expect(custom).toBeDefined();
    expect(custom.custom).toBe(true);
  });

  it("does NOT duplicate custom that shadows built-in id", () => {
    const ps = listProviders({
      customProviders: [{ id: "openai", baseUrl: "https://x.test" }],
    });
    const openais = ps.filter((p) => p.id === "openai");
    expect(openais).toHaveLength(1);
  });
});

describe("validateProviderConfig", () => {
  it("returns invalid when openrouter base url missing", () => {
    // Built-in has a default baseURL, so this should be valid with a key.
    process.env.OPENROUTER_API_KEY = "test-key";
    const result = validateProviderConfig("openrouter", {});
    expect(result.valid).toBe(true);
    delete process.env.OPENROUTER_API_KEY;
  });

  it("flags missing API key", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_API_KEY;
    const result = validateProviderConfig("openrouter", {});
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/API key/i);
  });

  it("local providers (lmstudio/ollama) don't require API key", () => {
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    const r = validateProviderConfig("ollama", {});
    expect(r.valid).toBe(true);
    delete process.env.LLM_BASE_URL;
  });
});

describe("handleProviderError", () => {
  it("classifies system role rejection", () => {
    const r = handleProviderError({ message: "Invalid message role: system" });
    expect(r.type).toBe("system_role_unsupported");
    expect(r.shouldRetry).toBe(true);
  });

  it("classifies rate-limit (429)", () => {
    const r = handleProviderError({ message: "rate limit exceeded" });
    expect(r.type).toBe("rate_limited");
    expect(r.shouldRetry).toBe(true);
  });

  it("classifies auth error as non-retryable", () => {
    const r = handleProviderError({ message: "401 Unauthorized" });
    expect(r.type).toBe("auth_error");
    expect(r.shouldRetry).toBe(false);
  });

  it("classifies network errors as retryable", () => {
    const r = handleProviderError({ message: "ECONNREFUSED" });
    expect(r.type).toBe("connection_error");
    expect(r.shouldRetry).toBe(true);
  });
});

describe("mapModelName", () => {
  it("maps openrouter aliases", () => {
    expect(mapModelName("gpt-4o", "openrouter")).toBe("openai/gpt-4-turbo");
  });

  it("returns model unchanged when no mapping exists", () => {
    expect(mapModelName("unique-model-v9", "openai")).toBe("unique-model-v9");
  });
});

describe("PROVIDER_CONFIGS sanity", () => {
  it("every built-in has name + type + features", () => {
    for (const [id, cfg] of Object.entries(PROVIDER_CONFIGS)) {
      expect(typeof cfg.name).toBe("string");
      expect(["openai-compatible", "anthropic-native"]).toContain(cfg.type);
      expect(typeof cfg.features).toBe("object");
    }
  });
});
