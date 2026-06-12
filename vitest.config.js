import { defineConfig } from "vitest/config";
import os from "os";
import path from "path";

// NOTE on DEP0040: vitest spawns worker processes for each test file and
// many transitive deps still import `punycode`. We can't pass --disable-warning
// to those workers via vitest config. Workers inherit NODE_OPTIONS, so we
// set it in the test scripts in package.json (`NODE_OPTIONS=--disable-warning=DEP0040`).

// Production state files that tests would otherwise read/reset in place use
// env-overridable paths. Point them at a throwaway tmp dir during tests so the
// suite NEVER touches the live bot's state — previously a `npm test` run wiped
// collab stores AND could clear the master kill-switch flag / daily-guard
// state. `test.env` is injected into every worker's process.env before test
// modules load, so each module's `process.env.X || default` resolves to these
// tmp paths. The dir is created/removed by tests/_globals.js (globalSetup).
const STATE_TMP = path.join(os.tmpdir(), "ponyou-vitest-state");

export default defineConfig({
  test: {
    globalSetup: ["./tests/_globals.js"],
    exclude: ["node_modules/**", ".claude/**", ".claude-flow/**"],
    include: ["tests/**/*.test.{js,ts}", "tools/__tests__/**/*.test.{js,ts}"],
    env: {
      // collab layer
      PONYOU_ORCH_FILE: path.join(STATE_TMP, "orchestrator-state.json"),
      PONYOU_EXPERIMENTS_FILE: path.join(STATE_TMP, "experiments.json"),
      PONYOU_EXPERIMENT_RUNS_FILE: path.join(STATE_TMP, "experiment-runs.jsonl"),
      PONYOU_SEMANTIC_MEMORY_FILE: path.join(STATE_TMP, "semantic-memory.jsonl"),
      COLLAB_SHARED_MEMORY_PATH: path.join(STATE_TMP, "shared-agent-memory.jsonl"),
      // safety rails — must never be wiped by a test run
      PONYOU_KILL_SWITCH_FLAG: path.join(STATE_TMP, "kill-switch.flag"),
      PONYOU_KILL_SWITCH_STATE: path.join(STATE_TMP, "kill-switch-state.json"),
      PONYOU_DAILY_GUARD_STATE: path.join(STATE_TMP, "daily-trade-guard-state.json"),
      PONYOU_CAPITAL_GUARD_STATE: path.join(STATE_TMP, "capital-guard-state.json"),
      PONYOU_STREAK_SIZER_STATE: path.join(STATE_TMP, "streak-sizer-state.json"),
      // learning agent — per-source stats, strategy perf, open-trade
      // attribution (all written on bus events that tests emit freely; a
      // missing override here let a suite run write a fake pumpfun win into
      // the live hunter-performance.json on 2026-06-11)
      PONYOU_HUNTER_PERF_FILE: path.join(STATE_TMP, "hunter-performance.json"),
      PONYOU_STRATEGY_PERF_FILE: path.join(STATE_TMP, "strategy-performance.json"),
      PONYOU_OPEN_TRADES_FILE: path.join(STATE_TMP, "open-trades-learning.json"),
      // analytics / memory written by BOTH the live bot and tests
      PONYOU_METRICS_FILE: path.join(STATE_TMP, "metrics.json"),
      PONYOU_TRADE_ATTRIBUTION_FILE: path.join(STATE_TMP, "trade-attribution.json"),
      PONYOU_CONVICTION_FILE: path.join(STATE_TMP, "coin-conviction.json"),
      PONYOU_PROFIT_PATTERNS_FILE: path.join(STATE_TMP, "profit-patterns.json"),
      PONYOU_LOSS_PATTERNS_FILE: path.join(STATE_TMP, "loss-patterns.json"),
      // strategy-skill registry + its hash-pin lockfile (must not touch the
      // live registry / skills-lock.json during tests)
      PONYOU_STRATEGY_SKILLS_FILE: path.join(STATE_TMP, "strategy-skills.json"),
      PONYOU_SKILLS_LOCK_FILE: path.join(STATE_TMP, "skills-lock.json"),
      PONYOU_STRATEGY_SKILLS_LOCK_FILE: path.join(STATE_TMP, "strategy-skills-lock.json"),
      // per-skill P&L attribution written by the portfolio manager
      PONYOU_SKILL_ATTRIBUTION_FILE: path.join(STATE_TMP, "skill-attribution.json"),
      // Super Brain — episodic memory + prompt evolution (must not touch live files)
      PONYOU_EPISODIC_FILE: path.join(STATE_TMP, "episodic-memory.json"),
      PONYOU_PROMPT_EVOLUTION_FILE: path.join(STATE_TMP, "prompt-evolution.json"),
      // GMGN OpenAPI credential dir — never touch the real ~/.config/gmgn in tests
      PONYOU_GMGN_ENV_DIR: path.join(STATE_TMP, "gmgn"),
      // Pin GMGN OFF by default so the suite is deterministic regardless of the
      // operator's live key. config.js maps user-config.json's gmgnApiKey into
      // GMGN_API_KEY via `||=`; a truthy dummy here blocks that overwrite, and
      // isGmgnEnabled() rejects "dummy-gmgn-key" → baseline (GMGN-off) path.
      // Tests that exercise the enabled path (tests/gmgn.test.js) set their own
      // key explicitly and restore it in afterEach.
      GMGN_API_KEY: "dummy-gmgn-key",
      PONYOU_BACKTEST_DATA_DIR: STATE_TMP,
      PONYOU_LOG_DIR: path.join(STATE_TMP, "logs"),
      PONYOU_PLAN_FILE: path.join(STATE_TMP, "trading-plan.json"),
      PONYOU_STATE_FILE: path.join(STATE_TMP, "state.json"),
      PONYOU_REGIME_FILE: path.join(STATE_TMP, "regime-memory.json"),
      PONYOU_RUG_MEMORY_FILE: path.join(STATE_TMP, "rug-memory.json"),
      PONYOU_RUG_PATTERNS_FILE: path.join(STATE_TMP, "rug-patterns-learned.json"),
      PONYOU_PERF_FILE: path.join(STATE_TMP, "performance.json"),
      PONYOU_EXEC_QUALITY_FILE: path.join(STATE_TMP, "execution-quality.json"),
      // closed-trade archive counts as trade evidence in the pro-orchestrator
      // readiness gate — test fixtures must never append to the real one
      PONYOU_ARCHIVE_FILE: path.join(STATE_TMP, "closed-positions-archive.json"),
      // cast-net gate state — tests used to backup/restore the repo-root file,
      // racing the live bot
      PONYOU_CAST_NET_STATE_FILE: path.join(STATE_TMP, "cast-net-state.json"),
      PONYOU_LESSONS_FILE: path.join(STATE_TMP, "lessons.json"),
      PONYOU_DARWIN_FILE: path.join(STATE_TMP, "darwin-weights.json"),
      // structured error log — logger/state/shadow-watchlist tests log
      // fabricated errors ("not json {{{", "disk fail"); without this
      // override they land in the live error-log.jsonl that Doctor, the
      // dashboard, and the Telegram error forwarder all read (79% of the
      // live file was test residue on 2026-06-11)
      PONYOU_ERROR_LOG: path.join(STATE_TMP, "error-log.jsonl"),
      PONYOU_SMART_WALLETS_FILE: path.join(STATE_TMP, "smart-wallets.json"),
      PONYOU_AUTOMATION_STATE_FILE: path.join(STATE_TMP, "automation-state.json"),
      PONYOU_ACTIVE_STRATEGY_FILE: path.join(STATE_TMP, "active-strategy.json"),
      PONYOU_STRATEGY_OVERRIDES_FILE: path.join(STATE_TMP, "strategies-overrides.json"),
      // counterfactual evaluator reads these via env so tests feed fixtures
      PONYOU_OBSERVED_TOKENS_FILE: path.join(STATE_TMP, "observed-tokens.json"),
      PONYOU_SHADOW_WATCHLIST_FILE: path.join(STATE_TMP, "shadow-watchlist.json"),
    },
  },
});
