#!/usr/bin/env node

/**
 * Ponyou LLM CLI - Command-line interface untuk manage LLM providers
 * Usage:
 *   node llm-cli.js list                    - List all providers
 *   node llm-cli.js current                 - Show current provider
 *   node llm-cli.js switch <provider>       - Switch to provider
 *   node llm-cli.js set-key <provider> <key> - Set API key
 *   node llm-cli.js validate                - Validate configuration
 *   node llm-cli.js test <provider>         - Test provider connection
 *   node llm-cli.js info <provider>         - Show provider info
 */

import {
  PROVIDERS,
  getCurrentProvider,
  listProviders,
  setProvider,
  quickSwitch,
  validateProvider,
  testProvider,
  getProviderInfo,
  readEnv,
  writeEnv,
} from "./llm-manager.js";

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

function printError(msg) {
  console.error(`\n❌ Error: ${msg}\n`);
  process.exit(1);
}

function printSuccess(msg) {
  console.log(`\n✅ ${msg}\n`);
}

async function main() {
  switch (command) {
    case "list": {
      console.log("\n🌐 Available Providers:\n");
      listProviders().forEach((p) => {
        const status = p.valid ? "✅" : "⚠️";
        const local = p.local ? " (Local)" : " (Cloud)";
        console.log(`${status} ${p.name}${local}`);
        console.log(`   Models: ${p.models.join(", ")}`);
        console.log("");
      });
      break;
    }

    case "current": {
      const current = getCurrentProvider();
      console.log("\n📌 Current Provider:\n");
      console.log(`Provider: ${current.name} (${current.id})`);
      console.log(`Model: ${current.model}`);
      console.log(`Base URL: ${current.baseUrl}`);
      console.log(`Local: ${current.local ? "Yes" : "No"}`);
      console.log(`API Key: ${current.hasApiKey ? "✅ Set" : "❌ Not set"}`);
      console.log("");
      break;
    }

    case "switch": {
      if (!arg1) printError("Usage: llm-cli.js switch <provider>");

      const provider = PROVIDERS[arg1];
      if (!provider) printError(`Unknown provider: ${arg1}`);

      const result = quickSwitch(arg1);

      console.log(`\n✅ Switched to ${provider.name}\n`);

      if (result.needsKey) {
        console.log(`📝 Next step: Set API key in .env`);
        console.log(`   ${result.keyVar}=your_api_key\n`);
      }

      console.log("🔄 Restart agent to apply changes:");
      console.log("   npm start\n");
      break;
    }

    case "set-key": {
      if (!arg1 || !arg2) {
        printError("Usage: llm-cli.js set-key <provider> <api-key>");
      }

      if (!PROVIDERS[arg1]) printError(`Unknown provider: ${arg1}`);

      const result = setProvider(arg1, arg2);
      printSuccess(`${result.message}`);
      break;
    }

    case "validate": {
      console.log("\n🔍 Validating configuration...\n");

      let allValid = true;
      const current = getCurrentProvider();

      listProviders().forEach((p) => {
        const validation = validateProvider(p.id);
        const status = validation.valid ? "✅" : "❌";
        const prefix = p.id === current.id ? "→ " : "  ";

        console.log(`${prefix}${status} ${p.name}`);

        if (validation.errors.length > 0) {
          validation.errors.forEach((err) => {
            console.log(`     ${err}`);
          });
          allValid = false;
        }
      });

      console.log("");

      if (allValid) {
        printSuccess("All configurations are valid!");
      } else {
        console.log("⚠️  Some configurations need attention\n");
      }

      break;
    }

    case "test": {
      if (!arg1) printError("Usage: llm-cli.js test <provider>");
      if (!PROVIDERS[arg1]) printError(`Unknown provider: ${arg1}`);

      console.log(`\n🧪 Testing ${PROVIDERS[arg1].name}...\n`);
      const result = await testProvider(arg1);

      console.log(result.message);
      console.log("");

      if (!result.success) {
        process.exit(1);
      }
      break;
    }

    case "info": {
      if (!arg1) printError("Usage: llm-cli.js info <provider>");

      const info = getProviderInfo(arg1);
      if (!info) printError(`Unknown provider: ${arg1}`);

      console.log(`\n📚 ${info.name}\n`);
      console.log(`ID: ${arg1}`);
      console.log(`Type: ${info.local ? "Local" : "Cloud"}`);
      console.log(`Requires API Key: ${info.requiresKey ? "Yes" : "No"}`);
      console.log(`Models:`);
      info.models.forEach((m) => {
        console.log(`  • ${m}`);
      });

      if (info.baseUrl) {
        console.log(`\nBase URL: ${info.baseUrl}`);
      }

      if (info.errors.length > 0) {
        console.log(`\n⚠️  Configuration issues:`);
        info.errors.forEach((e) => {
          console.log(`  • ${e}`);
        });
      }

      console.log("");
      break;
    }

    case "show-env": {
      console.log("\n📄 Current .env LLM settings:\n");
      const env = readEnv();
      Object.entries(env).forEach(([key, value]) => {
        if (
          key.includes("LLM") ||
          key.includes("_API_KEY") ||
          key.includes("OPENROUTER") ||
          key.includes("OPENAI") ||
          key.includes("ANTHROPIC") ||
          key.includes("GROQ") ||
          key.includes("MISTRAL") ||
          key.includes("TOGETHER")
        ) {
          const displayValue =
            value.length > 15
              ? value.substring(0, 10) + "..." + value.substring(value.length - 5)
              : value;
          console.log(`${key}=${displayValue}`);
        }
      });
      console.log("");
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║         PONYOU LLM CLI - Provider Management Tool          ║
╚════════════════════════════════════════════════════════════╝

Commands:

  list                    List all available providers
  current                 Show current provider configuration
  switch <provider>       Switch to a different provider
  set-key <p> <key>      Set API key for provider
  validate                Validate all provider configurations
  test <provider>         Test provider connection
  info <provider>         Show detailed provider information
  show-env                Show current .env LLM settings
  help                    Show this help message

Examples:

  # List all providers
  node llm-cli.js list

  # Switch to Groq (free & fast)
  node llm-cli.js switch groq

  # Set API key for OpenRouter
  node llm-cli.js set-key openrouter sk-or-v1-xxxxx

  # Test if Groq is working
  node llm-cli.js test groq

  # Show info about Claude API
  node llm-cli.js info anthropic

  # Validate all configurations
  node llm-cli.js validate

Supported Providers:

  ☁️  Cloud Providers:
    • openrouter    - Default, multi-model support
    • openai        - GPT-4, GPT-3.5
    • anthropic     - Claude Opus, Sonnet
    • groq          - Free & very fast
    • mistral       - Mistral AI models
    • together      - Open source models

  💻 Local Providers (Free!):
    • lmstudio      - Desktop app with Mistral, Llama, etc.
    • ollama        - Docker-friendly, pull models easily

Quick Start:

  1. List providers:
     node llm-cli.js list

  2. Switch to your choice:
     node llm-cli.js switch groq

  3. Validate:
     node llm-cli.js validate

  4. Restart Ponyou:
     npm start

`);
      break;
    }

    default: {
      if (!command) {
        console.log("Usage: node llm-cli.js <command> [args]");
        console.log(
          "Run 'node llm-cli.js help' for available commands\n"
        );
      } else {
        printError(`Unknown command: ${command}`);
      }
    }
  }
}

main().catch(console.error);
