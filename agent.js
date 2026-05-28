import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { optimizePrompt } from "./prompt-optimizer.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import {
  detectProvider,
  createLLMClient,
  getProviderFeatures,
  handleProviderError,
} from "./llm-provider.js";
import { compressToolOutput } from "./compressor.js";

const ANALYSIS_ONLY_TOOLS = new Set([
  "analyze_dex_visibility_risk",
  "analyze_three_candle_confirmation",
  "analyze_cabal_play",
  "process_wallet_ping",
  "analyze_day_phase",
]);
const MANAGER_TOOLS  = new Set(["swap_token", "get_token_info", "get_token_security_details", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["swap_token", "discover_tokens", "get_token_security_details", "get_solana_gas_fee", "get_token_holders", "get_token_info", "get_wallet_balance", ...ANALYSIS_ONLY_TOOLS]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "block_deployer",
  "add_lesson",
  "list_lessons",
]);

// ── Ponyou control tools — always available to GENERAL role ──────────────
const PONYOU_CONTROL_TOOLS = new Set([
  "ponyou_get_status", "ponyou_toggle_automation", "ponyou_switch_strategy",
  "ponyou_toggle_feature", "ponyou_get_agents", "ponyou_get_open_positions",
  "ponyou_set_confirm_mode",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  deploy:      new Set(["swap_token", "discover_tokens", "get_token_security_details", "get_solana_gas_fee", "get_token_holders", "get_token_info", "get_wallet_balance"]),
  close:       new Set(["swap_token", "get_wallet_balance", "get_token_info"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "block_deployer"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance"]),
  screen:      new Set(["discover_tokens", "get_token_security_details", "get_solana_gas_fee", "get_token_holders", "get_token_info", "analyze_dex_visibility_risk", "analyze_three_candle_confirmation", "analyze_cabal_play", "analyze_day_phase"]),
  lessons:     new Set(["add_lesson", "list_lessons"]),
  // Tool names below must also exist in tools/definitions.js — otherwise the
  // getToolsForRole filter silently drops them and the LLM never sees the intent.
  wallets:     new Set(["discover_smart_wallets", "list_discovered_wallets", "list_smart_wallets", "add_smart_wallet", "remove_smart_wallet", "get_smart_money_rank", "get_smart_money_inflow", "process_wallet_ping", "analyze_cabal_play"]),
  rugscan:     new Set(["score_rug_risk", "learn_rug_patterns", "list_rug_patterns", "harvest_market_rugs", "get_rug_memory_summary", "report_rug", "get_token_security_details", "list_blacklist", "list_blocked_deployers", "analyze_dex_visibility_risk", "analyze_cabal_play"]),
  narrative:   new Set(["classify_narrative", "get_narrative_heat", "get_trending_narratives", "discover_tokens", "analyze_day_phase"]),
  ticker:      new Set(["resolve_ticker", "list_tickers", "register_ticker", "get_token_info"]),
  ponyou:      new Set([...PONYOU_CONTROL_TOOLS]),
};

const INTENT_PATTERNS = [
  { intent: "deploy",      re: /\b(buy|deploy|open|invest in|gas it)\b/i },
  { intent: "close",       re: /\b(sell|close|exit|withdraw|shut down)\b/i },
  { intent: "swap",        re: /\b(swap|convert|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|update agent)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|rugger|block dev)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "wallets",     re: /\b(smart\s*wallet|discover\s*wallet|scan\s*wallet|copy\s*trade|smart\s*money|cabal|wallet\s*ping)\b/i },
  { intent: "rugscan",     re: /\b(rug|honeypot|scam|junk|sampah|pattern|fingerprint|learn\s*pattern|harvest)\b/i },
  { intent: "narrative",   re: /\b(narasi|narrative|theme|tema|heat|hot|cold|trend|tag|day\s*phase|swing|cooldown|sideways)\b/i },
  { intent: "ticker",      re: /\b(ticker|symbol|resolve|disambig|mint\s*for|which\s*pepe|which\s*bonk)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find|search|research|token|dex\s*visibility|three\s*candle|candle|fomo)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|what did you learn)\b/i },
  // Ponyou control — status/automation/strategy queries
  { intent: "ponyou",      re: /\b(status|bot|automation|start bot|stop bot|aktifkan|matikan|pause|resume|strategi|strategy|fitur|feature|agent|posisi|position|pnl hari|performa|gimana|bagaimana|confirm mode)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const tName of INTENT_TOOLS[intent]) {
        const tool = tools.find(t => t.function.name === tName);
        if (tool) matched.add(tool);
      }
    }
  }

  // Always include ponyou control tools for GENERAL role
  for (const tName of PONYOU_CONTROL_TOOLS) {
    const tool = tools.find(t => t.function.name === tName);
    if (tool) matched.add(tool);
  }

  if (matched.size === PONYOU_CONTROL_TOOLS.size) {
    // No other intents matched — return all non-restricted tools + control tools
    return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  }
  return Array.from(matched);
}
import { getWalletBalances } from "./tools/wallet.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

