/**
 * LLM Provider Abstraction Layer
 * Supports: OpenRouter, OpenAI, Claude API, LM Studio, Ollama, Groq, Together AI, Mistral, Google, Azure, etc.
 */

import OpenAI from "openai";
import { log } from "./logger.js";

// Provider configurations
const PROVIDER_CONFIGS = {
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true,
      vision: true,
      streaming: true,
    },
    defaultModel: "openrouter/auto",
    fallbackModel: "gpt-3.5-turbo",
  },

  openai: {
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true,
      vision: true,
      streaming: true,
    },
    defaultModel: "gpt-4o",
    fallbackModel: "gpt-3.5-turbo",
  },

  anthropic: {
    name: "Anthropic Claude API",
    baseURL: null, // Handled separately
    apiKeyEnv: "ANTHROPIC_API_KEY",
    type: "anthropic-native",
    features: {
      systemRole: true,
      toolChoice: false, // Uses "tool_use" directly
      vision: false,
      streaming: true,
    },
    defaultModel: "claude-opus-4-1",
    fallbackModel: "claude-sonnet-4",
  },

  lmstudio: {
    name: "LM Studio (Local)",
    baseURL: "http://localhost:1234/v1",
    apiKeyEnv: null,
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: false,
      vision: false,
      streaming: true,
    },
    defaultModel: "local-model",
    fallbackModel: "local-model",
  },

  ollama: {
    name: "Ollama (Local)",
    baseURL: "http://localhost:11434/v1",
    apiKeyEnv: null,
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: false,
      vision: false,
      streaming: true,
    },
    defaultModel: "mistral",
    fallbackModel: "mistral",
  },

  groq: {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true,
      vision: false,
      streaming: true,
    },
    defaultModel: "mixtral-8x7b-32768",
    fallbackModel: "llama2-70b-4096",
  },

  together: {
    name: "Together AI",
    baseURL: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: false,
      vision: false,
      streaming: true,
    },
    defaultModel: "mistralai/Mistral-7B-Instruct-v0.1",
    fallbackModel: "mistralai/Mistral-7B-Instruct-v0.1",
  },

  mistral: {
    name: "Mistral AI",
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true,
      vision: false,
      streaming: true,
    },
    defaultModel: "mistral-large-latest",
    fallbackModel: "mistral-medium",
  },

  custom: {
    name: "Custom OpenAI-Compatible",
    baseURL: null, // Must be provided by user
    apiKeyEnv: "LLM_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true,
      vision: false,
      streaming: true,
    },
    defaultModel: "auto",
    fallbackModel: "auto",
  },
};

/**
 * Detect provider from configuration
 */
export function detectProvider(config) {
  const provider = config.llmProvider?.toLowerCase() || "openrouter";

  if (PROVIDER_CONFIGS[provider]) {
    return provider;
  }

  // Try to detect from model name
  if (config.llmModel) {
    const model = config.llmModel.toLowerCase();
    if (model.includes("claude")) return "anthropic";
    if (model.includes("gpt")) return "openai";
    if (model.includes("groq")) return "groq";
    if (model.includes("mistral")) return "mistral";
    if (model.includes("together")) return "together";
  }

  log("llm", `Unknown provider "${provider}", defaulting to "openrouter"`);
  return "openrouter";
}

/**
 * Get provider configuration
 */
export function getProviderConfig(provider = "openrouter") {
  return PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS.openrouter;
}

/**
 * Create LLM client with provider-specific handling
 */
export async function createLLMClient(config) {
  const provider = detectProvider(config);
  const providerConfig = getProviderConfig(provider);

  log("llm", `Initializing ${providerConfig.name} client`);

  // Handle Anthropic Claude API.
  //
  // Ponyou's agent loop is OpenAI-shaped (client.chat.completions.create with
  // OpenAI-style `tools` schema). The Anthropic SDK does NOT expose that shape
  // — it uses client.messages.create with a different tool schema. Plugging the
  // raw Anthropic client into agent.js would crash on first call.
  //
  // Until a proper translator is added, route Claude usage through any
  // OpenAI-compatible Claude gateway (OpenRouter "anthropic/claude-*" models,
  // a self-hosted bridge, etc.) and fail loudly otherwise.
  if (providerConfig.type === "anthropic-native") {
    throw new Error(
      `Anthropic native SDK is not yet wired into Ponyou's OpenAI-shaped agent loop. ` +
      `Use OpenRouter with an "anthropic/..." model instead (set llmProvider=openrouter ` +
      `and llmModel=anthropic/claude-3.5-sonnet, etc.), or run a local Claude→OpenAI bridge.`
    );
  }

  // Handle OpenAI-compatible APIs
  const baseURL =
    config.llmBaseUrl ||
    process.env.LLM_BASE_URL ||
    providerConfig.baseURL;

  if (!baseURL) {
    throw new Error(
      `No baseURL provided for ${providerConfig.name}. Set llmBaseUrl in user-config.json or LLM_BASE_URL in .env`
    );
  }

  const apiKeyEnv = providerConfig.apiKeyEnv || "LLM_API_KEY";
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env[apiKeyEnv] ||
    (provider === "lmstudio" || provider === "ollama" ? "not-needed" : null);

  if (!apiKey && provider !== "lmstudio" && provider !== "ollama") {
    throw new Error(
      `LLM API key not found. Set ${apiKeyEnv} in .env or LLM_API_KEY`
    );
  }

  return new OpenAI({
    baseURL,
    apiKey: apiKey || "dummy-key",
    timeout: 5 * 60 * 1000,
    defaultHeaders: {
      "User-Agent": "Ponyou-Agent/2.2",
    },
  });
}

