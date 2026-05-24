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
import { atomicWriteJson } from "../atomic-write.js";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEAT_FILE = path.join(__dirname, "../narrative-heat.json");

// ─── Taxonomy ────────────────────────────────────────────────────
// Each narrative has keywords matched against token symbol + name + description.
// Order doesn't matter; tokens can match multiple narratives.

export const NARRATIVES = {
  AI: {
    keywords: ["ai", "agi", "gpt", "claude", "agent", "neural", "llm", "ml", "openai", "anthropic", "grok", "model", "bot", "intelligence", "cortana", "siri", "alexa", "bard", "gemini", "chatgpt", "copilot", "deepseek"],
    note: "AI agents & ML themes",
  },
  DOGS: {
    keywords: ["dog", "doge", "shib", "wif", "puppy", "bonk", "inu", "akita", "corgi", "husky", "pup", "floki", "shiba", "dogo", "hound", "woof", "bark", "mutt", "chihuahua", "poodle", "dachshund"],
    note: "Dog-themed memes (oldest narrative)",
  },
  CATS: {
    keywords: ["cat", "meow", "popcat", "kitty", "purr", "neko", "tabby", "feline", "kat", "kitten", "meow", "nyan", "mew", "paws", "whisker", "munchkin"],
    note: "Cat-themed memes",
  },
  POLITICAL: {
    keywords: ["trump", "biden", "maga", "potus", "election", "kamala", "harris", "putin", "vance", "rfk", "obama", "pelosi", "marx", "lenin", "stalin", "mao", "che", "george", "washington", "lincoln", "fdr", "jfk", "nixon", "reagan", "clinton", "sanders", "aoc", "mtg", "gaetz", "boebert", "mcga", "donald", "melania", "ivanka", "barron", "president", "governor", "senate", "congress", "vote", "ballot", "democrat", "republican", "gop", "dnc", "rnc", "lib", "conservative", "libertarian", "socialist", "communist", "fascist", "antifa", "patriot", "freedom", "liberty", "constitution", "america", "usa", "murica", "merca"],
    note: "US politics / election cycle",
  },
  CULTURE: {
    keywords: ["pepe", "wojak", "chad", "doomer", "based", "boomer", "zoomer", "ngmi", "gmi", "wagmi", "degen", "copium", "troll", "lol", "lmao", "lmfao", "twerk", "lunatic", "clown", "cope", "seethe", "mald", "meme", "dank", "normie", "gigachad", "sigma", "alpha", "beta", "cringe", "based", "redpill", "bluepill", "blackpill", "schizo", "brainrot", "skibidi", "rizz", "gyat", "ohio", "fanum", "woj", "doom", "kek", "kekw", "monka", "pog", "pogchamp", "omegalul", "feelsbad", "feelsgood", "sadge", "cringe", "yikes", "bruh", "fam", "sus", "yeet", "bussin", "sheesh", "noic", "lit", "fire", "vibe", "aura", "goon", "gooning", "edging"],
    note: "4chan / internet culture memes",
  },
  ANIMAL: {
    keywords: ["frog", "duck", "monkey", "ape", "bear", "bull", "lion", "tiger", "wolf", "fox", "hamster", "capybara", "panda", "rabbit", "bunny", "fish", "shark", "whale", "dolphin", "bird", "eagle", "hawk", "owl", "snake", "cobra", "viper", "python", "dragon", "dino", "turtle", "penguin", "croc", "alligator", "cow", "pig", "chicken", "rooster", "horse", "pony", "deer", "moose", "goat", "sheep", "lamb", "squirrel", "raccoon", "otter", "seal", "crab", "octopus", "squid", "jellyfish", "starfish", "ant", "bee", "spider", "scorpion", "worm", "snail", "slug", "koala", "kangaroo", "platypus", "hedgehog", "unicorn", "pegasus", "phoenix", "griffin", "yeti", "sasquatch", "zombie", "moo", "rabbids", "moodeng", "pygmy", "hippo", "rhino", "elephant", "giraffe", "zebra", "leopard", "cheetah", "panther", "jaguar", "cougar", "lynx", "bobcat", "hyena", "warthog", "meerkat", "mongoose", "beaver", "porcupine", "skunk", "badger", "weasel", "ferret", "chinchilla", "gerbil", "parrot", "toucan", "flamingo", "peacock", "ostrich", "emu", "kiwi", "pelican", "seagull", "pigeon", "raven", "crow", "magpie", "woodpecker", "hummingbird", "butterfly", "moth", "dragonfly", "ladybug", "beetle", "cricket", "grasshopper", "mantis", "cicada", "firefly", "zoomie"],
    note: "Other animal memes",
  },
  CELEBRITY: {
    keywords: ["musk", "elon", "kim", "taylor", "kanye", "drake", "messi", "ronaldo", "swift", "bezos", "tyson", "jordan", "serena", "nadal", "federer", "bolt", "phelps", "woods", "hamilton", "verstappen", "senna", "schumacher", "ali", "marley", "elvis", "mj", "madonna", "gaga", "beyonce", "rihanna", "weeknd", "ed", "sheeran", "adele", "bruno", "mars", "post", "malone", "bad", "bunny", "shakira", "bieber", "selena", "jenner", "kardashian"],
    note: "Real-person tokens",
  },
  FOOD: {
    keywords: ["food", "pizza", "burger", "noodle", "ramen", "sushi", "boba", "coffee", "ketchup", "popcorn", "taco", "burrito", "salsa", "guac", "avocado", "toast", "bagel", "donut", "croissant", "pancake", "waffle", "bacon", "steak", "bbq", "kimchi", "pho", "curry", "dumpling", "wonton", "dimsum", "tempura", "wasabi", "mochi", "matcha", "chai", "latte", "espresso", "cappuccino", "frappe", "milkshake", "smoothie", "lemonade", "cola", "pepsi", "fanta", "sprite", "drpepper"],
    note: "Food-themed memes",
  },
  GAMING: {
    keywords: ["game", "pixel", "voxel", "metaverse", "play", "rpg", "fps", "mmo", "gta", "pokemon", "mario", "sonic", "zelda", "kirby", "nintendo", "sega", "playstation", "xbox", "steam", "epic", "minecraft", "roblox", "fortnite", "pubg", "dota", "csgo", "valorant", "overwatch", "fifa", "nba2k", "madden", "cod", "halo", "destiny", "skyrim", "fallout", "warcraft", "starcraft", "diablo", "tetris", "pacman", "arcade", "console", "quest", "raid", "dungeon", "guild", "boss", "loot", "noob", "pwn", "frag", "spawn", "respawn", "speedrun", "esports", "twitch", "discord", "kda", "nerf", "buff", "glitch", "lag", "poke", "pokeball", "pikachu", "eevee", "charizard", "mewtwo", "snorlax", "magikarp", "gyarados", "jigglypuff", "bulbasaur", "squirtle", "charmander", "ash", "misty", "brock", "teamrocket", "gym", "elitefour", "npc", "maze", "platformer", "soulslike", "roguelike", "roguelite", "bullethell", "metroidvania", "sandbox", "simulator", "walkthrough", "letsplay", "playthrough"],
    note: "Gaming themes",
  },
  TECH: {
    keywords: ["solana", "sol", "btc", "eth", "defi", "dex", "chain", "protocol", "node", "validator", "stake", "yield", "swap", "amm", "liquidity", "blockchain", "crypto", "token", "nft", "dao", "web3", "metaverse", "layer2", "l2", "rollup", "zk", "snark", "stark", "consensus", "hash", "miner", "validator", "oracle", "bridge", "wallet", "custody", "multisig", "hodl", "fomo", "fud", "rekt", "wagmi", "wen", "jeet", "paperhand", "diamondhand"],
    note: "Crypto-self-referential",
  },
  CHINESE: {
    keywords: ["chinese", "china", "ccp", "wechat", "tiktok", "xi", "beijing", "shanghai", "hong", "kong", "taiwan", "macau", "mandarin", "cantonese", "yuan", "renminbi", "dragon", "panda", "kungfu", "wushu", "taichi", "feng", "shui", "dao", "confucius", "laozi", "sunwukong", "monkeyking", "neza", "mulan"],
    note: "Asian / China themes",
  },
  NUMBERS: {
    keywords: ["100x", "1000x", "moon", "pump", "rocket", "lambo", "wenlambo", "tothemoon", "mooning", "gem", "100xgem", "degen", "apein", "yolo", "wagmi", "ngmi"],
    note: "Pure shitcoin theme",
  },
  FINANCE: {
    keywords: ["bank", "vault", "atm", "dividend", "mint", "coin", "cash", "money", "rich", "wealth", "cap", "stable", "penny", "fund", "bond", "401k", "ira", "hedge", "trade", "trader", "trading", "profit", "gain", "earn", "yield", "interest", "loan", "credit", "debit", "deposit", "withdraw", "savings", "invest", "capital", "asset", "equity", "share", "stock", "option", "future", "forex", "commodity", "gold", "silver", "diamond", "platinum", "treasury", "federal", "reserve", "sec", "sec", "finra", "fdic", "inflation", "deflation", "recession", "bullmarket", "bearmarket", "ipo", "spac", "merger", "acquisition", "ledger", "balance", "audit", "fiscal"],
    note: "Finance / money themes",
  },
  SPORTS: {
    keywords: ["sport", "football", "soccer", "basketball", "baseball", "hockey", "tennis", "golf", "rugby", "cricket", "volleyball", "swimming", "boxing", "mma", "ufc", "wwe", "wrestling", "racing", "f1", "nascar", "moto", "rally", "olympic", "fifa", "uefa", "nba", "nfl", "mlb", "nhl", "fc", "fcb", "rmadrid", "manutd", "liverpool", "arsenal", "chelsea", "barca", "juve", "bayern", "psg", "mancity", "superbowl", "worldcup", "champions", "league", "premier", "seriea", "laliga", "bundesliga", "ball", "goal", "score", "win", "champion", "trophy", "medal", "goldmedal", "mvp", "allstar", "playoff", "finals", "semifinal", "quarterfinal", "hattrick", "knockout", "sprint", "marathon", "triathlon", "crossfit", "bodybuilding", "powerlifting", "fwc", "copadelrey", "copaamerica", "eurocup", "afcon", "asiancup", "mls", "nwsl", "ipl", "epl", "lcs", "lec", "lck", "lpl", "major", "minor", "stadium", "arena", "pitch", "field", "court", "rink", "ring", "track", "velodrome", "gym", "dojo", "gymnastics", "skating", "skiing", "snowboarding", "surfing", "skateboarding", "biking", "cycling", "climbing", "parachute", "skydiving", "bungee", "rafting", "kayaking", "sailing", "rowing", "fencing", "archery", "judo", "karate", "taekwondo", "bjj", "jiujitsu", "kickboxing", "muaythai", "kungfu", "wushu"],
    note: "Sports themes",
  },
  HEALTH: {
    keywords: ["virus", "ebola", "covid", "flu", "sick", "doctor", "nurse", "hospital", "medical", "pill", "drug", "pharma", "cure", "vaccine", "disease", "cancer", "aids", "hiv", "malaria", "polio", "measles", "smallpox", "plague", "cholera", "rabies", "tetanus", "hepatitis", "diabetes", "asthma", "allergy", "therapy", "surgery", "transplant", "organ", "blood", "plasma", "dna", "rna", "gene", "genome", "cell", "stemcell", "bacteria", "probiotic", "vitamin", "supplement", "protein", "hormone", "steroid", "antibiotic", "antiviral", "painkiller", "anesthesia", "ambulance", "emergency", "clinic", "pharmacy", "diagnosis", "prognosis", "symptom", "syndrome", "disorder", "epidemic", "pandemic", "outbreak", "quarantine", "lockdown", "mask", "sanitizer", "hygiene", "wellness", "fitness", "exercise", "meditation", "yoga", "mentalhealth", "therapy", "counseling", "psychology", "psychiatry", "neurology", "cardiology", "oncology", "pediatrics", "geriatrics", "dentist", "optical", "vision", "hearing", "speech", "physical", "massage", "spa", "sauna", "aromatherapy", "acupuncture", "chiropractic", "naturopathy", "homeopathy", "herbal", "organic", "natural", "holistic"],
    note: "Health / medical themes",
  },
  SCIFI: {
    keywords: ["alien", "ufo", "space", "galaxy", "star", "planet", "mars", "cosmic", "astro", "rocket", "spaceship", "shuttle", "nasa", "spacex", "orbit", "lunar", "solar", "comet", "asteroid", "nebula", "quasar", "pulsar", "blackhole", "wormhole", "timetravel", "parallel", "multiverse", "dimension", "portal", "warp", "laser", "plasma", "photon", "robot", "cyborg", "android", "mecha", "gundam", "transformer", "terminator", "matrix", "skynet", "hal9000", "bladerunner", "dune", "starwars", "startrek", "trek", "jedi", "sith", "lightsaber", "deathstar", "xwing", "tiefighter", "enterprise", "klingon", "vulcan", "spock", "skywalker", "vader", "yoda", "mandalorian", "grogu", "hobbit", "lotr", "gandalf", "frodo", "sauron", "elf", "dwarf", "orc", "goblin", "troll", "fairy", "wizard", "witch", "warlock", "sorcerer", "mage", "magic", "spell", "potion", "enchant", "mythic", "legendary", "mythical", "folklore", "superhero", "marvel", "avenger", "xmen", "spiderman", "batman", "superman", "wolverine", "deadpool", "thanos", "loki", "thor", "hulk", "ironman", "captain", "america", "blackwidow", "hawkeye", "vision", "scarlet", "panther", "antman", "strange", "guardian", "nova", "eternal", "omen", "spcx", "silversurfer", "doom", "riddick", "avatar", "inception", "tenet", "interstellar", "arrival", "prometheus", "xenomorph", "predator", "robocop", "ghostbusters", "backtothefuture", "jurassic", "tremor", "godzilla", "kong", "mothra", "ultraman", "powerranger", "voltron", "thundercat", "heman", "shera", "transformers", "autobot", "decepticon", "cybertron", "primitive", "beastwars", "anime", "manga", "naruto", "sasuke", "sakura", "kakashi", "onepiece", "luffy", "zoro", "bleach", "ichigo", "aot", "titan", "eren", "mikasa", "levi", "goku", "vegeta", "dbz", "saitama", "onepunchman", "garou", "genos", "jojo", "dio", "jotaro", "evangelion", "shinji", "asuka", "rei", "cowboybebop", "spike", "vicious", "faye", "edward", "fullmetal", "alphonse", "edwardelric", "deathnote", "light", "l", "ryuk", "kira", "lelouch", "codegeass", "suzaku", "cc", "gurrenlagann", "simon", "kamina", "yoko", "killua", "gon", "hisoka", "kurapika", "leorio", "chrollo", "meruem", "netero", "tanjiro", "nezuko", "zenitsu", "inosuke", "muzan", "rengoku", "giyu", "shinobu", "akaza", "douma", "kokushibo", "gojo", "sukuna", "itadori", "megumi", "nobara", "toji", "maki", "toge", "panda", "jjk", "makima", "denji", "pochita", "chainsawman", "power", "aki", "reze", "quanxi", "kobeni", "yoru", "asa", "fami", "fujimoto", "tatsuki", "imposter", "amongus", "sus", "crewmate", "fallguys", "beans", "poppy", "playtime", "huggy", "wuggy", "bendy", "ink", "mascot", "horror", "survival", "fnaf", "freddy", "bonnie", "chica", "foxy", "springtrap", "afton", "pizzeria", "sisterlocation", "securitybreach", "glamrock", "vanny", "mimic", "ruin", "helpwanted", "chimera"],
    note: "Sci-fi / fantasy / superhero themes",
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

// ─── Narrative Velocity ──────────────────────────────────────────

/**
 * Detect narratives that are gaining momentum in the current screening batch.
 * High velocity = multiple tokens from the same narrative appearing at once,
 * especially with strong buy pressure and high volume.
 *
 * @param {Array} candidates - Token list from the current screening cycle
 * @returns {{ velocities: Object, trendingNarratives: Array<string>, promptContext: string }}
 */
export function detectNarrativeVelocity(candidates = []) {
  const buckets = {}; // narrative → { tokens, totalVolume, totalSwaps, totalBuys, totalSells }

  for (const token of candidates) {
    if (!token?.symbol) continue;
    const tags = classifyNarrative(token);
    const names = tags.filter(t => t.narrative !== "OTHER").map(t => t.narrative);

    for (const n of names) {
      buckets[n] = buckets[n] || { tokens: [], totalVolume: 0, totalSwaps: 0, totalBuys: 0, totalSells: 0 };
      buckets[n].tokens.push(token.symbol);
      buckets[n].totalVolume += Number(token.volume || 0);
      buckets[n].totalSwaps += Number(token.swaps || 0);
      buckets[n].totalBuys += Number(token.buys || 0);
      buckets[n].totalSells += Number(token.sells || 0);
    }
  }

  const velocities = {};
  const trendingNarratives = [];

  for (const [narrative, data] of Object.entries(buckets)) {
    const tokenCount = data.tokens.length;
    const buyRatio = data.totalBuys + data.totalSells > 0
      ? data.totalBuys / (data.totalBuys + data.totalSells)
      : 0.5;
    const avgVolume = tokenCount > 0 ? data.totalVolume / tokenCount : 0;

    // Velocity score: weighted combination of token count, buy pressure, volume
    const countScore = Math.min(tokenCount * 20, 60); // cap at 60 for 3+ tokens
    const buyScore = buyRatio > 0.6 ? 25 : buyRatio > 0.5 ? 15 : 0;
    const volumeScore = Math.min(avgVolume / 10000, 15); // cap at 15

    const velocityScore = clampScore(countScore + buyScore + volumeScore, 0, 100);
    const isTrending = tokenCount >= 3 || (tokenCount >= 2 && buyRatio > 0.55 && avgVolume > 5000);

    velocities[narrative] = {
      token_count: tokenCount,
      tokens: data.tokens,
      total_volume: Math.round(data.totalVolume),
      total_swaps: data.totalSwaps,
      buy_ratio: Number(buyRatio.toFixed(2)),
      velocity_score: velocityScore,
      is_trending: isTrending,
    };

    if (isTrending) trendingNarratives.push(narrative);
  }

  const promptContext = trendingNarratives.length > 0
    ? `NARRATIVE VELOCITY (momentum tinggi): ${trendingNarratives.map(n => {
        const v = velocities[n];
        return `${n} (${v.token_count} token, buy:${Math.round(v.buy_ratio*100)}%, vol:$${Math.round(v.total_volume/1000)}k)`;
      }).join(" | ")}`
    : "";

  return { velocities, trendingNarratives, promptContext };
}

function clampScore(v, min, max) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

// ─── Cross-Batch Velocity Tracking ──────────────────────────────

const VELOCITY_FILE = path.join(__dirname, "../narrative-velocity.json");
const MAX_VELOCITY_BATCHES = 6;  // remember last 6 cycles (~1h at 10min cycles)
const VELOCITY_DECAY_PER_CYCLE = 0.75; // each cycle, previous velocity decays to 75%

function loadVelocity() {
  if (!fs.existsSync(VELOCITY_FILE)) return { batches: [], narratives: {}, last_updated: null };
  try { return JSON.parse(fs.readFileSync(VELOCITY_FILE, "utf8")); }
  catch { return { batches: [], narratives: {}, last_updated: null }; }
}

function saveVelocity(data) {
  atomicWriteJson(VELOCITY_FILE, data);
}

/**
 * Track velocity across screening cycles. Called once per cycle after
 * detectNarrativeVelocity() so emerging narratives gain persistent momentum.
 *
 * @param {{ velocities: Object, trendingNarratives: Array }} currentVelocity
 */
export function trackCrossBatchVelocity(currentVelocity) {
  const data = loadVelocity();
  const now = new Date().toISOString();

  // Decay existing narrative scores
  for (const [name, slot] of Object.entries(data.narratives)) {
    slot.cross_batch_score = Number((slot.cross_batch_score * VELOCITY_DECAY_PER_CYCLE).toFixed(2));
    slot.consecutive_cycles = slot.was_trending_last ? slot.consecutive_cycles + 1 : 0;
    slot.was_trending_last = false;
    // prune if score negligible and not recently active
    if (slot.cross_batch_score < 3 && slot.consecutive_cycles === 0) {
      delete data.narratives[name];
    }
  }

  // Merge current batch velocity
  for (const [name, vel] of Object.entries(currentVelocity.velocities || {})) {
    const slot = data.narratives[name] || {
      cross_batch_score: 0,
      peak_batch_score: 0,
      total_batches_seen: 0,
      consecutive_cycles: 0,
      was_trending_last: false,
      tokens_accumulated: [],
    };

    slot.cross_batch_score = clampScore(
      slot.cross_batch_score + vel.velocity_score * 0.4,
      0,
      100
    );
    slot.peak_batch_score = Math.max(slot.peak_batch_score || 0, vel.velocity_score);
    slot.total_batches_seen += 1;
    slot.consecutive_cycles = slot.was_trending_last ? slot.consecutive_cycles + 1 : 1;
    slot.was_trending_last = vel.is_trending;
    slot.last_token_count = vel.token_count;
    slot.last_buy_ratio = vel.buy_ratio;
    slot.last_total_volume = vel.total_volume;
    slot.last_seen_at = now;

    // Accumulate unique token symbols
    const existing = new Set(slot.tokens_accumulated || []);
    for (const sym of (vel.tokens || [])) existing.add(sym);
    slot.tokens_accumulated = [...existing].slice(-20);

    data.narratives[name] = slot;
  }

  // Record batch snapshot (ring buffer)
  data.batches.push({
    ts: now,
    trending: currentVelocity.trendingNarratives || [],
    narrative_count: Object.keys(currentVelocity.velocities || {}).length,
  });
  if (data.batches.length > MAX_VELOCITY_BATCHES) {
    data.batches = data.batches.slice(-MAX_VELOCITY_BATCHES);
  }

  data.last_updated = now;
  saveVelocity(data);
}

/**
 * Get persistent cross-batch velocity for narratives.
 * Returns data usable by conviction boost and LLM prompt.
 */
export function getCrossBatchVelocity() {
  const data = loadVelocity();
  const active = [];

  for (const [name, slot] of Object.entries(data.narratives || {})) {
    if (slot.cross_batch_score < 5) continue; // skip negligible
    active.push({
      narrative: name,
      cross_batch_score: slot.cross_batch_score,
      peak_batch_score: slot.peak_batch_score,
      consecutive_cycles: slot.consecutive_cycles,
      total_batches_seen: slot.total_batches_seen,
      last_token_count: slot.last_token_count,
      last_buy_ratio: slot.last_buy_ratio,
      is_sustained: slot.consecutive_cycles >= 2 && slot.cross_batch_score >= 20,
      tokens: slot.tokens_accumulated || [],
    });
  }

  active.sort((a, b) => b.cross_batch_score - a.cross_batch_score);

  const sustained = active.filter(a => a.is_sustained).map(a => a.narrative);
  const emerging = active.filter(a => !a.is_sustained && a.cross_batch_score >= 10).map(a => a.narrative);

  const promptContext = active.length > 0
    ? `CROSS-BATCH VELOCITY: ${active.slice(0, 5).map(a =>
        `${a.narrative}(score:${a.cross_batch_score}, cycles:${a.consecutive_cycles}${a.is_sustained ? ', sustained' : ''})`
      ).join(" | ")}`
    : "";

  return {
    active,
    sustained,
    emerging,
    promptContext,
    last_updated: data.last_updated,
    recent_batches: data.batches?.slice(-3) || [],
  };
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
  atomicWriteJson(HEAT_FILE, data);
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
 * Return narrative heat ranked by avg P&L.
 * Established narratives need >=3 trades. Emerging (1-2 trades) are included
 * separately with reduced confidence so new narratives can inform decisions early.
 */
export function getNarrativeHeat({ min_trades = 3, include_emerging = true } = {}) {
  const data = loadHeat();
  const allSlots = Object.entries(data.narratives || {});

  const established = allSlots
    .filter(([_, s]) => (s.trades || 0) >= min_trades)
    .map(([name, s]) => ({
      narrative: name,
      tier: "established",
      trades: Math.round(s.trades * 10) / 10,
      winrate: s.trades > 0 ? Number((s.wins / s.trades).toFixed(3)) : 0,
      avg_pnl_pct: Number((s.avg_pnl_pct || 0).toFixed(2)),
      last_trade_at: s.last_trade_at,
    }));

  const emerging = include_emerging
    ? allSlots
        .filter(([_, s]) => (s.trades || 0) >= 1 && (s.trades || 0) < min_trades)
        .map(([name, s]) => ({
          narrative: name,
          tier: "emerging",
          trades: Math.round(s.trades * 10) / 10,
          winrate: s.trades > 0 ? Number((s.wins / s.trades).toFixed(3)) : 0,
          avg_pnl_pct: Number((s.avg_pnl_pct || 0).toFixed(2)),
          last_trade_at: s.last_trade_at,
        }))
        .sort((a, b) => b.avg_pnl_pct - a.avg_pnl_pct)
    : [];

  const ranked = [...established.sort((a, b) => b.avg_pnl_pct - a.avg_pnl_pct), ...emerging];

  const hot = ranked.filter(r => r.avg_pnl_pct > 10).map(r => r.narrative);
  const cold = ranked.filter(r => r.avg_pnl_pct < -10).map(r => r.narrative);

  return {
    ranked,
    hot,
    cold,
    emerging: emerging.map(r => r.narrative),
    last_updated: data.last_updated,
  };
}

/**
 * Compact heat block for prompts. Shows hot + cold + emerging.
 */
export function getNarrativeHeatPrompt() {
  const heat = getNarrativeHeat();
  if (heat.ranked.length === 0) return "";
  const parts = [];
  if (heat.hot.length > 0) parts.push(`🔥 hot: ${heat.hot.join(",")}`);
  if (heat.cold.length > 0) parts.push(`❄️ cold: ${heat.cold.join(",")}`);
  if (heat.emerging.length > 0) parts.push(`🌱 emerging: ${heat.emerging.join(",")}`);
  return parts.join(" | ");
}
