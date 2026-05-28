/**
 * LLM Manager - Utility untuk manage provider configuration
 * Digunakan oleh runtime agent untuk konfigurasi provider LLM
 */

import fs from "fs";
import path from "path";
import { atomicWriteText, atomicWriteJson } from "./atomic-write.js";

const ENV_FILE = ".env";
const CONFIG_FILE = "user-config.json";

/**
 * Templates for "add-preset" — popular OpenAI-compatible providers users can
 * scaffold into customProviders[] with one command. Adding a preset writes a
 * fully-formed custom provider entry; users can edit it freely afterwards.
 */
export const CUSTOM_PRESETS = {
  gemini: {
    id: "gemini",
    name: "Google Gemini (OpenAI-compat)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.0-flash-exp",
    features: { systemRole: true, toolChoice: true, vision: true, streaming: true },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  xai: {
    id: "xai",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    defaultModel: "grok-2-latest",
    features: { systemRole: true, toolChoice: true, vision: true, streaming: true },
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    defaultModel: "llama-3.1-sonar-large-128k-online",
    features: { systemRole: true, toolChoice: false, vision: false, streaming: true },
  },
  cohere: {
    id: "cohere",
    name: "Cohere (OpenAI-compat)",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyEnv: "COHERE_API_KEY",
    defaultModel: "command-r-plus",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  deepinfra: {
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    defaultModel: "meta/llama-3.1-70b-instruct",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    defaultModel: "llama3.1-70b",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  sambanova: {
    id: "sambanova",
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: "SAMBANOVA_API_KEY",
    defaultModel: "Meta-Llama-3.1-70B-Instruct",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  hyperbolic: {
    id: "hyperbolic",
    name: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: "HYPERBOLIC_API_KEY",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    features: { systemRole: true, toolChoice: true, vision: false, streaming: true },
  },
  azure: {
    id: "azure",
    name: "Azure OpenAI",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
    apiKeyEnv: "AZURE_OPENAI_API_KEY",
    defaultModel: "gpt-4o",
    headers: { "api-key": "${AZURE_OPENAI_API_KEY}" },
    features: { systemRole: true, toolChoice: true, vision: true, streaming: true },
  },
};

/**
 * Preset provider configurations
 */
export const PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    apiKeyVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openrouter/auto", "openrouter/gpt-4-turbo", "openrouter/claude-opus"],
    requiresKey: true,
    local: false,
  },
  openai: {
    name: "OpenAI",
    apiKeyVar: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4-turbo-preview", "gpt-4-vision-preview", "gpt-3.5-turbo"],
    requiresKey: true,
    local: false,
  },
  anthropic: {
    name: "Anthropic Claude",
    apiKeyVar: "ANTHROPIC_API_KEY",
    baseUrl: null,
    models: ["claude-opus-4-1", "claude-sonnet-4", "claude-haiku-3"],
    requiresKey: true,
    local: false,
  },
  groq: {
    name: "Groq",
    apiKeyVar: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["mixtral-8x7b-32768", "llama2-70b-4096"],
    requiresKey: true,
    local: false,
  },
  mistral: {
    name: "Mistral AI",
    apiKeyVar: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-medium-latest"],
    requiresKey: true,
    local: false,
  },
  together: {
    name: "Together AI",
    apiKeyVar: "TOGETHER_API_KEY",
    baseUrl: "https://api.together.xyz/v1",
    models: ["mistralai/Mistral-7B-Instruct-v0.1"],
    requiresKey: true,
    local: false,
  },
  lmstudio: {
    name: "LM Studio",
    apiKeyVar: null,
    baseUrl: "http://localhost:1234/v1",
    models: ["local-model"],
    requiresKey: false,
    local: true,
  },
  ollama: {
    name: "Ollama",
    apiKeyVar: null,
    baseUrl: "http://localhost:11434/v1",
    models: ["mistral", "llama2", "neural-chat"],
    requiresKey: false,
    local: true,
  },
};

/**
 * Read .env file. Preserves values that contain '=' (e.g. base64 keys).
 * Strips surrounding quotes. Ignores comments and blank lines.
 */
export function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};

  const content = fs.readFileSync(ENV_FILE, "utf8");
  const env = {};

  content.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const idx = line.indexOf("=");
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  });

  return env;
}