/**
 * Get provider features for capability checking
 */
export function getProviderFeatures(provider = "openrouter") {
  return getProviderConfig(provider).features;
}

/**
 * Get default model for provider
 */
export function getDefaultModel(provider = "openrouter") {
  return getProviderConfig(provider).defaultModel;
}

/**
 * Handle provider-specific errors and fallbacks
 */
export function handleProviderError(error, provider = "openrouter") {
  const message = String(error?.message || error?.error?.message || error || "");

  // System role rejection
  if (/invalid message role:\s*system/i.test(message)) {
    return { type: "system_role_unsupported", shouldRetry: true };
  }

  // Tool choice not supported
  if (/tool_choice/i.test(message) && /required|not supported/i.test(message)) {
    return { type: "tool_choice_unsupported", shouldRetry: true };
  }

  // Rate limit
  if (/rate limit|429|quota/i.test(message)) {
    return { type: "rate_limited", shouldRetry: true, delay: 30000 };
  }

  // Auth error
  if (/auth|401|unauthorized|invalid.*key/i.test(message)) {
    return { type: "auth_error", shouldRetry: false };
  }

  // Model not found
  if (/model.*not found|does not exist|404/i.test(message)) {
    return { type: "model_not_found", shouldRetry: false };
  }

  // Network error
  if (/ECONNREFUSED|ETIMEDOUT|network|fetch failed/i.test(message)) {
    return { type: "connection_error", shouldRetry: true, delay: 5000 };
  }

  return { type: "unknown_error", shouldRetry: false };
}

/**
 * Map provider model names (for different naming conventions)
 */
export function mapModelName(model, provider = "openrouter") {
  // Add provider-specific model mapping if needed
  const mappings = {
    openrouter: {
      "gpt-4o": "openai/gpt-4-turbo",
      "claude-opus": "anthropic/claude-opus",
    },
    groq: {
      "gpt-4": "mixtral-8x7b-32768",
    },
    mistral: {
      "gpt-4o": "mistral-large-latest",
    },
  };

  return mappings[provider]?.[model] || model;
}

/**
 * Validate provider configuration
 */
export function validateProviderConfig(provider, config) {
  const providerConfig = getProviderConfig(provider);

  if (providerConfig.type === "anthropic-native") {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.LLM_API_KEY) {
      return {
        valid: false,
        error: "Anthropic API key not set (ANTHROPIC_API_KEY or LLM_API_KEY)",
      };
    }
  } else {
    const baseURL =
      config.llmBaseUrl ||
      process.env.LLM_BASE_URL ||
      providerConfig.baseURL;

    if (!baseURL) {
      return {
        valid: false,
        error: `No baseURL configured for ${providerConfig.name}`,
      };
    }

    if (
      provider !== "lmstudio" &&
      provider !== "ollama" &&
      !process.env.LLM_API_KEY &&
      !process.env[providerConfig.apiKeyEnv]
    ) {
      return {
        valid: false,
        error: `No API key set for ${providerConfig.name}`,
      };
    }
  }

  return { valid: true };
}

/**
 * List all available providers
 */
export function listProviders() {
  return Object.entries(PROVIDER_CONFIGS).map(([key, config]) => ({
    id: key,
    name: config.name,
    type: config.type,
    features: config.features,
  }));
}

export default {
  detectProvider,
  getProviderConfig,
  createLLMClient,
  getProviderFeatures,
  getDefaultModel,
  handleProviderError,
  mapModelName,
  validateProviderConfig,
  listProviders,
  PROVIDER_CONFIGS,
};
