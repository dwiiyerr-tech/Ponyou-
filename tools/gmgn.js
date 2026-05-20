/**
 * GMGN compatibility shim.
 *
 * The runtime no longer depends on GMGN endpoints:
 *   - tools/jupiter.js      handles swap execution
 *   - tools/dexscreener.js  handles token discovery, security, candles
 *   - tools/solana-rpc.js   handles Solana network fee checks
 *
 * Keep this file temporarily so older imports and prompts continue to work
 * while the rest of the codebase migrates to provider-neutral names.
 */

export {
  discoverTokens,
  getTokenSecurityDetails,
  getTokenKlines,
  getTokenMarketInfo,
  getTrendingNarratives,
  getSmartMoneyRank,
  getSmartMoneyInflow,
} from "./dexscreener.js";

export { swapToken } from "./jupiter.js";
export { getSolanaGasFee } from "./solana-rpc.js";
