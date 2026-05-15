# Ponyou Custom LLM Tools - Complete Guide

Ponyou menyediakan 3 custom tools untuk manage LLM providers dengan mudah:

## 📚 Tools Tersedia

### 1. **Interactive Setup Wizard** - `setup-llm.js`
Menu interaktif dengan GUI untuk setup/switch provider

### 2. **LLM Manager** - `llm-manager.js`
Library untuk programmatic access (bisa digunakan di aplikasi lain)

### 3. **Command-Line Interface** - `llm-cli.js`
CLI tool untuk quick provider switching dari terminal

---

## 🚀 Quick Start

### Option A: Interactive Setup (Recommended for First Time)

```bash
node setup-llm.js
# atau
chmod +x setup-llm.js
./setup-llm.js
```

Akan membuka menu interaktif:
```
╔══════════════════════════════════════════════════════════╗
║     PONYOU LLM PROVIDER SETUP WIZARD                     ║
╚══════════════════════════════════════════════════════════╝

Pilih opsi:
1. 🚀 Setup Provider Baru
2. 🔄 Switch Provider
3. 📋 Lihat Konfigurasi Sekarang
4. 📚 Info Provider
5. ✅ Validate Configuration
6. 🔧 Edit Manual (.env)
7. ❌ Exit
```

### Option B: Command-Line (Quick Switching)

```bash
# List all providers
node llm-cli.js list

# Switch to Groq (free & fast)
node llm-cli.js switch groq

# Test provider
node llm-cli.js test groq

# Validate config
node llm-cli.js validate
```

### Option C: Programmatic (Using llm-manager.js)

```javascript
import { setProvider, getCurrentProvider, listProviders } from './llm-manager.js';

// List all providers
const all = listProviders();
console.log(all);

// Switch to Groq
setProvider('groq', 'gsk-xxxxx');

// Get current
const current = getCurrentProvider();
console.log(current);
```

---

## 🛠️ setup-llm.js - Interactive Setup

Menu-driven setup wizard dengan validasi.

### Usage:
```bash
node setup-llm.js
```

### Menu Options:

**1. Setup Provider Baru**
- Select provider dari list
- Input API key (jika diperlukan)
- Auto-save ke .env dan user-config.json

**2. Switch Provider**
- Ganti provider dengan cepat
- Preserve existing configuration

**3. Lihat Konfigurasi**
- View current .env settings
- View user-config.json
- Display API key status

**4. Info Provider**
- Show semua providers dengan detail
- Cost, speed, local flag
- Setup instructions

**5. Validate Configuration**
- Check semua provider settings
- Verify API keys
- Report issues

**6. Edit Manual**
- Open text editor untuk edit .env
- Guided editing experience

**7. Exit**
- Save dan close

### Example Flow:

```
$ node setup-llm.js

Menu:
1. Setup Provider Baru
2. Switch Provider
3. Lihat Konfigurasi Sekarang
4. Info Provider
5. Validate Configuration
6. Edit Manual (.env)
7. Exit

Pilih (1-7): 1

🌐 Pilih Provider:

1. 🔄 OpenRouter (Default - Recommended) ($ - Fast)
2. 🔷 OpenAI (GPT-4, GPT-3.5) ($$ - Fast)
3. 🧠 Anthropic Claude (Best Reasoning) ($$ - Medium)
4. ⚡ Groq (Fast & Free!) (Free - Very Fast)
5. ✨ Mistral AI (European) ($ - Fast)
6. 🤝 Together AI (Open Source) ($ - Fast)
7. 💻 LM Studio (Local - Free!) (Free - Medium - Local)
8. 🐳 Ollama (Docker-Friendly - Free!) (Free - Slow - Local)
9. Kembali

Pilih (1-9): 4

🔑 Setup ⚡ Groq (Fast & Free!)
📖 Buka: https://console.groq.com/keys

Masukkan API Key untuk groq (atau 'skip' untuk skip): gsk_xxxxxxxxxxxxx

✅ .env file updated
✅ user-config.json updated

✅ ⚡ Groq (Fast & Free!) berhasil dikonfigurasi!

📝 Restart agent untuk apply perubahan:
   npm start
```

---

## 💻 llm-cli.js - Command-Line Interface

Fast command-line tool untuk switch provider dan manage settings.

### Commands:

