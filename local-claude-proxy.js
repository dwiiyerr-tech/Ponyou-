/**
 * Local Claude Proxy — OpenAI-compatible HTTP server
 * Acts as LLM backend for Ponyou without needing an API key.
 * Parses agent prompts and returns intelligent trading decisions.
 */

import http from "http";

const PORT = 8787;
let requestCount = 0;

function buildResponse(content, toolCalls = null) {
  return {
    id: `chatcmpl-local-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "local-claude-proxy",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls ? null : content,
          tool_calls: toolCalls || null,
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function buildToolCall(name, args) {
  return [
    {
      id: `call_${Date.now()}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
  ];
}

function handleManagementCycle(messages) {
  const lastUser = messages.findLast(m => m.role === "user")?.content || "";

  // Extract token data from the prompt
  const hasTokens = /Tokens held:/i.test(lastUser);
  if (!hasTokens) {
    return buildResponse("Tidak ada posisi aktif untuk dikelola. Semua aman.");
  }

  // Detect token info from JSON in the prompt
  let tokens = [];
  try {
    const match = lastUser.match(/Tokens held:\s*(\[.*?\])/s);
    if (match) tokens = JSON.parse(match[1]);
  } catch {}

  if (tokens.length === 0) {
    return buildResponse("Posisi sudah dikelola oleh strategi deterministik. Tidak ada aksi LLM diperlukan.");
  }

  // Conservative: hold unless obvious rug signal
  const decisions = tokens.map(t => {
    const sym = t.symbol || t.mint?.slice(0, 8);
    return `- ${sym}: HOLD — tidak ada sinyal rug yang jelas, tunggu strategi ROI/trailing`;
  });

  return buildResponse(
    `MANAGEMENT REVIEW:\n${decisions.join("\n")}\n\nKesimpulan: Pertahankan semua posisi untuk saat ini. Biarkan strategi trailing stop dan ROI bekerja secara otomatis.`
  );
}

function handleScreeningCycle(messages, tools) {
  const lastUser = messages.findLast(m => m.role === "user")?.content || "";

  // Check if there are passing candidates
  const hasCandidates = /CANDIDATES.*lolos/i.test(lastUser) || /passingCandidates/i.test(lastUser);

  // Extract candidates JSON with bracket-balanced parser (handles nested arrays like `flags`)
  let candidates = [];
  const startIdx = lastUser.search(/CANDIDATES[^\n]*:\s*\n\[/i);
  if (startIdx >= 0) {
    const arrStart = lastUser.indexOf('[', startIdx);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = arrStart; i < lastUser.length; i++) {
      const ch = lastUser[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > arrStart) {
      try { candidates = JSON.parse(lastUser.slice(arrStart, end + 1)); } catch {}
    }
  }

  if (candidates.length === 0 || !hasCandidates) {
    return buildResponse(
      "Tidak ada kandidat yang layak untuk di-deploy saat ini. Market perlu lebih banyak sinyal konfirmasi. Skip cycle ini."
    );
  }

  // In DRY_RUN mode — pick best candidate by momentum/rug score if available
  const best = candidates.sort((a, b) => {
    const scoreA = (a.momentum_score || 0) - (a.rug_score || 50);
    const scoreB = (b.momentum_score || 0) - (b.rug_score || 50);
    return scoreB - scoreA;
  })[0];

  if (!best) {
    return buildResponse("Tidak ada kandidat valid ditemukan setelah evaluasi.");
  }

  // In DRY_RUN we can fire a swap call — it will be intercepted.
  const swapTool = tools?.find(t => ["swap_token", "jupiter_swap"].includes(t.function?.name))?.function?.name;
  if (swapTool) {
    return buildResponse(null, buildToolCall(swapTool, {
      token_in: "SOL",
      token_out: best.mint,
      amount: best.volatility_adjusted_size || 0.5,
      slippage: 0.1,
    }));
  }

  return buildResponse(
    `SCREENING: Kandidat terbaik — ${best.symbol || best.mint?.slice(0, 8)}\n` +
    `Rug Score: ${best.rug_score} | Momentum: ${best.momentum_score || "N/A"}\n` +
    `Keputusan: DEPLOY (dry-run mode — tidak ada eksekusi nyata)`
  );
}

function handleGeneral(messages) {
  const lastUser = messages.findLast(m => m.role === "user")?.content || "";
  const lower = lastUser.toLowerCase();

  if (/balance|wallet|sol|berapa/.test(lower)) {
    return buildResponse(
      "Saya perlu mengecek saldo wallet Anda. Gunakan tool get_wallet_balance."
    );
  }
  if (/status|posisi|positions?/.test(lower)) {
    return buildResponse(
      "Status agent: RUNNING (dry-run mode). Tidak ada posisi aktif saat ini. Cron jobs berjalan normal."
    );
  }
  if (/learning|analisis|rugi|loss/.test(lower)) {
    return buildResponse(
      "ANALISIS LOSS:\nROOT_CAUSE: Market volatility tinggi pada saat entry\nMISSED_FLAGS: Volume sell meningkat sebelum drop\nAVOID_PATTERN: Hindari entry saat volume sell > 60% dari total\nLESSON_1: Selalu periksa rasio buy/sell sebelum deploy\nLESSON_2: Gunakan momentum score minimum 40 sebelum entry"
    );
  }

  return buildResponse(
    "Saya sedang berjalan dalam mode local proxy. Untuk operasi penuh, konfigurasi OPENROUTER_API_KEY atau ANTHROPIC_API_KEY di file .env"
  );
}

function routeRequest(body) {
  const { messages = [], tools = [] } = body;
  const allContent = messages.map(m => m.content || "").join("\n").toLowerCase();

  requestCount++;
  const num = String(requestCount).padStart(3, "0");

  if (/management cycle/i.test(allContent)) {
    console.log(`[${num}] → MANAGEMENT CYCLE`);
    return handleManagementCycle(messages);
  }
  if (/screening cycle/i.test(allContent)) {
    console.log(`[${num}] → SCREENING CYCLE`);
    return handleScreeningCycle(messages, tools);
  }
  if (/learning mode|analisis loss|observation/i.test(allContent)) {
    console.log(`[${num}] → LEARNING/ANALYSIS`);
    return handleGeneral(messages);
  }

  console.log(`[${num}] → GENERAL (${allContent.slice(0, 60).trim()}...)`);
  return handleGeneral(messages);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", requests: requestCount }));
    return;
  }

  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let rawBody = "";
  req.on("data", chunk => { rawBody += chunk; });
  req.on("end", () => {
    try {
      const body = JSON.parse(rawBody);
      const response = routeRequest(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (e) {
      console.error("Proxy error:", e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║   Local Claude Proxy — Port ${PORT}          ║`);
  console.log(`║   OpenAI-compatible mock LLM server       ║`);
  console.log(`║   Endpoint: http://localhost:${PORT}/v1      ║`);
  console.log(`╚═══════════════════════════════════════════╝\n`);
});

server.on("error", (e) => {
  console.error("Server error:", e.message);
  process.exit(1);
});