/**
 * Write .env file. Preserves comment lines + key ordering from the existing
 * file when possible; new keys are appended at the end.
 */
export function writeEnv(env) {
  let original = "";
  if (fs.existsSync(ENV_FILE)) {
    original = fs.readFileSync(ENV_FILE, "utf8");
  }

  const written = new Set();
  const out = [];

  for (const rawLine of original.split("\n")) {
    const line = rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    if (!(key in env)) {
      out.push(line); // keep as-is
      continue;
    }
    const value = env[key];
    // LLM-1: previously empty values for existing keys silently DROPPED the
    // line entirely — an operator clearing a field via the wizard would
    // find the env var deleted, not set to "". Treat undefined as drop
    // (explicit "remove this key"); empty-string keeps the key with empty
    // value so semantics are consistent with "value cleared, not removed".
    if (value == null) continue;      // explicit deletion
    out.push(`${key}=${value}`);       // empty-string is preserved as `KEY=`
    written.add(key);
  }

  // Append any new keys
  for (const [key, value] of Object.entries(env)) {
    if (written.has(key) || value == null || value === "") continue;
    out.push(`${key}=${value}`);
  }

  // Normalize trailing newline
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  atomicWriteText(ENV_FILE, text);
}

/**
 * Read user-config.json
 */
export function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Write user-config.json
 */
export function writeConfig(config) {
  atomicWriteJson(CONFIG_FILE, config);
}

/**
 * Read customProviders[] from user-config.json
 */
export function listCustomProviders() {
  const cfg = readConfig();
  return Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
}

/**
 * Find a custom provider entry by id (case-insensitive).
 */
export function findCustomProvider(providerId) {
  const id = String(providerId || "").toLowerCase();
  return listCustomProviders().find(
    (p) => p && typeof p.id === "string" && p.id.toLowerCase() === id
  ) || null;
}

/**
 * Add (or replace) a custom provider entry. Returns the merged config slice.
 * Required fields: id, baseUrl. Optional: name, apiKeyEnv, apiKey, defaultModel,
 * headers, features.
 */
export function addCustomProvider(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("addCustomProvider: entry must be an object");
  }
  if (!entry.id || typeof entry.id !== "string") {
    throw new Error("addCustomProvider: 'id' is required");
  }
  if (!entry.baseUrl || typeof entry.baseUrl !== "string") {
    throw new Error("addCustomProvider: 'baseUrl' is required");
  }
  if (PROVIDERS[entry.id]) {
    throw new Error(
      `addCustomProvider: '${entry.id}' collides with a built-in provider — pick a different id`
    );
  }

  const cfg = readConfig();
  const list = Array.isArray(cfg.customProviders) ? cfg.customProviders.slice() : [];
  const idx = list.findIndex(
    (p) => p && typeof p.id === "string" && p.id.toLowerCase() === entry.id.toLowerCase()
  );

  const normalized = {
    id: entry.id,
    name: entry.name || entry.id,
    baseUrl: entry.baseUrl,
    apiKeyEnv: entry.apiKeyEnv || `${entry.id.toUpperCase()}_API_KEY`,
    defaultModel: entry.defaultModel || "auto",
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.features ? { features: entry.features } : {}),
  };

  if (idx >= 0) list[idx] = normalized;
  else list.push(normalized);

  cfg.customProviders = list;
  writeConfig(cfg);
  return { success: true, action: idx >= 0 ? "updated" : "added", entry: normalized };
}

/**
 * Add a preset from CUSTOM_PRESETS. Optionally override fields (e.g. defaultModel).
 */
