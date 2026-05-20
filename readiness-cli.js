#!/usr/bin/env node

import "dotenv/config";
import { resolveExecutionMode } from "./runtime-mode.js";
import { initWalletManager, getActiveWallet } from "./tools/wallet-manager.js";
import { getOperationalReadiness, formatReadinessReport } from "./readiness.js";

const argv = process.argv.slice(2);
const modeFlagIndex = argv.findIndex((arg) => arg === "--mode");
const forcedMode = modeFlagIndex >= 0 ? argv[modeFlagIndex + 1] : null;

initWalletManager();

const executionMode = forcedMode
  ? { mode: String(forcedMode).toLowerCase() === "live" ? "live" : "demo" }
  : resolveExecutionMode();
const readiness = getOperationalReadiness({
  env: forcedMode
    ? { ...process.env, EXECUTION_MODE: executionMode.mode }
    : process.env,
  executionMode,
  runtime: {
    hasActiveWallet: !!getActiveWallet(),
  },
});

console.log(formatReadinessReport(readiness));
process.exit(readiness.ok ? 0 : 1);