// Multi-provider LLM client (OpenRouter, OpenAI, Claude, LM Studio, Groq, etc.)
let client = null;
let currentProvider = null;

export function getLLMClient() {
  return client;
}

async function initLLMClient(config) {
  currentProvider = detectProvider(config);
  try {
    client = await createLLMClient(config);
    log("agent", `LLM Client initialized: ${currentProvider}`);
  } catch (error) {
    log("agent_error", `Failed to initialize LLM client: ${error.message}`);
    throw error;
  }
}

// Initialize on module load
await initLLMClient(config);

const DEFAULT_MODEL =
  process.env.LLM_MODEL ||
  config.llm?.generalModel ||
  config.llmModel ||
  "openrouter/auto";

const MUTATING_TOOL_INTENTS = /\b(buy|sell|deploy|close|exit|swap|block|blacklist|set |change |update |self.?update|git pull)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|screen|candidate|find|search|research|analyze|token holders|performance|stats|report|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|see)\b.*\b(config|settings?|thresholds?)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

// Marker inserted by prompt.js to split stable (cacheable) vs dynamic content.
const STABLE_BOUNDARY = "\x00STABLE_END\x00";

/**
 * Provider-caching strategy map.
 *
 * There are three distinct caching mechanisms in the wild:
 *
 * A) EXPLICIT cache_control (Anthropic only)
 *    - Claude models via Anthropic API or OpenRouter "anthropic/..." routes
 *    - We send cache_control:{type:"ephemeral"} on the stable content block
 *    - OpenRouter forwards it to Anthropic; Claude saves the KV state
 *    - Saves ~60-90% of system-prompt token cost on repeated calls
 *
 * B) AUTOMATIC prefix caching (OpenAI, DeepSeek, Ollama, LM Studio)
 *    - Provider caches the longest common prefix automatically
 *    - No API change required — benefit is "free" as long as stable content
 *      is at the TOP of the system prompt (which our STABLE_BOUNDARY ensures)
 *    - OpenAI: requires >1024 token prefix, GPT-4o / o-series only
 *    - DeepSeek: KV prefix cache per account
 *    - Ollama/LM Studio: runtime KV cache, always active locally
 *
 * C) SEPARATE context-cache API (Google Gemini)
 *    - Requires a pre-flight cachedContent.create() call and then referencing
 *      the cache name in the request — completely different from A/B
 *    - Not yet implemented; would need a separate Gemini adapter
 *
 * Our approach: only activate explicit cache_control (type A) for providers
 * that understand it. Everyone else benefits from (B) for free because stable
 * content is already at the top. No code needed for (B).
 */
