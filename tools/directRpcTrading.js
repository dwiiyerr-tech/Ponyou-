/**
 * Direct RPC trading orchestrator.
 * Simulation-first gate: never executes if simulation fails.
 * Dry-run by default — live trading requires explicit opt-in.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createRpcFailover } from "./rpcFailover.js";
import { createPriorityFeeManager, PriorityFeeMode } from "./priorityFeeManager.js";
import { createRiskGuard } from "./risk_guard.js";

const RUST_CLI_REL = "rust/direct-rpc-engine/target/release/direct-rpc-engine";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUST_CLI_PATH = path.resolve(__dirname, "..", RUST_CLI_REL);

function spawnJson(bin, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errChunks = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => errChunks.push(d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      try {
        const out = Buffer.concat(chunks).toString("utf8").trim();
        resolve({ code, result: out ? JSON.parse(out) : null, stderr: Buffer.concat(errChunks).toString() });
      } catch (e) {
        reject(new Error(`Rust CLI JSON parse failed: ${e.message}`));
      }
    });
  });
}

export class DirectRpcTrading {
  /**
   * @param {{
   *   rpcEndpoints: string[],
   *   feeMode?: string,
   *   dryRun?: boolean,
   *   liveTradingEnabled?: boolean,
   *   riskConfig?: object
   * }} opts
   */
  constructor({
    rpcEndpoints,
    feeMode = PriorityFeeMode.AUTO,
    dryRun = true,
    liveTradingEnabled = false,
    riskConfig = {},
  }) {
    this._failover = createRpcFailover(rpcEndpoints);
    this._feeMode = feeMode;
    this._dryRun = dryRun;
    // Safety: liveTradingEnabled=false means never execute, regardless of dryRun
    this._liveEnabled = Boolean(liveTradingEnabled);
    this._risk = createRiskGuard(riskConfig);
  }

  get dryRun() { return this._dryRun; }
  get liveEnabled() { return this._liveEnabled; }

  /**
   * Attempt a trade: risk check → get fee → simulate → execute (if conditions met).
   * @returns {{ success: boolean, dryRun: boolean, simResult: object|null, txid: string|null, reason: string|null }}
   */
  async trade({ mint, direction, amountSOL, slippageBps, balanceSOL }) {
    const base = { success: false, dryRun: this._dryRun, simResult: null, txid: null, reason: null };

    // 1. Risk guard
    const risk = this._risk.check({ balanceSOL, tradeSizeSOL: amountSOL, slippageBps });
    if (!risk.ok) return { ...base, reason: `risk_guard: ${risk.reason}` };

    // 2. Pick RPC endpoint
    let endpoint;
    try {
      endpoint = this._failover.getEndpoint();
    } catch (e) {
      return { ...base, reason: `rpc_failover: ${e.message}` };
    }

    // 3. Get priority fee
    const feeMgr = createPriorityFeeManager({ rpcUrl: endpoint.url });
    let priorityFee;
    try {
      priorityFee = await feeMgr.getFee(this._feeMode);
    } catch {
      priorityFee = 5_000; // fallback medium
    }

    // 4. Simulate via Rust CLI
    let simResult = null;
    try {
      const { code, result, stderr } = await spawnJson(RUST_CLI_PATH, [
        "simulate",
        "--mint", mint,
        "--direction", direction,
        "--amount-sol", String(amountSOL),
        "--slippage-bps", String(slippageBps),
        "--priority-fee", String(priorityFee),
        "--rpc", endpoint.url,
      ]);
      if (code !== 0) return { ...base, reason: `rust_cli_simulate_exit_${code}: ${stderr}` };
      simResult = result;
    } catch (e) {
      if (e.code === "ENOENT") return { ...base, reason: "rust_cli_not_built" };
      return { ...base, reason: `rust_cli_error: ${e.message}` };
    }

    // 5. Validate simulation result
    if (simResult?.err) {
      return { ...base, simResult, reason: `simulation_failed: ${JSON.stringify(simResult.err)}` };
    }
    const simLogs = simResult?.logs ?? [];
    if (simLogs.some((l) => /slippage/i.test(l))) {
      return { ...base, simResult, reason: "simulation_failed: slippage exceeded in logs" };
    }

    // 6. Dry-run or live gate
    if (this._dryRun || !this._liveEnabled) {
      return {
        success: true,
        dryRun: true,
        simResult,
        txid: null,
        reason: null,
        dryRunInfo: { mint, direction, amountSOL, slippageBps, priorityFee, rpc: endpoint.url },
      };
    }

    // 7. Execute (only if dryRun=false AND liveTradingEnabled=true)
    const { code, result: execResult, stderr } = await spawnJson(RUST_CLI_PATH, [
      "execute",
      "--mint", mint,
      "--direction", direction,
      "--amount-sol", String(amountSOL),
      "--slippage-bps", String(slippageBps),
      "--priority-fee", String(priorityFee),
      "--rpc", endpoint.url,
    ], {
      // Private key injected via env, never as CLI arg
      WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY ?? "",
    });

    if (code !== 0) return { ...base, simResult, reason: `execute_exit_${code}: ${stderr}` };
    return { success: true, dryRun: false, simResult, txid: execResult?.txid ?? null, reason: null };
  }
}

export function createDirectRpcTrading(config) {
  return new DirectRpcTrading(config);
}