export function addPreset(presetId, overrides = {}) {
  const preset = CUSTOM_PRESETS[presetId];
  if (!preset) {
    throw new Error(
      `Unknown preset: ${presetId}. Available: ${Object.keys(CUSTOM_PRESETS).join(", ")}`
    );
  }
  return addCustomProvider({ ...preset, ...overrides });
}

/**
 * Remove a custom provider by id.
 */
export function removeCustomProvider(providerId) {
  const cfg = readConfig();
  const list = Array.isArray(cfg.customProviders) ? cfg.customProviders : [];
  const filtered = list.filter(
    (p) => !(p && typeof p.id === "string" && p.id.toLowerCase() === String(providerId).toLowerCase())
  );
  if (filtered.length === list.length) {
    return { success: false, error: `No custom provider with id '${providerId}'` };
  }
  cfg.customProviders = filtered;
  writeConfig(cfg);
  return { success: true, removed: providerId };
}

/**
 * Set provider globally. Supports built-in providers AND user-defined custom
 * providers (matched by id from customProviders[]).
 *
 * Also writes LLM_MODEL to .env: agent.js reads process.env.LLM_MODEL first
 * and falls through to config.llmModel only if the env var is unset, so the
 * .env value would otherwise pin the old model after a provider switch.
 */
export function setProvider(providerId, apiKey = null) {
  const custom = findCustomProvider(providerId);
  if (custom) {
    const env = readEnv();
    const config = readConfig();
    env.LLM_PROVIDER = providerId;
    if (custom.baseUrl) env.LLM_BASE_URL = custom.baseUrl;
    if (custom.defaultModel) env.LLM_MODEL = custom.defaultModel;
    if (apiKey && custom.apiKeyEnv) env[custom.apiKeyEnv] = apiKey;
    writeEnv(env);

    config.llmProvider = providerId;
    config.llmModel = custom.defaultModel || "auto";
    if (custom.baseUrl) config.llmBaseUrl = custom.baseUrl;
    writeConfig(config);

    return {
      success: true,
      provider: providerId,
      message: `Provider set to ${custom.name || providerId} (custom)`,
    };
  }

  if (!PROVIDERS[providerId]) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const provider = PROVIDERS[providerId];
  const env = readEnv();
  const config = readConfig();

  // Update .env
  env.LLM_PROVIDER = providerId;

  if (provider.baseUrl) {
    env.LLM_BASE_URL = provider.baseUrl;
  }

  if (provider.models && provider.models[0]) {
    env.LLM_MODEL = provider.models[0];
  }

  if (apiKey && provider.apiKeyVar) {
    env[provider.apiKeyVar] = apiKey;
  }

  writeEnv(env);

  // Update user-config.json
  config.llmProvider = providerId;
  config.llmModel = provider.models[0];

  if (provider.baseUrl) {
    config.llmBaseUrl = provider.baseUrl;
  }

  writeConfig(config);

  return {
    success: true,
    provider: providerId,
    message: `Provider set to ${provider.name}`,
  };
}

/**
 * Get current provider. Resolves from customProviders[] first when applicable.
 */
export function getCurrentProvider() {
  const env = readEnv();
  const providerId = env.LLM_PROVIDER || "openrouter";

  const custom = findCustomProvider(providerId);
  if (custom) {
    const keyVar = custom.apiKeyEnv || "LLM_API_KEY";
    return {
      id: providerId,
      name: custom.name || providerId,
      model: env.LLM_MODEL || custom.defaultModel || "default",
      baseUrl: env.LLM_BASE_URL || custom.baseUrl,
      local: false,
      custom: true,
      hasApiKey: !!(env[keyVar] || env.LLM_API_KEY || custom.apiKey),
    };
  }

  const provider = PROVIDERS[providerId];
  if (!provider) {
    return {
      id: providerId,
      name: providerId,
      model: env.LLM_MODEL || "default",
      baseUrl: env.LLM_BASE_URL || null,
      local: false,
      hasApiKey: false,
    };
  }

  return {
    id: providerId,
    name: provider.name,
    model: env.LLM_MODEL || "default",
    baseUrl: env.LLM_BASE_URL || provider.baseUrl,
    local: provider.local,
    custom: false,
    hasApiKey: provider.apiKeyVar ? !!env[provider.apiKeyVar] : true,
  };
}

