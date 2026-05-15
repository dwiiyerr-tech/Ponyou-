#!/usr/bin/env node

/**
 * Ponyou LLM Provider Setup Wizard
 * Interactive tool untuk configure/switch LLM providers
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// Provider templates
const PROVIDER_TEMPLATES = {
  openrouter: {
    name: "🔄 OpenRouter (Default - Recommended)",
    description: "Multi-model support (Claude, GPT, Mistral, etc.)",
    env: {
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-v1-xxxxxxxxxxxxx",
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
    },
    config: {
      llmProvider: "openrouter",
      llmModel: "openrouter/auto",
      llmBaseUrl: "https://openrouter.ai/api/v1",
    },
    cost: "$",
    speed: "Fast",
    local: false,
  },

  openai: {
    name: "🔷 OpenAI (GPT-4, GPT-3.5)",
    description: "Official OpenAI API - GPT-4 Turbo, Vision",
    env: {
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-proj-xxxxxxxxxxxxx",
      LLM_BASE_URL: "https://api.openai.com/v1",
    },
    config: {
      llmProvider: "openai",
      llmModel: "gpt-4-turbo-preview",
      llmBaseUrl: "https://api.openai.com/v1",
    },
    cost: "$$",
    speed: "Fast",
    local: false,
  },

  anthropic: {
    name: "🧠 Anthropic Claude (Best Reasoning)",
    description: "Claude Opus, Sonnet, Haiku - excellent reasoning",
    env: {
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxxx",
    },
    config: {
      llmProvider: "anthropic",
      llmModel: "claude-opus-4-1",
    },
    cost: "$$",
    speed: "Medium",
    local: false,
  },

  groq: {
    name: "⚡ Groq (Fast & Free!)",
    description: "Lightning-fast inference, free tier with rate limit",
    env: {
      LLM_PROVIDER: "groq",
      GROQ_API_KEY: "gsk_xxxxxxxxxxxxx",
      LLM_BASE_URL: "https://api.groq.com/openai/v1",
    },
    config: {
      llmProvider: "groq",
      llmModel: "mixtral-8x7b-32768",
      llmBaseUrl: "https://api.groq.com/openai/v1",
    },
    cost: "Free",
    speed: "Very Fast",
    local: false,
  },

  mistral: {
    name: "✨ Mistral AI (European)",
    description: "Mistral 7B, Mistral Large - good balance",
    env: {
      LLM_PROVIDER: "mistral",
      MISTRAL_API_KEY: "xxxxxxxxxxxxx",
      LLM_BASE_URL: "https://api.mistral.ai/v1",
    },
    config: {
      llmProvider: "mistral",
      llmModel: "mistral-large-latest",
      llmBaseUrl: "https://api.mistral.ai/v1",
    },
    cost: "$",
    speed: "Fast",
    local: false,
  },

  together: {
    name: "🤝 Together AI (Open Source)",
    description: "Multiple open-source models, good prices",
    env: {
      LLM_PROVIDER: "together",
      TOGETHER_API_KEY: "xxxxxxxxxxxxx",
      LLM_BASE_URL: "https://api.together.xyz/v1",
    },
    config: {
      llmProvider: "together",
      llmModel: "mistralai/Mistral-7B-Instruct-v0.1",
      llmBaseUrl: "https://api.together.xyz/v1",
    },
    cost: "$",
    speed: "Fast",
    local: false,
  },

  lmstudio: {
    name: "💻 LM Studio (Local - Free!)",
    description: "100% private, run locally, no API key needed",
    env: {
      LLM_PROVIDER: "lmstudio",
      LLM_BASE_URL: "http://localhost:1234/v1",
    },
    config: {
      llmProvider: "lmstudio",
      llmModel: "local-model",
      llmBaseUrl: "http://localhost:1234/v1",
    },
    cost: "Free",
    speed: "Medium",
    local: true,
    setup: "Download from https://lmstudio.ai, load model, run",
  },

  ollama: {
    name: "🐳 Ollama (Docker-Friendly - Free!)",
    description: "Docker support, pull models easily",
    env: {
      LLM_PROVIDER: "ollama",
      LLM_BASE_URL: "http://localhost:11434/v1",
    },
    config: {
      llmProvider: "ollama",
      llmModel: "mistral",
      llmBaseUrl: "http://localhost:11434/v1",
    },
    cost: "Free",
    speed: "Slow",
    local: true,
    setup: "ollama pull mistral && ollama serve",
  },
};

async function showMenu() {
  console.clear();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     PONYOU LLM PROVIDER SETUP WIZARD                     ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("Pilih opsi:");
  console.log("1. 🚀 Setup Provider Baru");
  console.log("2. 🔄 Switch Provider");
  console.log("3. 📋 Lihat Konfigurasi Sekarang");
  console.log("4. 📚 Info Provider");
  console.log("5. ✅ Validate Configuration");
  console.log("6. 🔧 Edit Manual (.env)");
  console.log("7. ❌ Exit");
  console.log("");

  const choice = await question("Pilih (1-7): ");
  return choice;
}

async function selectProvider() {
  console.log("\n🌐 Pilih Provider:\n");
  const providers = Object.entries(PROVIDER_TEMPLATES);
  providers.forEach(([key, config], index) => {
    console.log(
      `${index + 1}. ${config.name} (${config.cost} - ${config.speed}${config.local ? " - Local" : ""})`
    );
  });
  console.log(`${providers.length + 1}. Kembali`);

  const choice = await question("\nPilih (1-9): ");
  const index = parseInt(choice) - 1;

  if (index < 0 || index >= providers.length) return null;
  return providers[index][0];
}

async function setupProvider(providerId) {
  const template = PROVIDER_TEMPLATES[providerId];
  if (!template.local) {
    console.log(`\n🔑 Setup ${template.name}`);
    console.log(`📖 Buka: ${getProviderURL(providerId)}\n`);

    const apiKey = await question(
      `Masukkan API Key untuk ${providerId} (atau 'skip' untuk skip): `
    );

    if (apiKey.toLowerCase() === "skip") return null;

    return { providerId, apiKey };
  } else {
    console.log(`\n💻 Setup ${template.name}`);
    console.log(`Setup Instructions: ${template.setup}\n`);
    const confirm = await question("Sudah setup? (y/n): ");
    return confirm.toLowerCase() === "y" ? { providerId } : null;
  }
}

function getProviderURL(providerId) {
  const urls = {
    openrouter: "https://openrouter.ai/keys",
    openai: "https://platform.openai.com/account/api-keys",
    anthropic: "https://console.anthropic.com",
    groq: "https://console.groq.com/keys",
    mistral: "https://console.mistral.ai/api-keys/",
    together: "https://www.together.ai/settings/accounts/api-keys",
  };
  return urls[providerId] || "#";
}

function saveEnvFile(providerId, apiKey) {
  const template = PROVIDER_TEMPLATES[providerId];
  let envContent = "";

  // Read existing .env jika ada
  if (fs.existsSync(".env")) {
    envContent = fs.readFileSync(".env", "utf8");
  }

  // Update atau tambah LLM_PROVIDER dan keys
  const lines = envContent.split("\n");
  const newLines = [];
  const keysToUpdate = ["LLM_PROVIDER", "LLM_BASE_URL"];
  const apiKeyVar = Object.keys(template.env).find(
    (k) => k.includes("API_KEY") && k !== "LLM_API_KEY"
  );

  if (apiKeyVar) keysToUpdate.push(apiKeyVar);

  // Filter existing keys
  for (const line of lines) {
    const key = line.split("=")[0];
    if (!keysToUpdate.includes(key)) {
      newLines.push(line);
    }
  }

  // Add new keys
  newLines.push("");
  newLines.push("# ─── LLM Provider Configuration ────────────────");
  newLines.push(`LLM_PROVIDER=${template.env.LLM_PROVIDER}`);

  if (template.env.LLM_BASE_URL) {
    newLines.push(`LLM_BASE_URL=${template.env.LLM_BASE_URL}`);
  }

  if (apiKeyVar && apiKey) {
    newLines.push(`${apiKeyVar}=${apiKey}`);
  }

  fs.writeFileSync(".env", newLines.join("\n"));
  console.log("✅ .env file updated");
}

function saveConfigFile(providerId) {
  const template = PROVIDER_TEMPLATES[providerId];
  const configPath = "user-config.json";

  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  // Update LLM settings
  config.llmProvider = template.config.llmProvider;
  config.llmModel = template.config.llmModel;
  if (template.config.llmBaseUrl) {
    config.llmBaseUrl = template.config.llmBaseUrl;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("✅ user-config.json updated");
}

function showCurrentConfig() {
  console.log("\n📋 Current Configuration:\n");

  if (fs.existsSync(".env")) {
    const envContent = fs.readFileSync(".env", "utf8");
    const provider = envContent.match(/LLM_PROVIDER=(\S+)/)?.[1] || "Not set";
    const apiKey = envContent.match(/API_KEY=(\S+)/)?.[1] || "Not set";
    const baseUrl = envContent.match(/LLM_BASE_URL=(\S+)/)?.[1] || "Default";

    console.log(`Provider: ${provider}`);
    console.log(
      `API Key: ${apiKey === "Not set" ? "❌ Not set" : "✅ " + apiKey.substring(0, 10) + "..."}`
    );
    console.log(`Base URL: ${baseUrl}`);
  } else {
    console.log("❌ .env file not found");
  }

  if (fs.existsSync("user-config.json")) {
    const config = JSON.parse(fs.readFileSync("user-config.json", "utf8"));
    console.log(`\nuser-config.json:`);
    console.log(`  llmProvider: ${config.llmProvider || "default"}`);
    console.log(`  llmModel: ${config.llmModel || "default"}`);
  }

  console.log("");
}

function showProviderInfo() {
  console.log("\n📚 Provider Information:\n");

  Object.entries(PROVIDER_TEMPLATES).forEach(([id, config]) => {
    console.log(`${config.name}`);
    console.log(`  Description: ${config.description}`);
    console.log(`  Cost: ${config.cost}`);
    console.log(`  Speed: ${config.speed}`);
    console.log(`  Local: ${config.local ? "Yes ✅" : "No ❌"}`);
    if (config.setup) {
      console.log(`  Setup: ${config.setup}`);
    }
    console.log("");
  });
}

function validateConfig() {
  console.log("\n✅ Validating Configuration...\n");

  let valid = true;

  if (!fs.existsSync(".env")) {
    console.log("❌ .env file not found");
    valid = false;
  } else {
    const envContent = fs.readFileSync(".env", "utf8");
    const provider =
      envContent.match(/LLM_PROVIDER=(\S+)/)?.[1] || "not set";

    console.log(`Provider: ${provider}`);

    // Check API key
    if (provider === "lmstudio" || provider === "ollama") {
      console.log("✅ Local provider - no API key needed");
    } else {
      const hasKey =
        envContent.includes("_API_KEY=") &&
        !envContent.match(/_API_KEY=xxx/);
      console.log(`API Key: ${hasKey ? "✅ Set" : "❌ Not set"}`);
      if (!hasKey) valid = false;
    }

    // Check base URL untuk local
    if (provider === "lmstudio") {
      const url = envContent.match(/LLM_BASE_URL=(\S+)/)?.[1];
      console.log(
        `Base URL: ${url ? "✅ " + url : "❌ Not configured"}`
      );
      if (!url) valid = false;
    }
  }

  if (!fs.existsSync("user-config.json")) {
    console.log("⚠️  user-config.json not found (optional)");
  }

  console.log(`\n${valid ? "✅ Configuration valid!" : "❌ Configuration has issues"}\n`);
  return valid;
}

async function main() {
  let running = true;

  while (running) {
    const choice = await showMenu();

    switch (choice) {
      case "1": {
        // Setup Provider Baru
        const provider = await selectProvider();
        if (provider) {
          const setup = await setupProvider(provider);
          if (setup) {
            saveEnvFile(provider, setup.apiKey);
            saveConfigFile(provider);
            console.log(
              `\n✅ ${PROVIDER_TEMPLATES[provider].name} berhasil dikonfigurasi!\n`
            );
            console.log("📝 Restart agent untuk apply perubahan:");
            console.log("   npm start\n");
          }
        }
        break;
      }

      case "2": {
        // Switch Provider
        const provider = await selectProvider();
        if (provider) {
          const setup = await setupProvider(provider);
          if (setup) {
            saveEnvFile(provider, setup.apiKey);
            saveConfigFile(provider);
            console.log(
              `\n✅ Switched to ${PROVIDER_TEMPLATES[provider].name}!\n`
            );
          }
        }
        break;
      }

      case "3": {
        // View Current Config
        showCurrentConfig();
        await question("Press Enter to continue...");
        break;
      }

      case "4": {
        // Provider Info
        showProviderInfo();
        await question("Press Enter to continue...");
        break;
      }

      case "5": {
        // Validate
        validateConfig();
        await question("Press Enter to continue...");
        break;
      }

      case "6": {
        // Edit Manual
        console.log("\n🔧 Buka .env dengan text editor Anda");
        console.log("   nano .env");
        console.log("   atau text editor favorit Anda\n");
        await question("Press Enter setelah selesai edit...");
        break;
      }

      case "7": {
        running = false;
        console.log("\n👋 Goodbye!\n");
        break;
      }

      default:
        console.log("❌ Invalid choice");
    }
  }

  rl.close();
}

main().catch(console.error);
