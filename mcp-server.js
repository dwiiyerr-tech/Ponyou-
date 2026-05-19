import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, file), "utf8"));
  } catch {
    return null;
  }
}

function sortByDateDesc(items, key) {
  return [...items].sort((a, b) => {
    const aTime = new Date(a?.[key] || 0).getTime();
    const bTime = new Date(b?.[key] || 0).getTime();
    return bTime - aTime;
  });
}

function sortByNumberDesc(items, key) {
  return [...items].sort((a, b) => (b?.[key] ?? -Infinity) - (a?.[key] ?? -Infinity));
}

function sortByNumberAsc(items, key) {
  return [...items].sort((a, b) => (a?.[key] ?? Infinity) - (b?.[key] ?? Infinity));
}

const server = new Server(
  { name: "ponyou-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_market_intelligence",
      description: "Baca kondisi market ponyou saat ini (condition, score, description).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_open_positions",
      description: "Baca semua posisi terbuka dari state.json.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_screened_tokens",
      description: "Baca 10 token terbaru dari hasil screening (observed-tokens.json).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_lessons",
      description: "Baca semua trading lessons yang dipelajari bot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_regime_memory",
      description: "Baca top 5 regime terbaik dan 5 terburuk berdasarkan win_rate.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_performance_summary",
      description: "Baca ringkasan performa bot (swaps, win_rate, dll) dari metrics.json.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_smart_wallets",
      description: "Baca daftar smart wallets yang dipantau bot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  let result;

  switch (name) {
    case "get_market_intelligence": {
      try {
        const data = readJson("market-intel.json");
        if (!data) {
          result = { error: "Data not available", file: "market-intel.json" };
          break;
        }
        const latest = Array.isArray(data.snapshots) && data.snapshots.length
          ? data.snapshots[data.snapshots.length - 1]
          : {};
        result = {
          condition: data.currentCondition ?? latest.condition ?? null,
          score: latest.confidence ?? null,
          description: null,
          metrics: latest.metrics ?? null,
          updated_at: latest.ts ?? data.lastUpdated ?? null,
        };
      } catch (e) {
        result = { error: e.message, file: "market-intel.json" };
      }
      break;
    }

    case "get_open_positions": {
      try {
        const data = readJson("state.json");
        if (!data) {
          result = { error: "Data not available", file: "state.json" };
          break;
        }
        const positions = Array.isArray(data.positions) ? data.positions : [];
        result = positions
          .filter(p => p?.status === "open")
          .map(p => ({
            mint: p.mint ?? null,
            symbol: p.symbol ?? null,
            amount_sol: p.amount_sol ?? null,
            deployed_at: p.deployed_at ?? null,
            wallet_address: p.wallet_address ?? null,
          }));
      } catch (e) {
        result = { error: e.message, file: "state.json" };
      }
      break;
    }

    case "get_screened_tokens": {
      try {
        const data = readJson("observed-tokens.json");
        if (!data) {
          result = { error: "Data not available", file: "observed-tokens.json" };
          break;
        }
        // observed-tokens.json: { observed: { mint: { ...token } } }
        const tokens = data.observed ? Object.values(data.observed) : [];
        result = sortByDateDesc(tokens, "observed_at")
          .slice(0, 10)
          .map(t => ({
            mint: t.mint ?? null,
            symbol: t.symbol ?? null,
            rug_score: t.rug_score ?? null,
            narrative: t.narrative ?? null,
            observed_at: t.observed_at ?? null,
            outcome: t.outcome ?? null,
          }));
      } catch (e) {
        result = { error: e.message, file: "observed-tokens.json" };
      }
      break;
    }

    case "get_lessons": {
      try {
        const data = readJson("lessons.json");
        if (!data) {
          result = { error: "Data not available", file: "lessons.json" };
          break;
        }
        const lessons = Array.isArray(data.lessons) ? data.lessons : [];
        result = lessons.map(l => ({
          rule: l.rule ?? null,
          confidence: l.confidence ?? null,
          source: l.source ?? null,
          created_at: l.created_at ?? null,
        }));
      } catch (e) {
        result = { error: e.message, file: "lessons.json" };
      }
      break;
    }

    case "get_regime_memory": {
      try {
        const data = readJson("regime-memory.json");
        if (!data) {
          result = { error: "Data not available", file: "regime-memory.json" };
          break;
        }
        // regime-memory.json: { regimes: { "key": { ... } } }
        const regimes = data.regimes ? Object.values(data.regimes) : [];
        const withWinRate = regimes.map(r => ({
          ...r,
          win_rate: r.trade_count > 0 ? r.win_count / r.trade_count : 0,
        }));
        result = {
          best: sortByNumberDesc(withWinRate, "win_rate").slice(0, 5),
          worst: sortByNumberAsc(withWinRate, "win_rate").slice(0, 5),
          total_regimes: regimes.length,
        };
      } catch (e) {
        result = { error: e.message, file: "regime-memory.json" };
      }
      break;
    }

    case "get_performance_summary": {
      try {
        const data = readJson("metrics.json");
        result = data ?? { error: "Data not available", file: "metrics.json" };
      } catch (e) {
        result = { error: e.message, file: "metrics.json" };
      }
      break;
    }

    case "get_smart_wallets": {
      try {
        const data = readJson("smart-wallets.json");
        if (!data) {
          result = { error: "Data not available", file: "smart-wallets.json" };
          break;
        }
        const wallets = Array.isArray(data) ? data : Array.isArray(data.wallets) ? data.wallets : [];
        result = wallets.map(w => ({
          address: w.address ?? null,
          label: w.label ?? null,
          win_rate: w.win_rate ?? null,
          total_trades: w.total_trades ?? null,
        }));
      } catch (e) {
        result = { error: e.message, file: "smart-wallets.json" };
      }
      break;
    }

    default:
      result = { error: `Unknown tool: ${name}` };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