/**
 * Validate provider configuration. Handles built-in and custom providers.
 */
export function validateProvider(providerId) {
  const custom = findCustomProvider(providerId);
  if (custom) {
    const env = readEnv();
    const errors = [];
    if (!custom.baseUrl) errors.push(`Custom provider '${providerId}' missing baseUrl`);
    const keyVar = custom.apiKeyEnv || "LLM_API_KEY";
    if (!env[keyVar] && !env.LLM_API_KEY && !custom.apiKey) {
      errors.push(`Missing API key: set ${keyVar} in .env (or apiKey inline in customProviders)`);
    }
    return { valid: errors.length === 0, errors };
  }

  const provider = PROVIDERS[providerId];
  if (!provider) {
    return {
      valid: false,
      errors: [`Unknown provider: ${providerId}`],
    };
  }

  const errors = [];
  const env = readEnv();

  // Check API key
  if (provider.requiresKey) {
    if (!env[provider.apiKeyVar]) {
      errors.push(
        `Missing API key: Set ${provider.apiKeyVar} in .env`
      );
    }
  }

  // Check base URL for local
  if (provider.local) {
    if (!env.LLM_BASE_URL) {
      errors.push(`Missing base URL: Set LLM_BASE_URL in .env`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * List all providers with status. Includes custom providers from user-config.json.
 */
export function listProviders() {
  const builtIns = Object.entries(PROVIDERS).map(([id, provider]) => {
    const validation = validateProvider(id);
    return {
      id,
      name: provider.name,
      local: provider.local,
      requiresKey: provider.requiresKey,
      models: provider.models,
      valid: validation.valid,
      custom: false,
    };
  });

  const customs = listCustomProviders().map((entry) => {
    const validation = validateProvider(entry.id);
    return {
      id: entry.id,
      name: entry.name || entry.id,
      local: false,
      requiresKey: true,
      models: entry.defaultModel ? [entry.defaultModel] : ["auto"],
      valid: validation.valid,
      custom: true,
    };
  });

  return [...builtIns, ...customs];
}

/**
 * Quick switch to provider with template. Supports built-in and custom providers.
 */
export function quickSwitch(providerId) {
  const custom = findCustomProvider(providerId);
  if (custom) {
    const env = readEnv();
    const config = readConfig();
    env.LLM_PROVIDER = providerId;
    if (custom.baseUrl) env.LLM_BASE_URL = custom.baseUrl;
    // agent.js reads process.env.LLM_MODEL before config.llmModel; if we only
    // wrote the config the old env value would still win, so update both.
    if (custom.defaultModel) env.LLM_MODEL = custom.defaultModel;
    writeEnv(env);

    config.llmProvider = providerId;
    config.llmModel = custom.defaultModel || "auto";
    if (custom.baseUrl) config.llmBaseUrl = custom.baseUrl;
    writeConfig(config);

    const keyVar = custom.apiKeyEnv || "LLM_API_KEY";
    return {
      success: true,
      provider: providerId,
      message: `Switched to ${custom.name || providerId} (custom)`,
      needsKey: !env[keyVar] && !env.LLM_API_KEY && !custom.apiKey,
      keyVar,
    };
  }

  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }

  const env = readEnv();
  const config = readConfig();

  // Update provider
  env.LLM_PROVIDER = providerId;

  if (provider.baseUrl) {
    env.LLM_BASE_URL = provider.baseUrl;
  }

  // Also write LLM_MODEL — env var wins over config.llmModel in agent.js, so
  // leaving the old value would silently pin the previous provider's model.
  if (provider.models && provider.models[0]) {
    env.LLM_MODEL = provider.models[0];
  }

  // NOTE: Previously this wiped every *_API_KEY. That destroyed credentials
  // for other providers the user might want to switch back to. We now keep
  // them in place — the agent only uses the key matching LLM_PROVIDER.
  writeEnv(env);

  // Update config
  config.llmProvider = providerId;
  config.llmModel = provider.models[0];
  if (provider.baseUrl) {
    config.llmBaseUrl = provider.baseUrl;
  }

  writeConfig(config);

  return {
    success: true,
    provider: providerId,
    message: `Switched to ${provider.name}`,
    needsKey: provider.requiresKey,
    keyVar: provider.apiKeyVar,
  };
}

/**
 * Set model for current provider
 */
export function setModel(model) {
  const env = readEnv();
  const config = readConfig();

  env.LLM_MODEL = model;
  config.llmModel = model;

  writeEnv(env);
  writeConfig(config);

  return {
    success: true,
    model,
    message: `Model set to ${model}`,
  };
}

/**
 * Get provider info (built-in or custom).
 */
export function getProviderInfo(providerId) {
  const custom = findCustomProvider(providerId);
  if (custom) {
    const validation = validateProvider(providerId);
    return {
      id: providerId,
      name: custom.name || providerId,
      apiKeyVar: custom.apiKeyEnv || "LLM_API_KEY",
      baseUrl: custom.baseUrl,
      models: custom.defaultModel ? [custom.defaultModel] : ["auto"],
      requiresKey: true,
      local: false,
      custom: true,
      valid: validation.valid,
      errors: validation.errors,
    };
  }

  const provider = PROVIDERS[providerId];
  if (!provider) return null;

  const validation = validateProvider(providerId);

  return {
    id: providerId,
    ...provider,
    valid: validation.valid,
    errors: validation.errors,
  };
}

/**
 * Test provider connection (simple check).
 */
export async function testProvider(providerId) {
  const custom = findCustomProvider(providerId);
  if (custom) {
    const env = readEnv();
    const keyVar = custom.apiKeyEnv || "LLM_API_KEY";
    if (!env[keyVar] && !env.LLM_API_KEY && !custom.apiKey) {
      return { success: false, message: `❌ API key not set (${keyVar})` };
    }
    if (!custom.baseUrl) {
      return { success: false, message: `❌ baseUrl missing on custom provider '${providerId}'` };
    }
    return { success: true, message: `✅ Custom provider '${custom.name || providerId}' looks configured` };
  }

  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { success: false, error: "Unknown provider" };
  }

  const env = readEnv();

  // Local providers - just check if base URL responds
  if (provider.local) {
    try {
      const baseUrl = env.LLM_BASE_URL || provider.baseUrl;
      const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(15000) });
      return {
        success: response.ok,
        message: response.ok
          ? "✅ Provider is running"
          : `❌ Error: ${response.status}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Connection error: ${error.message}`,
      };
    }
  }

  // Cloud providers - check API key
  const apiKeyVar = provider.apiKeyVar;
  if (!env[apiKeyVar]) {
    return {
      success: false,
      message: `❌ API key not set (${apiKeyVar})`,
    };
  }

  return {
    success: true,
    message: "✅ Configuration looks good",
  };
}

/**
 * Export configuration template
 */
export function exportConfig(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;

  const env = readEnv();
  const config = readConfig();

  return {
    ".env": {
      LLM_PROVIDER: providerId,
      LLM_BASE_URL: provider.baseUrl || "",
      [provider.apiKeyVar]: env[provider.apiKeyVar] || "YOUR_API_KEY",
    },
    "user-config.json": {
      llmProvider: providerId,
      llmModel: provider.models[0],
      llmBaseUrl: provider.baseUrl,
    },
  };
}

export default {
  PROVIDERS,
  CUSTOM_PRESETS,
  readEnv,
  writeEnv,
  readConfig,
  writeConfig,
  setProvider,
  getCurrentProvider,
  validateProvider,
  listProviders,
  quickSwitch,
  setModel,
  getProviderInfo,
  testProvider,
  exportConfig,
  listCustomProviders,
  findCustomProvider,
  addCustomProvider,
  addPreset,
  removeCustomProvider,
};
