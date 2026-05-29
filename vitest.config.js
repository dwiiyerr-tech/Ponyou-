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
    },
  },
});
