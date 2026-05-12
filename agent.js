import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["gmgn_swap", "get_token_info", "get_token_security_details", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["gmgn_swap", "discover_tokens", "get_token_security_details", "get_solana_gas_fee", "get_token_holders", "get_token_info", "get_wallet_balance"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "block_deployer",
  "add_lesson",
  "list_lessons",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  deploy:      new Set(["gmgn_swap", "discover_tokens", "get_token_security_details", "get_solana_gas_fee", "get_token_holders", "get_token_info", "get_wallet_balance"]),
  close:       new Set(["gmgn_swap", "get_wallet_balance", "get_token_info"]),
  swap:        new Set(["gmgn_swap", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "block_deployer"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance"]),
  screen:      new Set(["discover_tokens", "get_token_security_details", "get_solana_gas_fee", "get_token_holders", "get_token_info"]),
  lessons:     new Set(["add_lesson", "list_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "deploy",      re: /\b(buy|deploy|open|invest in|gas it)\b/i },
  { intent: "close",       re: /\b(sell|close|exit|withdraw|shut down)\b/i },
  { intent: "swap",        re: /\b(swap|convert|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|update agent)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|rugger|block dev)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find|search|research|token)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|what did you learn)\b/i },
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

  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return Array.from(matched);
}
import { getWalletBalances } from "./tools/wallet.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

const MUTATING_TOOL_INTENTS = /\b(buy|sell|deploy|close|exit|swap|block|blacklist|set |change |update |self.?update|git pull)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|screen|candidate|find|search|research|analyze|token holders|performance|stats|report|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|see)\b.*\b(config|settings?|thresholds?)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
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
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  const [portfolio, positions] = await Promise.all([getWalletBalances(), []]); // simplified positions for now
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  const ONCE_PER_SESSION = new Set(["gmgn_swap"]);
  const NO_RETRY_TOOLS = new Set(["gmgn_swap"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      const ACTION_INTENTS = /\b(buy|sell|deploy|close|swap|block|blacklist)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      if (step === 0 && onThinkingStart) await onThinkingStart();

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role");
            attempt -= 1; continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required");
            attempt -= 1; continue;
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
          messages.push({ role: "user", content: "You must call a tool to complete this request." });
          continue;
        }
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs = JSON.parse(toolCall.function.arguments || "{}");

        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ blocked: true, reason: "Executed once already." }) };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({ name: functionName, args: functionArgs, result, success: !result.error, step });

        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
