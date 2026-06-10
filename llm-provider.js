/**
 * LLM Provider Abstraction Layer
 * Supports: OpenRouter, OpenAI, Claude API, LM Studio, Ollama, Groq, Together AI, Mistral, Google, Azure, etc.
 */

import OpenAI from "openai";
import { log } from "./logger.js";

// Provider configurations
// promptCaching values:
//   "explicit"   — send cache_control:{type:"ephemeral"} on stable content block (Anthropic)
//   "automatic"  — provider caches longest prefix automatically; just keep stable content first
//   false        — no caching support
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
      // Depends on the underlying model: Claude → explicit, GPT → automatic.
      // agent.js resolves this per-model via supportsExplicitCacheControl().
      promptCaching: "model-dependent",
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
      // GPT-4o / o-series: automatic prefix caching for prompts > 1024 tokens.
      // No explicit API call needed; benefit is free when stable content is first.
      promptCaching: "automatic",
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
      // Explicit cache_control per content block. Currently blocked because
      // the agent loop is OpenAI-shaped — use via OpenRouter instead.
      promptCaching: "explicit",
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
      promptCaching: "automatic", // runtime KV cache, always active
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
      promptCaching: "automatic", // runtime KV cache, always active
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
      promptCaching: false, // no prefix caching support
    },
    defaultModel: "mixtral-8x7b-32768",
    fallbackModel: "llama2-70b-4096",
  },

  nvidia: {
    name: "NVIDIA NIM",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true, // llama-3.x nemotron instruct models support OpenAI tools
      vision: false,
      streaming: true,
      promptCaching: false,
    },
    // Instruct model for agent decisions. NOTE: the *-content-safety nemotron
    // variants are moderation classifiers — they cannot drive the agent loop.
    defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1",
    fallbackModel: "meta/llama-3.3-70b-instruct",
  },

  together: {
    name: "Together AI",
    baseURL: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: true,
      vision: false,
      streaming: true,
      promptCaching: false,
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
      promptCaching: false,
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
 * Build a runtime provider config from a user-defined custom provider entry.
 * Treats every custom provider as OpenAI-compatible (the only shape the agent
 * loop currently understands). Falls back to safe defaults for optional fields.
 */
function buildCustomProviderConfig(entry) {
  if (!entry || typeof entry !== "object" || !entry.id) return null;
  return {
    name: entry.name || entry.id,
    baseURL: entry.baseUrl || entry.baseURL || null,
    apiKeyEnv: entry.apiKeyEnv || "LLM_API_KEY",
    inlineApiKey: entry.apiKey || null,
    headers: entry.headers && typeof entry.headers === "object" ? entry.headers : {},
    type: "openai-compatible",
    features: {
      systemRole: true,
      toolChoice: false,
      vision: false,
      streaming: true,
      ...(entry.features || {}),
    },
    defaultModel: entry.defaultModel || "auto",
    fallbackModel: entry.fallbackModel || entry.defaultModel || "auto",
    isCustom: true,
  };
}

/**
 * Look up a user-defined custom provider by id from config.customProviders.
 */
function findCustomProvider(config, providerId) {
  if (!config?.customProviders || !Array.isArray(config.customProviders)) return null;
  const id = String(providerId || "").toLowerCase();
  return config.customProviders.find(
    (p) => p && typeof p.id === "string" && p.id.toLowerCase() === id
  ) || null;
}

/**
 * Detect provider from configuration. Custom providers (user-defined in
 * config.customProviders) take precedence over built-ins, so a user can shadow
 * "openai" with their own gateway if they want.
 */
export function detectProvider(config) {
  const provider = config.llmProvider?.toLowerCase() || "openrouter";

  if (findCustomProvider(config, provider)) {
    return provider;
  }

  if (PROVIDER_CONFIGS[provider]) {
    return provider;
  }

  // Try to detect from model name
  if (config.llmModel) {
    const model = config.llmModel.toLowerCase();
    if (model.includes("claude")) return "anthropic";
    if (model.includes("gpt")) return "openai";
    if (model.includes("nemotron") || model.startsWith("nvidia/")) return "nvidia";
    if (model.includes("groq")) return "groq";
    if (model.includes("mistral")) return "mistral";
    if (model.includes("together")) return "together";
  }

  log("llm", `Unknown provider "${provider}", defaulting to "openrouter"`);
  return "openrouter";
}

/**
 * Get provider configuration. Resolves custom providers from config when given.
 */
export function getProviderConfig(provider = "openrouter", config = null) {
  if (config) {
    const custom = findCustomProvider(config, provider);
    if (custom) {
      const built = buildCustomProviderConfig(custom);
      if (built) return built;
    }
  }
  return PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS.openrouter;
}

/**
 * Create LLM client with provider-specific handling
 */
export async function createLLMClient(config) {
  const provider = detectProvider(config);
  const providerConfig = getProviderConfig(provider, config);

  // Resolve the actual baseURL up front so the init log reflects the real
  // endpoint — otherwise "Initializing OpenRouter client" is misleading when
  // LLM_BASE_URL or config.llmBaseUrl routes elsewhere (e.g. local proxy).
  const resolvedBaseURL =
    config.llmBaseUrl ||
    process.env.LLM_BASE_URL ||
    providerConfig.baseURL ||
    "(none)";

  log("llm", `Initializing ${providerConfig.name} client → ${resolvedBaseURL}`);

  if (!providerConfig.features?.systemRole) {
    log("llm", `Provider ${providerConfig.name} has no system-role support; forcing conservative user-embedded prompting.`);
  }
  if (!providerConfig.features?.toolChoice) {
    log("llm", `Provider ${providerConfig.name} has no trusted tool-choice support; live actions will use conservative auto mode.`);
  }

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
  if (resolvedBaseURL === "(none)") {
    throw new Error(
      `No baseURL provided for ${providerConfig.name}. Set llmBaseUrl in user-config.json or LLM_BASE_URL in .env`
    );
  }

  const apiKeyEnv = providerConfig.apiKeyEnv || "LLM_API_KEY";
  const isLocal = provider === "lmstudio" || provider === "ollama";
  const apiKey =
    process.env[apiKeyEnv] ||
    process.env.LLM_API_KEY ||
    providerConfig.inlineApiKey ||
    config.llmApiKey ||
    (isLocal ? "not-needed" : null);

  if (!apiKey && !isLocal) {
    throw new Error(
      `LLM API key not found. Set ${apiKeyEnv} in .env or LLM_API_KEY`
    );
  }

  return new OpenAI({
    baseURL: resolvedBaseURL,
    apiKey: apiKey || "dummy-key",
    timeout: 5 * 60 * 1000,
    defaultHeaders: {
      "User-Agent": "Ponyou-Agent/2.2",
      ...(providerConfig.headers || {}),
    },
  });
}

/**
 * Get provider features for capability checking
 */
export function getProviderFeatures(provider = "openrouter", config = null) {
  return getProviderConfig(provider, config).features;
}

/**
 * Get default model for provider
 */
export function getDefaultModel(provider = "openrouter", config = null) {
  return getProviderConfig(provider, config).defaultModel;
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
  const providerConfig = getProviderConfig(provider, config);

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

    const isLocal = provider === "lmstudio" || provider === "ollama";
    const hasKey =
      process.env.LLM_API_KEY ||
      process.env[providerConfig.apiKeyEnv] ||
      providerConfig.inlineApiKey ||
      config.llmApiKey;

    if (!isLocal && !hasKey) {
      return {
        valid: false,
        error: `No API key set for ${providerConfig.name}`,
      };
    }
  }

  return { valid: true };
}