function supportsExplicitCacheControl(provider, model) {
  if (!model || typeof model !== "string") return false;
  const m = model.toLowerCase();

  // Gemini via OpenAI-compat endpoint: cache_control is NOT forwarded.
  // Gemini Context Caching requires a native Gemini client (cachedContent API)
  // which is a separate code path — not available here. Optimizer handles
  // token reduction for Gemini via text transformations instead.
  if (m.includes("gemini") || provider === "gemini") return false;

  // Anthropic/Claude via any gateway — cache_control is forwarded to Anthropic.
  if (m.includes("claude") || m.includes("anthropic/")) return true;
  // OpenRouter with Claude model — OpenRouter passes cache_control through.
  if (provider === "openrouter" && (m.includes("claude") || m.startsWith("anthropic/"))) return true;

  return false;
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system", enableCache = false) {
  // Strip the boundary marker so it never reaches the provider.
  // In cache mode we split on it; otherwise we just remove it.
  const boundaryIdx = systemPrompt.indexOf(STABLE_BOUNDARY);
  const hasMarker   = boundaryIdx >= 0;

  if (providerMode === "user_embedded") {
    const cleanPrompt = hasMarker
      ? systemPrompt.slice(0, boundaryIdx) + "\n" + systemPrompt.slice(boundaryIdx + STABLE_BOUNDARY.length)
      : systemPrompt;
    return [
      ...sessionHistory,
      { role: "user", content: `[SYSTEM INSTRUCTIONS]\n${cleanPrompt}\n\n[USER REQUEST]\n${goal}` },
    ];
  }

  // Explicit caching (type A) — Anthropic/Claude only.
  // Sends stable block with cache_control so the KV state is saved server-side.
  if (enableCache && hasMarker) {
    const stablePart  = systemPrompt.slice(0, boundaryIdx).trimEnd();
    const dynamicPart = systemPrompt.slice(boundaryIdx + STABLE_BOUNDARY.length).trimStart();
    return [
      {
        role: "system",
        content: [
          { type: "text", text: stablePart, cache_control: { type: "ephemeral" } },
          ...(dynamicPart ? [{ type: "text", text: dynamicPart }] : []),
        ],
      },
      ...sessionHistory,
      { role: "user", content: goal },
    ];
  }

  // All other providers (OpenAI, DeepSeek, Groq, Gemini, etc.):
  // Plain string system message. Stable content is still first in the string
  // so OpenAI/DeepSeek automatic prefix caching fires without any extra code.
  const cleanPrompt = hasMarker
    ? systemPrompt.slice(0, boundaryIdx) + "\n" + systemPrompt.slice(boundaryIdx + STABLE_BOUNDARY.length)
    : systemPrompt;
  return [
    { role: "system", content: cleanPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

/**
 * Core ReAct agent loop.
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null, systemPromptOverride = null } = options;
  const [portfolio] = await Promise.all([getWalletBalances()]);
  const stateSummary = getStateSummary();
  const positions = Object.fromEntries((stateSummary.positions || []).map(p => [p.position, p]));
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const rawSystemPrompt = systemPromptOverride || buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);
  const providerFeatures = getProviderFeatures(currentProvider, config) || {};

  // Per-role timeout — manager needs fast decisions, screener can run longer.
  // Falls back to the shared timeoutMs if the role-specific key is zero/missing.
  const _roleTimeout =
    agentType === "MANAGER"  ? (config.llm.managerTimeoutMs  || config.llm.timeoutMs || 60_000)  :
    agentType === "SCREENER" ? (config.llm.screenerTimeoutMs || config.llm.timeoutMs || 90_000)  :
                               (config.llm.generalTimeoutMs  || config.llm.timeoutMs || 120_000);

  // ── Universal prompt optimization (all providers) ──────────────────────
  // Reduces tokens via lesson truncation, role pruning, budget enforcement,
  // and in-process dedup cache. Works for Minimax, GPT, Claude, Groq, etc.
  const activeModel = model || DEFAULT_MODEL;
  const optResult = !systemPromptOverride
    ? optimizePrompt(rawSystemPrompt, agentType, activeModel)
    : { text: rawSystemPrompt, fromCache: false, savedTokens: 0 };
  const systemPrompt = optResult.text;
  if (optResult.fromCache)        log("agent", `Prompt cache HIT ${agentType} — reusing cached system prompt`);
  else if (optResult.savedTokens > 20) log("agent", `Prompt opt ${agentType}: -${optResult.savedTokens} tokens (${optResult.originalTokens}→${optResult.finalTokens})`);

  // ── Explicit cache_control (Anthropic/Claude only) ─────────────────────
  // OpenAI/DeepSeek/Ollama get automatic prefix caching for free — no code
  // needed; universal optimizer already puts stable content first.
  const _enableCache = !systemPromptOverride
    && config.llm.promptCaching
    && supportsExplicitCacheControl(currentProvider, activeModel);
  if (_enableCache) log("agent", `Explicit prompt caching ON for ${agentType} (${currentProvider}/${activeModel})`);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode, _enableCache);

  if (providerFeatures.systemRole === false) {
    providerMode = "user_embedded";
    messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode, false);
  }

  const supportsToolChoice = providerFeatures.toolChoice !== false;

  // Tools the agent must call at most once per agentLoop invocation.
  // Mostly money-spending actions where retry == double-execution risk.
  const ONCE_PER_SESSION = new Set(["swap_token"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      // activeModel already computed above for cache detection; reuse it here.
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      const ACTION_INTENTS = /\b(buy|sell|deploy|close|swap|block|blacklist)\b/i;
      let toolChoice = supportsToolChoice && (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";
      if (!supportsToolChoice && step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) {
        log("agent", `Provider ${currentProvider} lacks trusted tool-choice support; using auto mode.`);
      }

      const LLM_TIMEOUT_MS = _roleTimeout;
      for (let attempt = 0; attempt < 3; attempt++) {
        // AG-1: previously `const timeout` was declared inside the try block
        // and the catch block referenced it for cleanup — but `const`/`let`
        // are block-scoped to the try, so `clearTimeout(timeout)` in the
        // catch threw `ReferenceError: timeout is not defined`. That masked
        // the real LLM error on every failure. Hoist the binding so both
        // branches can see it.
        let timeout = null;
        try {
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          }, { signal: controller.signal });
          clearTimeout(timeout);
        } catch (error) {
          if (timeout) clearTimeout(timeout);
          // Handle LLM timeout / abort
          if (error.name === "AbortError" || error.message?.includes("abort") || error.message?.includes("timeout")) {
            log("agent_error", `LLM call timed out after ${LLM_TIMEOUT_MS}ms (attempt ${attempt + 1}/3)`);
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            throw new Error(`LLM API timed out after ${attempt + 1} attempts`);
          }
          const errorInfo = handleProviderError(error, currentProvider);

          // Handle system role rejection
          if (
            errorInfo.type === "system_role_unsupported" &&
            providerMode === "system"
          ) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", `Provider "${currentProvider}" doesn't support system role, switching to user_embedded`);
            attempt -= 1;
            continue;
          }

          // Handle tool_choice unsupported
          if (
            errorInfo.type === "tool_choice_unsupported" &&
            toolChoice === "required"
          ) {
            toolChoice = "auto";
            log("agent", `Provider "${currentProvider}" doesn't support tool_choice=required, falling back to auto`);
            attempt -= 1;
            continue;
          }

          // Handle retryable errors
          if (errorInfo.shouldRetry && attempt < 2) {
            const delay = errorInfo.delay || 5000;
            log("agent", `${errorInfo.type} from ${currentProvider}, retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          throw error;
        }
        if (response.choices?.length) break;
        await new Promise(r => setTimeout(r, 5000));
      }

      if (!response.choices?.length) throw new Error("API returned no choices");
      
      const msg = response.choices[0].message;
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content) { messages.pop(); continue; }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          if (noToolRetryCount >= 2) return { content: "No tool call made.", userMessage: goal };
          // Replace (not stack) any prior nudge so we don't end up with
          // consecutive user messages — some providers reject that shape.
          const lastIdx = messages.length - 1;
          const NUDGE = "You must call a tool to complete this request.";
          if (lastIdx >= 0 && messages[lastIdx].role === "user" && messages[lastIdx].content === NUDGE) {
            // already nudged; skip pushing again
          } else {
            messages.push({ role: "user", content: NUDGE });
          }
          continue;
        }
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Reserve ONCE_PER_SESSION slots synchronously BEFORE Promise.all
      // to prevent a race where two swap_token calls in the same round
      // both check firedOnce.has() before either adds to the set.
      const onceReserved = new Set();
      const blockedIds = new Set();
      for (const toolCall of msg.tool_calls) {
        const fn = toolCall.function.name.replace(/<.*$/, "").trim();
        if (ONCE_PER_SESSION.has(fn)) {
          if (firedOnce.has(fn) || onceReserved.has(fn)) {
            blockedIds.add(toolCall.id);
          } else {
            onceReserved.add(fn);
          }
        }
      }

      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;
        const rawArgs = toolCall.function.arguments || "{}";
        try {
          functionArgs = JSON.parse(rawArgs);
        } catch (e) {
          // Try jsonrepair before giving up — LLMs frequently emit nearly-valid JSON.
          try {
            functionArgs = JSON.parse(jsonrepair(rawArgs));
            log("agent_warn", `Repaired broken JSON args for ${functionName}`);
          } catch {
            log("agent_warn", `Invalid JSON args for ${functionName}: ${e.message} — using {}`);
            functionArgs = {};
          }
        }

        if (blockedIds.has(toolCall.id)) {
          return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ blocked: true, reason: "Executed once already." }) };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({ name: functionName, args: functionArgs, result, success: !result.error, step });

        // firedOnce was pre-reserved above; no-op add here is safe but kept for non-ONCE_PER_SESSION paths
        if (ONCE_PER_SESSION.has(functionName)) firedOnce.add(functionName);
        
        // RTK Compression: reduce token usage by 60-90%
        const compressed = compressToolOutput(result, functionName);
        return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(compressed) };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent error: ${error.message}`);
      throw error;
    }
  }

  return { content: "Max steps reached.", userMessage: goal };
}
