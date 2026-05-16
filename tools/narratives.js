/**
 * Narrative Engine — classify tokens by thematic category and track narrative heat.
 *
 * A "narrative" is a thematic cluster (AI agents, dogs, cats, political, etc).
 * In memecoin land, narrative momentum often matters more than fundamentals —
 * if AI narrative is hot, AI tokens pump; if dogs are dying, dog tokens dump.
 *
 * Pipeline:
 *   1. classifyNarrative(token)  — name/symbol/desc keyword match → narrative tag(s)
 *   2. recordNarrativeOutcome    — log trade P&L by narrative → builds heat profile
 *   3. getNarrativeHeat          — returns current ranking + recommendation
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEAT_FILE = path.join(__dirname, "../narrative-heat.json");

// ─── Taxonomy ────────────────────────────────────────────────────
// Each narrative has keywords matched against token symbol + name + description.
// Order doesn't matter; tokens can match multiple narratives.

export const NARRATIVES = {
  AI: {
    keywords: ["ai", "agi", "gpt", "claude", "agent", "neural", "llm", "ml", "openai", "anthropic", "grok", "model", "bot", "intelligence"],
    note: "AI agents & ML themes",
  },
  DOGS: {
    keywords: ["dog", "doge", "shib", "wif", "puppy", "bonk", "inu", "akita", "corgi", "husky", "pup"],
    note: "Dog-themed memes (oldest narrative)",
  },
  CATS: {
    keywords: ["cat", "meow", "popcat", "kitty", "purr", "neko", "tabby", "feline", "kat"],
    note: "Cat-themed memes",
  },
  POLITICAL: {
    keywords: ["trump", "biden", "maga", "potus", "election", "kamala", "harris", "putin", "vance", "rfk"],
    note: "US politics / election cycle",
  },
  CULTURE: {
    keywords: ["pepe", "wojak", "chad", "doomer", "based", "boomer", "zoomer", "ngmi", "gmi", "wagmi"],
    note: "4chan / internet culture memes",
  },
  ANIMAL: {
    keywords: ["frog", "duck", "monkey", "ape", "bear", "bull", "lion", "tiger", "wolf", "fox", "hamster", "capybara", "panda"],
    note: "Other animal memes",
  },
  CELEBRITY: {
    keywords: ["musk", "elon", "kim", "taylor", "kanye", "drake", "messi", "ronaldo", "swift", "bezos"],
    note: "Real-person tokens",
  },
  FOOD: {
    keywords: ["food", "pizza", "burger", "noodle", "ramen", "sushi", "boba", "coffee", "ketchup", "popcorn"],
    note: "Food-themed memes",
  },
  GAMING: {
    keywords: ["game", "pixel", "voxel", "metaverse", "play", "rpg", "fps", "mmo"],
    note: "Gaming themes",
  },
  TECH: {
    keywords: ["solana", "sol", "btc", "eth", "based", "vc", "fund", "defi", "dex"],
    note: "Crypto-self-referential",
  },
  CHINESE: {
    keywords: ["chinese", "china", "ccp", "wechat", "tiktok", "xi"],
    note: "Asian / China themes",
  },
  NUMBERS: {
    keywords: ["100x", "1000x", "moon", "pump", "rocket", "lambo"],
    note: "Pure shitcoin theme",
  },
};

const NARRATIVE_NAMES = Object.keys(NARRATIVES);

// ─── Classifier ──────────────────────────────────────────────────

const _kwRegexCache = new Map();
function kwRegex(kw) {
  if (!_kwRegexCache.has(kw)) {
    // Match as a word — but allow it to be embedded in tickers like "AICAT", "BONKAI"
    _kwRegexCache.set(kw, new RegExp(`(?:^|[^a-z0-9])${kw}(?:[^a-z0-9]|$)|${kw}`, "i"));
  }
  return _kwRegexCache.get(kw);
}

/**
 * Classify a token into one or more narratives.
 * @param {{ symbol, name, description? }} token
 * @returns {Array<{ narrative, matched_keyword, confidence }>}
 */