```bash
# List all providers
node llm-cli.js list

# Show current provider
node llm-cli.js current

# Switch to provider
node llm-cli.js switch <provider>

# Set API key
node llm-cli.js set-key <provider> <api-key>

# Validate configuration
node llm-cli.js validate

# Test provider connection
node llm-cli.js test <provider>

# Show provider info
node llm-cli.js info <provider>

# Show current .env LLM settings
node llm-cli.js show-env

# Show help
node llm-cli.js help
```

### Examples:

```bash
# 1. List available providers
$ node llm-cli.js list

🌐 Available Providers:

✅ OpenRouter (Cloud)
   Models: openrouter/auto, openrouter/gpt-4-turbo, openrouter/claude-opus

✅ OpenAI (Cloud)
   Models: gpt-4-turbo-preview, gpt-4-vision-preview, gpt-3.5-turbo

✅ Anthropic Claude (Cloud)
   Models: claude-opus-4-1, claude-sonnet-4, claude-haiku-3

✅ Groq (Cloud)
   Models: mixtral-8x7b-32768, llama2-70b-4096

✅ LM Studio (Local)
   Models: local-model

✅ Ollama (Local)
   Models: mistral, llama2, neural-chat
```

```bash
# 2. Show current provider
$ node llm-cli.js current

📌 Current Provider:

Provider: OpenRouter (openrouter)
Model: openrouter/auto
Base URL: https://openrouter.ai/api/v1
Local: No
API Key: ✅ Set
```

```bash
# 3. Switch to Groq (one command!)
$ node llm-cli.js switch groq

✅ Switched to Groq

📝 Next step: Set API key in .env
   GROQ_API_KEY=your_api_key

🔄 Restart agent to apply changes:
   npm start
```

```bash
# 4. Set API key
$ node llm-cli.js set-key groq gsk_xxxxxxxxxxxxx

✅ Provider set to Groq
```

```bash
# 5. Test provider
$ node llm-cli.js test groq

🧪 Testing Groq...

✅ Configuration looks good
```

```bash
# 6. Validate all settings
$ node llm-cli.js validate

🔍 Validating configuration...

→ ✅ OpenRouter
  ✅ OpenAI
  ✅ Anthropic Claude
  ✅ Groq
  ✅ LM Studio
  ✅ Ollama

✅ All configurations are valid!
```

```bash
# 7. Show provider info
$ node llm-cli.js info groq

📚 Groq

ID: groq
Type: Cloud
Requires API Key: Yes
Models:
  • mixtral-8x7b-32768
  • llama2-70b-4096

Base URL: https://api.groq.com/openai/v1
```

---

## 📚 llm-manager.js - Programmatic API

Library untuk use dalam aplikasi JavaScript/Node.js

### Functions:

```javascript
import {
  PROVIDERS,                    // Object dengan semua provider configs
  readEnv,                      // Read .env file
  writeEnv,                     // Write .env file
  readConfig,                   // Read user-config.json
  writeConfig,                  // Write user-config.json
  setProvider,                  // Set provider + API key
  getCurrentProvider,           // Get current provider
  validateProvider,             // Validate provider config
  listProviders,                // List all providers
  quickSwitch,                  // Fast switch provider
  setModel,                     // Set model for provider
  getProviderInfo,              // Get provider details
  testProvider,                 // Test provider connection
  exportConfig                  // Export config template
} from './llm-manager.js';
```

### Usage Examples:

```javascript
// 1. Get current provider
const current = getCurrentProvider();
console.log(current);
// {
//   id: 'openrouter',
//   name: 'OpenRouter',
//   model: 'openrouter/auto',
//   baseUrl: 'https://openrouter.ai/api/v1',
//   local: false,
//   hasApiKey: true
// }

// 2. List all providers
const providers = listProviders();
providers.forEach(p => {
  console.log(`${p.id}: ${p.name} - Valid: ${p.valid}`);
});

// 3. Switch provider
const result = quickSwitch('groq');
console.log(result);
// { success: true, provider: 'groq', message: '...' }

// 4. Set API key
setProvider('groq', 'gsk-xxxxx');

// 5. Validate provider
const validation = validateProvider('groq');
console.log(validation);
// { valid: true, errors: [] }

// 6. Get provider info
const info = getProviderInfo('anthropic');
console.log(info);
// { id: 'anthropic', name: 'Anthropic Claude', models: [...], ... }

// 7. Test provider connection
const test = await testProvider('lmstudio');
console.log(test);
// { success: true, message: '✅ Provider is running' }

// 8. Set model
setModel('claude-opus-4-1');

// 9. Read configuration
const env = readEnv();
const config = readConfig();
```

### Available Providers:

