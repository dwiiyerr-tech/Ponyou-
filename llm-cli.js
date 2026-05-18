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
  CUSTOM_PRESETS,
  getCurrentProvider,
  listProviders,
  setProvider,
  quickSwitch,
  validateProvider,
  testProvider,
  getProviderInfo,
  readEnv,
  writeEnv,
  listCustomProviders,
  addCustomProvider,
  addPreset,
  removeCustomProvider,
} from "./llm-manager.js";

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];
const restArgs = process.argv.slice(5);

/**
 * Parse `--key value` / `--key=value` pairs from a list of argv strings.
 */
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const key = tok.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

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
        const tag = p.custom ? " (Custom)" : p.local ? " (Local)" : " (Cloud)";
        console.log(`${status} ${p.name} [${p.id}]${tag}`);
        console.log(`   Models: ${p.models.join(", ")}`);
        console.log("");
      });
      break;
    }

    case "list-custom": {
      const customs = listCustomProviders();
      if (customs.length === 0) {
        console.log("\nNo custom providers configured.");
        console.log("Add one with: node llm-cli.js add-custom --id=foo --baseUrl=https://...\n");
        break;
      }
      console.log("\n🧩 Custom Providers:\n");
      customs.forEach((p) => {
        console.log(`• ${p.name || p.id} [${p.id}]`);
        console.log(`  baseUrl:      ${p.baseUrl}`);
        console.log(`  apiKeyEnv:    ${p.apiKeyEnv || "LLM_API_KEY"}`);
        console.log(`  defaultModel: ${p.defaultModel || "auto"}`);
        console.log("");
      });
      break;
    }

    case "list-presets": {
      console.log("\n📦 Available Presets (use: add-preset <id>):\n");
      Object.entries(CUSTOM_PRESETS).forEach(([id, p]) => {
        console.log(`• ${id.padEnd(12)} ${p.name}`);
        console.log(`  ${p.baseUrl}`);
        console.log(`  default model: ${p.defaultModel}`);
        console.log("");
      });
      break;
    }

    case "add-preset": {
      if (!arg1) printError("Usage: llm-cli.js add-preset <preset-id> [--model=...] [--apiKeyEnv=...]");
      if (!CUSTOM_PRESETS[arg1]) {
        printError(
          `Unknown preset: ${arg1}. Available: ${Object.keys(CUSTOM_PRESETS).join(", ")}`
        );
      }
      const flags = parseFlags([arg2, ...restArgs].filter(Boolean));
      const overrides = {};
      if (flags.model) overrides.defaultModel = flags.model;
      if (flags.apiKeyEnv) overrides.apiKeyEnv = flags.apiKeyEnv;
      if (flags.apiKey) overrides.apiKey = flags.apiKey;
      if (flags.baseUrl) overrides.baseUrl = flags.baseUrl;
      if (flags.name) overrides.name = flags.name;

      try {
        const result = addPreset(arg1, overrides);
        printSuccess(
          `Preset '${arg1}' ${result.action}. Set ${result.entry.apiKeyEnv} in .env, then:\n   node llm-cli.js switch ${result.entry.id}`
        );
      } catch (err) {
        printError(err.message);
      }
      break;
    }

    case "add-custom": {
      const flags = parseFlags([arg1, arg2, ...restArgs].filter(Boolean));
      if (!flags.id || !flags.baseUrl) {
        printError(
          "Usage: llm-cli.js add-custom --id=<id> --baseUrl=<url> [--name=...] [--apiKeyEnv=...] [--model=...]"
        );
      }
      const entry = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        apiKeyEnv: flags.apiKeyEnv,
        defaultModel: flags.model || flags.defaultModel,
      };
      if (flags.apiKey) entry.apiKey = flags.apiKey;
      try {
        const result = addCustomProvider(entry);
        printSuccess(
          `Custom provider '${entry.id}' ${result.action}.\n   Switch with: node llm-cli.js switch ${entry.id}`
        );
      } catch (err) {
        printError(err.message);
      }
      break;
    }

    case "remove-custom": {
      if (!arg1) printError("Usage: llm-cli.js remove-custom <id>");
      const result = removeCustomProvider(arg1);
      if (!result.success) printError(result.error);
      printSuccess(`Removed custom provider '${arg1}'`);
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

      const result = quickSwitch(arg1);
      if (!result.success) printError(result.error || `Unknown provider: ${arg1}`);

      console.log(`\n✅ ${result.message}\n`);

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

      try {
        const result = setProvider(arg1, arg2);
        printSuccess(`${result.message}`);
      } catch (err) {
        printError(err.message);
      }
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

  list                       List all providers (built-in + custom)
  list-custom                List user-defined custom providers only
  list-presets               List available preset templates
  current                    Show current provider configuration
  switch <provider>          Switch to a provider (built-in or custom id)
  set-key <p> <key>          Set API key for provider
  add-preset <id> [flags]    Scaffold a custom provider from a preset
  add-custom --id ... ...    Add a fully custom provider entry
  remove-custom <id>         Remove a custom provider
  validate                   Validate all provider configurations
  test <provider>            Test provider connection
  info <provider>            Show detailed provider information
  show-env                   Show current .env LLM settings
  help                       Show this help message

Examples:

  # Built-in providers
  node llm-cli.js switch groq
  node llm-cli.js set-key openrouter sk-or-v1-xxxxx

  # Add Gemini via preset, then switch
  node llm-cli.js add-preset gemini
  node llm-cli.js switch gemini
  # then in .env: GEMINI_API_KEY=your_key

  # Add a fully custom OpenAI-compatible endpoint
  node llm-cli.js add-custom \\
    --id=myllm --baseUrl=https://api.example.com/v1 \\
    --apiKeyEnv=MYLLM_API_KEY --model=my-model-v1

  # Override preset's default model
  node llm-cli.js add-preset deepseek --model=deepseek-reasoner

Built-in Providers:

  ☁️  Cloud:  openrouter, openai, anthropic, groq, mistral, together
  💻 Local:   lmstudio, ollama

Available Presets (add via 'add-preset <id>'):

  gemini, deepseek, xai, perplexity, cohere, fireworks,
  deepinfra, nvidia, cerebras, sambanova, hyperbolic, azure

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
