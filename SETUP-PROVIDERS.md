# Ponyou LLM Provider Setup Guide

Ponyou mendukung **semua jenis LLM API** melalui sistem provider yang fleksibel.

## 🌐 Provider yang Didukung

| Provider | Type | Setup Complexity | Cost | Local |
|----------|------|------------------|------|-------|
| **OpenRouter** | Cloud | ⭐ Mudah | $ | ❌ |
| **OpenAI** | Cloud | ⭐ Mudah | $$ | ❌ |
| **Claude API** (Anthropic) | Cloud | ⭐ Mudah | $$ | ❌ |
| **Groq** | Cloud | ⭐ Mudah | Gratis | ❌ |
| **Mistral AI** | Cloud | ⭐ Mudah | $ | ❌ |
| **Together AI** | Cloud | ⭐ Mudah | $ | ❌ |
| **LM Studio** | Local | ⭐⭐ Sedang | Gratis | ✅ |
| **Ollama** | Local | ⭐⭐ Sedang | Gratis | ✅ |
| **Custom OpenAI-Compatible** | Any | ⭐⭐⭐ Kompleks | Varies | Both |

---

## 🚀 Quick Setup per Provider

### 1. OpenRouter (Default - Recommended)

**Kelebihan:**
- Model terbanyak (Claude, GPT, Mistral, Minimax, etc.)
- Fallback otomatis jika model tidak tersedia
- Stable dan reliable

**Setup:**

```bash
# 1. Buat account di https://openrouter.ai
# 2. Copy API key

# 3. Edit .env
nano .env
```

```bash
LLM_PROVIDER=openrouter
LLM_API_KEY=sk-or-v1-xxxxxxxxxxxxx
# LLM_MODEL=openrouter/auto (optional, default auto)
```

```bash
# 4. Edit user-config.json (optional)
{
  "llmProvider": "openrouter",
  "llmModel": "openrouter/gpt-4-turbo",
  "llmBaseUrl": "https://openrouter.ai/api/v1"
}
```

**Rekomendasi Model:**
- `openrouter/auto` - Auto-select terbaik
- `openai/gpt-4-turbo` - GPT-4 via OpenRouter
- `anthropic/claude-opus` - Claude Opus via OpenRouter
- `mistralai/mistral-large` - Mistral Large
- `minimax/minimax-m2.7` - Minimax (murah)

---

### 2. OpenAI (GPT-4, GPT-3.5)

**Kelebihan:**
- GPT-4 Turbo, GPT-4 Vision
- Official OpenAI API
- Reliable & fast

**Setup:**

```bash
# 1. Buat account di https://platform.openai.com
# 2. Generate API key

# 3. Edit .env
nano .env
```

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxx
```

```bash
# 4. Edit user-config.json
{
  "llmProvider": "openai",
  "llmModel": "gpt-4-turbo-preview",
  "llmBaseUrl": "https://api.openai.com/v1"
}
```

**Model Options:**
- `gpt-4-turbo-preview`
- `gpt-4-vision-preview`
- `gpt-3.5-turbo`

---

### 3. Claude API (Anthropic)

**Kelebihan:**
- Claude Opus, Sonnet - model terbaik
- Native Anthropic API
- Excellent reasoning

**Setup:**

```bash
# 1. Buat account di https://console.anthropic.com
# 2. Generate API key

# 3. Edit .env
nano .env
```

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

```bash
# 4. Edit user-config.json
{
  "llmProvider": "anthropic",
  "llmModel": "claude-opus-4-1"
}
```

**Model Options:**
- `claude-opus-4-1` - Best reasoning
- `claude-sonnet-4` - Balanced
- `claude-haiku-3` - Lightweight

---

### 4. Groq (Fast & Free!)

**Kelebihan:**
- Cepat sekali (inference optimization)
- Free tier dengan rate limit
- Mistral, Llama support

**Setup:**

```bash
# 1. Buat account di https://console.groq.com
# 2. Generate API key

# 3. Edit .env
nano .env
```

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_xxxxxxxxxxxxx
```

```bash
# 4. Edit user-config.json
{
  "llmProvider": "groq",
  "llmModel": "mixtral-8x7b-32768",
  "llmBaseUrl": "https://api.groq.com/openai/v1"
}
```

**Model Options:**
- `mixtral-8x7b-32768` - Fast & good
- `llama2-70b-4096` - More powerful
- `gemma-7b-it` - Lightweight

---

### 5. Mistral AI

**Kelebihan:**
- Mistral 7B, Mistral Large
- European-based
- Good performance

**Setup:**

```bash
# 1. Buat account di https://console.mistral.ai
# 2. Generate API key

# 3. Edit .env
nano .env
```

```bash
LLM_PROVIDER=mistral
MISTRAL_API_KEY=xxxxxxxxxxxxx
```

```bash
# 4. Edit user-config.json
{
  "llmProvider": "mistral",
  "llmModel": "mistral-large-latest",
  "llmBaseUrl": "https://api.mistral.ai/v1"
}
```

**Model Options:**
- `mistral-large-latest` - Best
- `mistral-medium-latest` - Balanced
- `mistral-small-latest` - Lightweight

---

### 6. Together AI

**Kelebihan:**
- Multiple open-source models
- Inference optimization
- Good prices

**Setup:**

```bash
# 1. Buat account di https://www.together.ai
# 2. Generate API key

# 3. Edit .env
nano .env
```

```bash
LLM_PROVIDER=together
TOGETHER_API_KEY=xxxxxxxxxxxxx
```

