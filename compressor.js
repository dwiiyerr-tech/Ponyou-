/**
 * Token Compressor (RTK-style) for Ponyou.
 * Reduces LLM token usage by compressing tool outputs.
 */

import { log } from "./logger.js";

const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_MAX_STRING_LENGTH = 200;

/**
 * Main compression entry point.
 * @param {any} data - The raw tool result data.
 * @param {string} toolName - Name of the tool (for specific rules).
 */
export function compressToolOutput(data, toolName) {
  if (!data || typeof data !== "object") return data;

  // Clone to avoid modifying original data
  let result = JSON.parse(JSON.stringify(data));

  // Specific rules for high-volume tools
  if (toolName === "discover_tokens") {
    result = compressDiscoverTokens(result);
  } else if (toolName === "get_token_holders") {
    result = compressTokenHolders(result);
  } else if (toolName === "list_lessons") {
    result = compressList(result, "lessons", ["id", "rule", "tags"]);
  } else if (toolName === "get_performance_history") {
    result = compressList(result, "trades", ["ts", "symbol", "pnl_pct", "exit_reason"]);
  }

  // General compression
  return recursiveCompress(result);
}

function compressDiscoverTokens(data) {
  if (!data.tokens || !Array.isArray(data.tokens)) return data;

  const originalCount = data.tokens.length;
  // Keep only top N tokens and essential fields
  data.tokens = data.tokens.slice(0, DEFAULT_MAX_ITEMS).map(t => ({
    mint: t.mint,
    sym: t.symbol,
    mc: t.mcap,
    sw: t.swaps,
    b: t.buys,
    s: t.sells,
    ch1h: t.price_change_1h,
    hot: t.hot_level,
    lp: t.launchpad,
  }));

  if (originalCount > DEFAULT_MAX_ITEMS) {
    data._rtk = `Compressed: showing ${DEFAULT_MAX_ITEMS}/${originalCount} tokens.`;
  }

  return data;
}

function compressTokenHolders(data) {
  if (!data.holders || !Array.isArray(data.holders)) return data;

  const originalCount = data.holders.length;
  data.holders = data.holders.slice(0, 5).map(h => ({
    address: h.address?.slice(0, 8) + "...",
    pct: h.pct,
    sol_balance: h.sol_balance,
    tags: h.tags,
  }));

  data._rtk = `Compressed: top 5/${originalCount} holders shown.`;
  return data;
}

function compressList(data, listKey, fields) {
  const list = data[listKey] || data;
  if (!Array.isArray(list)) return data;

  const originalCount = list.length;
  const compressed = list.slice(-DEFAULT_MAX_ITEMS).map(item => {
    const obj = {};
    for (const f of fields) obj[f] = item[f];
    return obj;
  });

  if (Array.isArray(data)) return compressed;
  data[listKey] = compressed;
  data._rtk = `Compressed: showing last ${DEFAULT_MAX_ITEMS}/${originalCount} items.`;
  return data;
}

function recursiveCompress(obj, depth = 0) {
  if (depth > 5) return "[Max Depth]";
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    if (obj.length > DEFAULT_MAX_ITEMS) {
      const summary = obj.slice(0, DEFAULT_MAX_ITEMS).map(i => recursiveCompress(i, depth + 1));
      summary.push(`... and ${obj.length - DEFAULT_MAX_ITEMS} more items (RTK Compressed)`);
      return summary;
    }
    return obj.map(i => recursiveCompress(i, depth + 1));
  }

  const newObj = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip empty/null values to save tokens
    if (value === null || value === undefined || value === "") continue;

    // Truncate long strings (likely logs or descriptions)
    if (typeof value === "string" && value.length > DEFAULT_MAX_STRING_LENGTH) {
      newObj[key] = value.slice(0, DEFAULT_MAX_STRING_LENGTH) + "... [Truncated by RTK]";
    } else {
      newObj[key] = recursiveCompress(value, depth + 1);
    }
  }
  return newObj;
}
