/**
 * Vault profit sweep helpers.
 *
 * This module exposes the analysis-only sweep calculation surface; the actual
 * SOL transfer path stays in vault.js behind DRY_RUN/live execution gates.
 */

export {
  computeProfitSweepAmount,
  computeVaultAmount,
  getVaultSweepConfig,
  isVaultDue,
} from "./vault.js";
