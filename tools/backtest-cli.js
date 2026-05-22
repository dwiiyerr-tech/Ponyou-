#!/usr/bin/env node
/**
 * Backtest CLI — load price sequences from a JSON file and run the strategy
 * exit logic over them. Useful for sanity-checking a strategy change before
 * deploying live.
 *
 * Input file format:
 *   {
 *     "marketCondition": "NORMAL",
 *     "stopLossPctOverride": -15,
 *     "trades": [
 *       {
 *         "label": "BONK 2026-05-17",
 *         "priceSequence": [
 *           { "ts": 1715900000000, "price": 0.000012 },
 *           { "ts": 1715900060000, "price": 0.000013 },
 *           ...
 *         ]
 *       }
 *     ]
 *   }
 *
 * Output: summary stats to stdout + per-trade JSON to file if --out passed.
 *
 * Example:
 *   node tools/backtest-cli.js backtest-data/sample.json --out=results.json
 *   node tools/backtest-cli.js backtest-data/sample.json --condition=HOT
 */

import fs from "fs";
import { backtest } from "../backtest.js";
import { atomicWriteJson } from "../atomic-write.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 0) flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      else flags[tok.slice(2)] = true;
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function pct(n) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(2)}%`;
}

function pad(label, width = 22) {
  return (label + ":").padEnd(width);
}

function main() {
  const { positional, flags } = parseArgs(process.argv);
  if (positional.length < 1) {
    console.error("Usage: node tools/backtest-cli.js <input.json> [--condition=NORMAL] [--sl=-15] [--tp=25] [--out=results.json]");
    process.exit(1);
  }

  const inputPath = positional[0];
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (e) {
    console.error(`Failed to read ${inputPath}: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(input.trades) || input.trades.length === 0) {
    console.error("Input must contain a non-empty 'trades' array.");
    process.exit(1);
  }

  const opts = {
    trades: input.trades,
    marketCondition: flags.condition || input.marketCondition || "NORMAL",
    stopLossPctOverride: flags.sl != null ? Number(flags.sl) : input.stopLossPctOverride ?? null,
    takeProfitPctOverride: flags.tp != null ? Number(flags.tp) : input.takeProfitPctOverride ?? null,
  };

  const result = backtest(opts);

  console.log("");
  console.log("=".repeat(50));
  console.log("  Backtest Results");
  console.log("=".repeat(50));
  console.log(`${pad("Total trades")} ${result.total}`);
  console.log(`${pad("Wins / Losses")} ${result.wins} / ${result.losses}`);
  console.log(`${pad("Win rate")} ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`${pad("Total P&L")} ${pct(result.totalPnlPct)}`);
  console.log(`${pad("Avg win")} ${pct(result.avgWinPct)}`);
  console.log(`${pad("Avg loss")} ${pct(result.avgLossPct)}`);
  console.log(`${pad("Profit factor")} ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "∞"}`);
  console.log(`${pad("Max drawdown")} ${pct(result.maxDrawdownPct)}`);
  console.log("");
  console.log("  Per-trade outcomes:");
  console.log("-".repeat(50));
  for (let i = 0; i < result.trades.length; i++) {
    const t = result.trades[i];
    const label = input.trades[i].label || `Trade #${i + 1}`;
    const flag = t.isWin ? "✓" : "✗";
    console.log(`  ${flag} ${label.padEnd(25)} ${pct(t.pnlPct).padStart(8)}  hold ${t.holdMinutes.toFixed(1)}m`);
    console.log(`     → ${t.exitReason}`);
  }
  console.log("");

  if (flags.out) {
    atomicWriteJson(flags.out, result);
    console.log(`Per-trade JSON written to ${flags.out}`);
  }
}

main();
