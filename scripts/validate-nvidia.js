/**
 * validate-nvidia.js — smoke-test the NVIDIA NIM hosted API before pointing
 * the live agent at it.
 *
 * Usage:
 *   NVIDIA_API_KEY=nvapi-... node scripts/validate-nvidia.js [model]
 *   (or put NVIDIA_API_KEY in .env first)
 *
 * Checks, in order:
 *   1. plain chat completion (reasoning sanity)
 *   2. OpenAI-style tool call (the agent loop depends on this)
 * Exit 0 = safe to flip llmProvider=nvidia; non-zero = keep the local proxy.
 */
import "dotenv/config";
import OpenAI from "openai";

const BASE_URL = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
const MODEL = process.argv[2] || process.env.LLM_MODEL || "nvidia/llama-3.3-nemotron-super-49b-v1";
const KEY = process.env.NVIDIA_API_KEY;

if (!KEY) {
  console.error("NVIDIA_API_KEY not set. Get one at https://build.nvidia.com (Get API Key) and add it to .env");
  process.exit(2);
}
if (/content-safety|guard/i.test(MODEL)) {
  console.error(`Model "${MODEL}" is a moderation classifier, not an instruct model — it cannot drive the agent loop. Pick an instruct model (e.g. nvidia/llama-3.3-nemotron-super-49b-v1).`);
  process.exit(2);
}

const client = new OpenAI({ baseURL: BASE_URL, apiKey: KEY, timeout: 60_000 });

async function main() {
  console.log(`Endpoint: ${BASE_URL}\nModel:    ${MODEL}\n`);

  // 1. Plain completion
  const t0 = Date.now();
  const chat = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a terse trading assistant." },
      { role: "user", content: "A memecoin is down 25% from entry with rug_score 60 and falling liquidity. One word: HOLD or SELL?" },
    ],
    max_tokens: 30,
    temperature: 0,
  });
  const answer = chat.choices?.[0]?.message?.content?.trim();
  console.log(`[1/2] chat completion OK (${Date.now() - t0}ms): "${answer}"`);
  if (!answer) throw new Error("empty completion content");

  // 2. Tool call — the agent loop is tool-driven; without this the model can
  //    talk but never act.
  const t1 = Date.now();
  const tooled = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: "Sell 0.5 SOL worth of token mint ABC123 now. Use the tool." }],
    tools: [{
      type: "function",
      function: {
        name: "swap_token",
        description: "Swap a token",
        parameters: {
          type: "object",
          properties: {
            token_in: { type: "string" },
            amount: { type: "number" },
          },
          required: ["token_in", "amount"],
        },
      },
    }],
    tool_choice: "auto",
    max_tokens: 200,
    temperature: 0,
  });
  const call = tooled.choices?.[0]?.message?.tool_calls?.[0];
  if (call) {
    console.log(`[2/2] tool call OK (${Date.now() - t1}ms): ${call.function?.name}(${call.function?.arguments})`);
  } else {
    console.warn(`[2/2] WARNING: model answered in prose instead of calling the tool — management actions would degrade. Reply: "${tooled.choices?.[0]?.message?.content?.slice(0, 120)}"`);
    process.exitCode = 1;
  }

  console.log("\nNext steps if both checks passed:");
  console.log("  1. user-config.json: \"llmProvider\": \"nvidia\", \"llmModel\": \"" + MODEL + "\"");
  console.log("  2. .env: remove/comment LLM_BASE_URL (it overrides the provider URL)");
  console.log("  3. pm2 restart ponyou --update-env");
}

main().catch((e) => {
  console.error(`FAILED: ${e.status || ""} ${e.message}`);
  process.exit(1);
});