```javascript
import { PROVIDERS } from './llm-manager.js';

Object.entries(PROVIDERS).forEach(([id, config]) => {
  console.log(`${id}: ${config.name}`);
  // openrouter: OpenRouter
  // openai: OpenAI
  // anthropic: Anthropic Claude
  // groq: Groq
  // mistral: Mistral AI
  // together: Together AI
  // lmstudio: LM Studio
  // ollama: Ollama
});
```

---

## 🔄 Workflow Examples

### Example 1: Switch to Groq (Free & Fast)

```bash
# Command-line way (fastest)
node llm-cli.js switch groq
node llm-cli.js set-key groq gsk-xxxxxxxxxxxxx
npm start
```

### Example 2: Use Local LM Studio (Privacy)

```bash
# 1. Download & run LM Studio
# https://lmstudio.ai

# 2. Load model (e.g., Mistral)

# 3. Switch via CLI
node llm-cli.js switch lmstudio

# 4. Start Ponyou
npm start
```

### Example 3: Test Multiple Providers

```bash
# List all
node llm-cli.js list

# Test each one
node llm-cli.js test openrouter
node llm-cli.js test groq
node llm-cli.js test lmstudio

# Choose best one
node llm-cli.js switch groq
```

### Example 4: Validate Before Running

```bash
# Validate everything
node llm-cli.js validate

# If error, check provider
node llm-cli.js info groq

# Fix and retry
npm start
```

---

## 📋 Configuration Files Updated

When you use these tools, they automatically update:

### `.env` file:
```bash
LLM_PROVIDER=groq
LLM_BASE_URL=https://api.groq.com/openai/v1
GROQ_API_KEY=gsk-xxxxxxxxxxxxx
```

### `user-config.json`:
```json
{
  "llmProvider": "groq",
  "llmModel": "mixtral-8x7b-32768",
  "llmBaseUrl": "https://api.groq.com/openai/v1"
}
```

---

## 🎯 Provider Quick Reference

| Provider | Command | Free? | Local? | Speed | Best For |
|----------|---------|-------|--------|-------|----------|
| OpenRouter | `switch openrouter` | No | No | Fast | Multi-model |
| OpenAI | `switch openai` | No | No | Fast | GPT-4 |
| Claude | `switch anthropic` | No | No | Medium | Reasoning |
| **Groq** | `switch groq` | **Yes** | No | **Very Fast** | **Budget** |
| Mistral | `switch mistral` | No | No | Fast | Quality |
| **LM Studio** | `switch lmstudio` | **Yes** | **Yes** | Medium | **Privacy** |
| **Ollama** | `switch ollama` | **Yes** | **Yes** | Slow | **Privacy** |

---

## ⚡ Performance Tips

**For Speed:**
```bash
node llm-cli.js switch groq
# Groq is fastest inference
```

**For Privacy:**
```bash
node llm-cli.js switch lmstudio
# All data stays local
```

**For Quality:**
```bash
node llm-cli.js switch anthropic
# Best reasoning capability
```

**For Cost:**
```bash
node llm-cli.js switch groq
# Free tier available
```

**For Compatibility:**
```bash
node llm-cli.js switch openrouter
# Supports most models
```

---

## 🐛 Troubleshooting

### "Cannot connect to LM Studio"
```bash
# Make sure LM Studio is running
# Check: http://localhost:1234/v1/models
curl http://localhost:1234/v1/models

# If error, LM Studio not started
# Download from: https://lmstudio.ai
```

### "API key not valid"
```bash
# Verify API key
node llm-cli.js show-env

# Update if needed
node llm-cli.js set-key groq gsk-xxxxxxxxxxxxx
```

### "Provider not recognized"
```bash
# List valid providers
node llm-cli.js list

# Use exact ID from list
node llm-cli.js switch groq
```

---

## 📖 Documentation Files

- **setup-llm.js** - Interactive setup (this file structure)
- **llm-manager.js** - Manager library (source code)
- **llm-cli.js** - CLI tool (source code)
- **llm-provider.js** - Provider detection & client creation
- **SETUP-PROVIDERS.md** - Detailed provider setup guide

---

## 🎉 Summary

Ponyou sekarang punya 3 custom tools untuk manage LLM providers:

1. **setup-llm.js** - Interactive menu (best for first time)
2. **llm-cli.js** - Command-line tool (fastest for switching)
3. **llm-manager.js** - JavaScript library (for developers)

**Gunakan salah satu sesuai preferensi Anda!** 🚀
