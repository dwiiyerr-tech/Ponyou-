/**
 * LLM Manager - Utility untuk manage provider configuration
 * Digunakan oleh setup-llm.js dan dapat digunakan secara programmatic
 */

import fs from "fs";
import path from "path";

const ENV_FILE = ".env";
const CONFIG_FILE = "user-config.json";

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
 * Read .env file
 */
export function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};

  const content = fs.readFileSync(ENV_FILE, "utf8");
  const env = {};

  content.split("\n").forEach((line) => {
    const [key, value] = line.split("=");
    if (key && value) {
      env[key.trim()] = value.trim();
    }
  });

  return env;
}

/**
 * Write .env file
 */
export function writeEnv(env) {
  const lines = [];

  Object.entries(env).forEach(([key, value]) => {
    if (value) {
      lines.push(`${key}=${value}`);
    }
  });

  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Set provider globally
 */
export function setProvider(providerId, apiKey = null) {
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
 * Get current provider
 */
export function getCurrentProvider() {
  const env = readEnv();
  const providerId = env.LLM_PROVIDER || "openrouter";
  const provider = PROVIDERS[providerId];

  return {
    id: providerId,
    name: provider.name,
    model: env.LLM_MODEL || "default",
    baseUrl: env.LLM_BASE_URL || provider.baseUrl,
    local: provider.local,
    hasApiKey: provider.apiKeyVar ? !!env[provider.apiKeyVar] : true,
  };
}

/**
 * Validate provider configuration
 */
export function validateProvider(providerId) {
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
 * List all providers with status
 */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, provider]) => {
    const validation = validateProvider(id);
    return {
      id,
      name: provider.name,
      local: provider.local,
      requiresKey: provider.requiresKey,
      models: provider.models,
      valid: validation.valid,
    };
  });
}

/**
 * Quick switch to provider with template
 */
export function quickSwitch(providerId) {
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

  // Clear old API keys
  Object.keys(env).forEach((key) => {
    if (key.includes("_API_KEY") && key !== "LLM_API_KEY") {
      delete env[key];
    }
  });

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
 * Get provider info
 */
export function getProviderInfo(providerId) {
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
 * Test provider connection (simple check)
 */
export async function testProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { success: false, error: "Unknown provider" };
  }

  const env = readEnv();

  // Local providers - just check if base URL responds
  if (provider.local) {
    try {
      const baseUrl = env.LLM_BASE_URL || provider.baseUrl;
      const response = await fetch(`${baseUrl}/models`);
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
};
