/**
 * Definitions of all tools available to the Ponyou AI Agent.
 * These are passed to the LLM so it knows how to call them.
 */

export const tools = [
  // ─── GMGN Core ───────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_solana_gas_fee",
      description: "Filter 1: Check global Solana gas fee (priority fee). High/Extreme level means busy network.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "discover_tokens",
      description: "Search for trending or new tokens on Solana using GMGN. Returns candidates for scalping.",
      parameters: {
        type: "object",
        properties: {
          timeframe: { type: "string", enum: ["1m", "5m", "1h", "6h", "24h"], default: "1m" },
          orderby: { type: "string", enum: ["swaps", "volume", "liquidity", "market_cap", "hot_level"], default: "swaps" },
          limit: { type: "number", default: 20 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_smart_money_rank",
      description: "Find the most profitable 'Smart Money' wallets on Solana. Useful for copy-trading research.",
      parameters: {
        type: "object",
        properties: {
          timeframe: { type: "string", enum: ["1h", "24h", "7d", "30d"], default: "24h" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_smart_money_inflow",
      description: "Get tokens that are currently being bought heavily by Smart Money wallets.",
      parameters: {
        type: "object",
        properties: {
          timeframe: { type: "string", enum: ["1m", "5m", "1h", "6h", "24h"], default: "1h" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "discover_smart_wallets",
      description: "Autonomously scan top holders of trending Solana tokens, score each by realized PnL/winrate via Helius, and surface profitable wallets. Saves all results to discovered-wallets.json. Set auto_add=true to also auto-promote qualified wallets to smart-wallets.json.",
      parameters: {
        type: "object",
        properties: {
          source_tokens: { type: "number", default: 5, description: "Number of trending tokens to use as seed." },
          holders_per_token: { type: "number", default: 12, description: "Top N holders to scan per seed token." },
          min_winrate: { type: "number", default: 0.65, description: "Minimum winrate to qualify (0..1)." },
          min_trades: { type: "number", default: 8, description: "Minimum completed buy-sell pairs." },
          min_realized_pnl_sol: { type: "number", default: 0.5, description: "Minimum realized PnL in SOL." },
          max_avg_hold_seconds: { type: "number", default: 7200, description: "Skip if avg hold is longer (likely not a scalper)." },
          auto_add: { type: "boolean", default: false, description: "If true, automatically add qualified wallets to smart-wallets.json." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_discovered_wallets",
      description: "List wallets previously surfaced by discover_smart_wallets, sorted by realized PnL.",
      parameters: {
        type: "object",
        properties: {
          qualified_only: { type: "boolean", default: false, description: "Only return wallets that passed all thresholds." },
          limit: { type: "number", default: 50 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "learn_rug_patterns",
      description: "Cluster rug-memory.json into auto-learned patterns. Any feature combination appearing in 3+ historic rugs becomes a new rule.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_rug_patterns",
      description: "List active rug-detection patterns (seeded + auto-learned).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "harvest_market_rugs",
      description: "Proactively scan trending Solana tokens for pumped-then-dumped or liquidity-drained rug profiles. Detected rugs are recorded into rug-memory.json, which auto-triggers pattern learning. Use this to make Ponyou learn from market rugs without first losing money.",
      parameters: {
        type: "object",
        properties: {
          source_tokens: { type: "number", default: 30, description: "How many trending tokens to scan." },
          max_record: { type: "number", default: 10, description: "Max rugs to record per scan (caps Helius/RPC cost)." },
          include_security_fetch: { type: "boolean", default: true, description: "If false, skip the on-chain security fetch (faster but loses pattern signals)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "classify_narrative",
      description: "Classify a token into thematic narratives (AI, DOGS, CATS, POLITICAL, CULTURE, ANIMAL, CELEBRITY, FOOD, GAMING, etc) based on its symbol/name/description. Returns matching narratives with confidence.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          name: { type: "string" },
          description: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_narrative_heat",
      description: "Get current narrative heat — which themes are hot (high avg P&L) and which are dying. Use this to bias entry decisions toward winning narratives.",
      parameters: {
        type: "object",
        properties: {
          min_trades: { type: "number", default: 3, description: "Minimum sample size for a narrative to be ranked." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "resolve_ticker",
      description: "Resolve a ticker symbol (e.g. 'PEPE') to a concrete mint address. Memecoin tickers are highly ambiguous — this returns all known mints for the symbol, ranked by liquidity. If multiple, the user/agent must disambiguate.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker symbol, case-insensitive." },
          prefer_min_liquidity: { type: "number", default: 1000, description: "Minimum liquidity USD to consider." }
        },
        required: ["symbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tickers",
      description: "List all known ticker→mint mappings, ranked by liquidity.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", default: 50 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_trending_narratives",
      description: "Get the current trending narratives, tags, and hyped themes on Solana.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_token_security_details",
      description: "Filter 2 & 3: Check token security audit and top holder details (funded age, SOL balance).",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "The token mint address." }
        },
        required: ["mint"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "gmgn_swap",
      description: "Execute a swap (Buy/Sell) using GMGN Swap API. Use 'SOL' for native SOL.",
      parameters: {
        type: "object",
        properties: {
          token_in: { type: "string", description: "Input token mint or 'SOL'." },
          token_out: { type: "string", description: "Output token mint or 'SOL'." },
          amount: { type: "number", description: "Amount in decimal form (e.g. 0.5 for 0.5 SOL)." },
          slippage: { type: "number", default: 0.5, description: "Slippage tolerance in percentage." }
        },
        required: ["token_in", "token_out", "amount"]
      }
    }
  },

  // ─── Token Research ──────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_token_info",
      description: "Get general info for a token (price, mcap, holders, audit).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, symbol, or mint address." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_token_holders",
      description: "List top 100 holders of a token mint.",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
          limit: { type: "number", default: 20 }
        },
        required: ["mint"]
      }
    }
  },

  // ─── Wallet & Portfolio ──────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: "Get SOL and SPL token balances for the configured wallet.",
      parameters: { type: "object", properties: {} }
    }
  },

  // ─── Configuration ───────────────────────────────────────
  {
    type: "function",
    function: {
      name: "update_config",
      description: "Update the agent's runtime configuration (thresholds, risk, models).",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "object",
            description: "Dictionary of config keys to update."
          },
          reason: { type: "string", description: "Why this change is being made." }
        },
        required: ["changes"]
      }
    }
  },

  // ─── Learning & Memory ───────────────────────────────────
  {
    type: "function",
    function: {
      name: "add_lesson",
      description: "Save a new lesson learned from a trade or observation.",
      parameters: {
        type: "object",
        properties: {
          rule: { type: "string", description: "The lesson/rule text." },
          tags: { type: "array", items: { type: "string" } },
          pinned: { type: "boolean", default: false },
          role: { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"], description: "Scope of the lesson." }
        },
        required: ["rule"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_lessons",
      description: "List saved lessons.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string" },
          pinned: { type: "boolean" },
          limit: { type: "number", default: 10 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_recent_decisions",
      description: "Get a log of recent screening and management decisions.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", default: 6 }
        }
      }
    }
  },

  // ─── Blacklist & Safety ──────────────────────────────────
  {
    type: "function",
    function: {
      name: "add_to_blacklist",
      description: "Add a token mint to the permanent blacklist.",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
          reason: { type: "string" }
        },
        required: ["mint"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "block_deployer",
      description: "Block a developer wallet address.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string" },
          reason: { type: "string" }
        },
        required: ["address"]
      }
    }
  },

  // ─── System ──────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "self_update",
      description: "Update the agent's code from git (only works in TTY).",
      parameters: { type: "object", properties: {} }
    }
  }
];