```bash
# 4. Edit user-config.json
{
  "llmProvider": "together",
  "llmModel": "mistralai/Mistral-7B-Instruct-v0.1",
  "llmBaseUrl": "https://api.together.xyz/v1"
}
```

**Model Options:**
- `mistralai/Mistral-7B-Instruct-v0.1`
- `togethercomputer/llama-2-70b-chat`
- `NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO`

---

### 7. LM Studio (Local)

**Kelebihan:**
- 100% gratis
- Private - no data sent to cloud
- Support untuk semua GGUF models

**Setup:**

```bash
# 1. Download LM Studio dari https://lmstudio.ai
# 2. Jalankan LM Studio
# 3. Download model (misalnya Mistral 7B)
# 4. Run model di LM Studio

# 5. Edit .env
nano .env
```

```bash
LLM_PROVIDER=lmstudio
LLM_BASE_URL=http://localhost:1234/v1
# Tidak perlu API key untuk local mode
```

```bash
# 6. Edit user-config.json
{
  "llmProvider": "lmstudio",
  "llmModel": "local-model",
  "llmBaseUrl": "http://localhost:1234/v1"
}
```

**Popular Models untuk LM Studio:**
- Mistral 7B
- Llama 2 13B
- Neural Chat 7B
- Orca 2 13B

---

### 8. Ollama (Local)

**Kelebihan:**
- Super mudah setup
- Docker-friendly
- Pull models langsung dari command line

**Setup:**

```bash
# 1. Install Ollama dari https://ollama.ai
# 2. Jalankan: ollama serve
# 3. Di terminal lain: ollama pull mistral

# 4. Edit .env
nano .env
```

```bash
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434/v1
```

```bash
# 5. Edit user-config.json
{
  "llmProvider": "ollama",
  "llmModel": "mistral",
  "llmBaseUrl": "http://localhost:11434/v1"
}
```

**Popular Models untuk Ollama:**
```bash
ollama pull mistral
ollama pull llama2
ollama pull neural-chat
ollama pull dolphin-mixtral
```

---

### 9. Custom OpenAI-Compatible

Jika punya provider lain yang OpenAI-compatible:

```bash
# .env
LLM_PROVIDER=custom
LLM_BASE_URL=https://your-api.com/v1
LLM_API_KEY=xxx
```

```bash
# user-config.json
{
  "llmProvider": "custom",
  "llmModel": "your-model-name",
  "llmBaseUrl": "https://your-api.com/v1"
}
```

---

## 📋 Provider Configuration Reference

### Environment Variables (.env)

```bash
# Provider selection
LLM_PROVIDER=openrouter          # openrouter, openai, anthropic, groq, mistral, together, lmstudio, ollama, custom

# API Keys (sesuai provider)
OPENROUTER_API_KEY=sk-or-v1-xxx
OPENAI_API_KEY=sk-proj-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
GROQ_API_KEY=gsk-xxx
MISTRAL_API_KEY=xxx
TOGETHER_API_KEY=xxx

# Optional: Override default base URL
LLM_BASE_URL=https://custom-api.com/v1

# Optional: Override default API key variable
LLM_API_KEY=xxx
```

### user-config.json

```json
{
  "llmProvider": "openrouter",
  "llmModel": "openrouter/gpt-4-turbo",
  "llmBaseUrl": "https://openrouter.ai/api/v1"
}
```

---

## 🔄 Switch Provider Secara Dinamis

Tanpa restart:

```bash
# Update .env dan user-config.json, kemudian:
./configure
# Pilih "1. Full Setup" dan update provider settings

# atau edit manual dan restart:
npm start
```

---

## ✅ Provider Compatibility Check

Check apakah provider Anda properly configured:

```javascript
// Akan auto-check saat startup
// Check logs untuk: "LLM Client initialized: {provider}"
```

---

## 🎯 Provider Recommendations

**Untuk Production Trading:**
```
OpenRouter (auto) - Best reliability
└─ Fallback ke multiple models
```

**Untuk Development:**
```
LM Studio (local) - Free & private
└─ Tanpa rate limits
```

**Untuk Cost Optimization:**
```
Groq (free tier) - Fast & free
```

**Untuk Quality:**
```
Claude API (Opus) - Best reasoning
```

---

## 🛠️ Troubleshooting

### "LLM API key not found"
```bash
# Check .env file exists and has correct key
cat .env | grep OPENROUTER_API_KEY
# atau sesuai provider
```

### "Cannot connect to LM Studio"
```bash
# Pastikan LM Studio running
# Check: http://localhost:1234/v1/models
curl http://localhost:1234/v1/models
```

### "Provider doesn't support tool_choice"
```bash
# Provider Anda tidak support tool_choice
# Sistem akan auto-fallback ke tool_choice=auto
# Check logs untuk: "doesn't support tool_choice=required"
```

### "Invalid system role"
```bash
# Provider tidak support system message
# Sistem akan auto-fallback ke user_embedded mode
# Check logs untuk: "doesn't support system role"
```

### "Rate limited"
```bash
# Provider rate limit tercapai
# Sistem akan auto-retry dengan exponential backoff
# Upgrade plan atau switch provider
```

---

## 📊 Provider Comparison Table

| Feature | OpenRouter | OpenAI | Claude | Groq | LM Studio | Ollama |
|---------|-----------|--------|--------|------|-----------|--------|
| System Role | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool Choice | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| Vision | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cost | $ | $$ | $$ | Gratis | Gratis | Gratis |
| Speed | Fast | Fast | Medium | Very Fast | Medium | Slow |
| Local | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

---

Sekarang Ponyou bisa gunakan **semua jenis LLM API**! 🎉
