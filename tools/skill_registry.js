/** Central registry of PR-007 Direct RPC Trading tools. */

export const skillRegistry = Object.freeze({
  rpcFailover: {
    name: "rpcFailover",
    description: "RPC endpoint failover with latency-based selection and circuit breaker",
    module: "./rpcFailover.js",
  },
  priorityFeeManager: {
    name: "priorityFeeManager",
    description: "Dynamic Solana priority fee calculation using RPC fee percentiles",
    module: "./priorityFeeManager.js",
  },
  riskGuard: {
    name: "riskGuard",
    description: "Pre-trade risk validation: balance gate, trade size cap, slippage cap",
    module: "./risk_guard.js",
  },
  directRpcTrading: {
    name: "directRpcTrading",
    description: "Direct RPC trading orchestrator with simulation-first gate, dry-run default",
    module: "./directRpcTrading.js",
  },
});