export function classifyNarrative(token) {
  const text = `${token.symbol || ""} ${token.name || ""} ${token.description || ""}`.toLowerCase();
  if (!text.trim()) return [{ narrative: "OTHER", matched_keyword: null, confidence: 0 }];

  const matches = [];
  for (const [narrative, def] of Object.entries(NARRATIVES)) {
    for (const kw of def.keywords) {
      if (kwRegex(kw).test(text)) {
        matches.push({
          narrative,
          matched_keyword: kw,
          // Higher confidence if keyword matches as a clear word boundary in symbol/name
          confidence: text.includes(` ${kw} `) || text.startsWith(kw) || text.endsWith(kw) ? 0.9 : 0.6,
        });
        break;  // one keyword per narrative is enough
      }
    }
  }

  if (matches.length === 0) {
    return [{ narrative: "OTHER", matched_keyword: null, confidence: 0 }];
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Compact one-line narrative tag for logging/prompts.
 */
export function summarizeNarrative(token) {
  const tags = classifyNarrative(token);
  if (tags.length === 1 && tags[0].narrative === "OTHER") return "OTHER";
  return tags.slice(0, 2).map(t => t.narrative).join("+");
}

// ─── Heat Tracking ───────────────────────────────────────────────

function loadHeat() {
  if (!fs.existsSync(HEAT_FILE)) {
    const empty = { narratives: {}, last_updated: null };
    for (const n of NARRATIVE_NAMES) {
      empty.narratives[n] = { trades: 0, wins: 0, total_pnl_pct: 0, avg_pnl_pct: 0, last_trade_at: null };
    }
    return empty;
  }
  try { return JSON.parse(fs.readFileSync(HEAT_FILE, "utf8")); }
  catch { return { narratives: {}, last_updated: null }; }
}

function saveHeat(data) {
  fs.writeFileSync(HEAT_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record outcome of a closed trade by narrative.
 * @param {{ symbol, name, description?, pnl_pct }} trade
 */
export function recordNarrativeOutcome(trade) {
  const tags = classifyNarrative(trade);
  if (tags.length === 0 || tags[0].narrative === "OTHER") return;

  const data = loadHeat();
  const pnlPct = Number(trade.pnl_pct) || 0;

  // Credit all matching narratives (split influence so multi-narrative tokens don't double-count)
  const share = 1 / tags.length;
  for (const t of tags) {
    const slot = data.narratives[t.narrative] || { trades: 0, wins: 0, total_pnl_pct: 0, avg_pnl_pct: 0, last_trade_at: null };
    slot.trades += share;
    if (pnlPct > 0) slot.wins += share;
    slot.total_pnl_pct += pnlPct * share;
    slot.avg_pnl_pct = slot.trades > 0 ? slot.total_pnl_pct / slot.trades : 0;
    slot.last_trade_at = new Date().toISOString();
    data.narratives[t.narrative] = slot;
  }
  data.last_updated = new Date().toISOString();
  saveHeat(data);

  log("narrative", `${trade.symbol} (${tags.map(t => t.narrative).join("+")}) → ${pnlPct.toFixed(1)}% logged to heat`);
}

/**
 * Return narrative heat ranked by avg P&L (with minimum trade count for reliability).
 */
export function getNarrativeHeat({ min_trades = 3 } = {}) {
  const data = loadHeat();
  const ranked = Object.entries(data.narratives || {})
    .filter(([_, s]) => (s.trades || 0) >= min_trades)
    .map(([name, s]) => ({
      narrative: name,
      trades: Math.round(s.trades * 10) / 10,
      winrate: s.trades > 0 ? Number((s.wins / s.trades).toFixed(3)) : 0,
      avg_pnl_pct: Number((s.avg_pnl_pct || 0).toFixed(2)),
      last_trade_at: s.last_trade_at,
    }))
    .sort((a, b) => b.avg_pnl_pct - a.avg_pnl_pct);

  const hot = ranked.filter(r => r.avg_pnl_pct > 10).map(r => r.narrative);
  const cold = ranked.filter(r => r.avg_pnl_pct < -10).map(r => r.narrative);

  return {
    ranked,
    hot,
    cold,
    last_updated: data.last_updated,
  };
}

/**
 * Compact heat block for prompts. Shows hot + cold only.
 */
export function getNarrativeHeatPrompt() {
  const heat = getNarrativeHeat();
  if (heat.ranked.length === 0) return "";
  const hot = heat.hot.length > 0 ? `🔥 hot: ${heat.hot.join(",")}` : "";
  const cold = heat.cold.length > 0 ? `❄️ cold: ${heat.cold.join(",")}` : "";
  return [hot, cold].filter(Boolean).join(" | ");
}