/**
 * List all available providers. Includes user-defined custom providers when a
 * config object with `customProviders` is passed in.
 */
export function listProviders(config = null) {
  const builtIns = Object.entries(PROVIDER_CONFIGS).map(([key, c]) => ({
    id: key,
    name: c.name,
    type: c.type,
    features: c.features,
    custom: false,
  }));

  if (!config?.customProviders || !Array.isArray(config.customProviders)) {
    return builtIns;
  }

  const seen = new Set(builtIns.map((p) => p.id));
  const customs = config.customProviders
    .filter((p) => p && typeof p.id === "string" && !seen.has(p.id.toLowerCase()))
    .map((p) => {
      const built = buildCustomProviderConfig(p);
      return {
        id: p.id,
        name: built?.name || p.id,
        type: "openai-compatible",
        features: built?.features || {},
        custom: true,
      };
    });

  return [...builtIns, ...customs];
}

// ── LLM liveness marker ───────────────────────────────────────────────────
// The health-watchdog asserts the LLM actually COMPLETES calls — a client
// that initializes fine but never succeeds (proxy down for 8 days, June 2026)
// is indistinguishable from healthy without this.
let _lastLlmSuccessTs = null;
export function markLlmSuccess() { _lastLlmSuccessTs = Date.now(); }
export function getLastLlmSuccessTs() { return _lastLlmSuccessTs; }
export function _resetLlmSuccessTs() { _lastLlmSuccessTs = null; }

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
