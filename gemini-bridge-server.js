import { readFileSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const GEMINI_PATH = "/home/ubuntu/.npm-global/bin/gemini";
const MAX_FILE_CHARS = 50000;
const execFile = promisify(execFileCb);

const server = new Server(
  { name: "gemini-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(error, stderr = "") {
  return {
    content: [{ type: "text", text: JSON.stringify({ error, stderr }, null, 2) }],
    isError: true,
  };
}

async function runGemini(prompt) {
  try {
    const { stdout } = await execFile(GEMINI_PATH, ["-p", prompt], {
      timeout: 120000,
    });
    return textResult(stdout.trim());
  } catch (e) {
    return errorResult(e.message, e.stderr || "");
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_gemini",
      description: "Tanya Gemini dengan prompt bebas, opsional dengan konteks tambahan. Gemini punya Google Search built-in untuk riset real-time.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Pertanyaan atau instruksi untuk Gemini" },
          context: { type: "string", description: "Konteks tambahan (opsional)" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "gemini_analyze_file",
      description: "Baca file lalu minta Gemini menganalisis isinya. Cocok untuk log panjang, JSON besar, atau kode.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path absolut ke file yang dianalisis" },
          question: { type: "string", description: "Pertanyaan tentang isi file" },
        },
        required: ["file_path", "question"],
      },
    },
    {
      name: "gemini_research",
      description: "Minta Gemini riset topik tertentu menggunakan Google Search. Cocok untuk analisis market, berita crypto, atau riset token.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topik yang diriset" },
          focus: { type: "string", description: "Fokus spesifik dari riset (opsional)" },
        },
        required: ["topic"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "ask_gemini") {
    const fullPrompt = args.context
      ? `Context:\n${args.context}\n\nQuestion: ${args.prompt}`
      : args.prompt;
    return runGemini(fullPrompt);
  }

  if (name === "gemini_analyze_file") {
    try {
      const content = readFileSync(args.file_path, "utf8").slice(0, MAX_FILE_CHARS);
      const prompt = `Analyze this content:\n\n${content}\n\nQuestion: ${args.question}`;
      return runGemini(prompt);
    } catch (e) {
      return errorResult(e.message);
    }
  }

  if (name === "gemini_research") {
    const prompt = `Research topic: ${args.topic}${
      args.focus ? `\nFocus on: ${args.focus}` : ""
    }. Provide comprehensive analysis with key insights.`;
    return runGemini(prompt);
  }

  return errorResult(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
