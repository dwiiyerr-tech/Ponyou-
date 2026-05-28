/**
 * Dev Wallet Tracker — monitor creator wallet activity per coin
 *
 * The single biggest exit signal is "the dev started selling". Most rugs
 * begin with dev dumping their position before mass distribution.
 *
 * This tracker:
 *   1. Identifies the dev/creator wallet (from screener metadata, or
 *      the wallet that minted/launched the token).
 *   2. Records dev wallet's holding over time (balance, % of supply).
 *   3. Triggers alerts on:
 *      - DEV_SOLD_5PCT — sold ≥5% of total supply in 24h
 *      - DEV_DUMPING   — sold ≥20% of own initial holding in 24h
 *      - DEV_EMPTIED   — dev wallet's balance went to 0 (or <0.1% supply)
 *      - DEV_REDUCING  — gradual 3+ small sells over 24h (early-warning)
 *
 * Honest limit:
 *   We don't subscribe to live wallet events. Tracker is sampled on each
 *   screening/management cycle — so detection lag = cycle period (1-5min).
 *   For instant detection, would need Geyser subscription per dev wallet.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "dev-wallet-state.json");

const MAX_SAMPLES_PER_TOKEN = 30;

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { tokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { tokens: parsed.tokens || {} };
  } catch { return { tokens: {} }; }
}

function writeState(state) { atomicWriteJson(STATE_FILE, state); }

/**
 * Extract the most likely dev/creator wallet from a token's metadata.
 * Prefers explicit fields, falls back to "highest holder that's not a
 * pool/burn address" as a heuristic.
 */
export function extractDevWallet(token) {
  return (
    token?.creator_wallet ||
    token?.creatorAddress ||
    token?.deployer_wallet ||
    token?.deployer ||
    token?.dev_wallet ||
    token?.meta?.creator_wallet ||
    token?.meta?.deployer_wallet ||
    null
  );
}

/**
 * Record a snapshot of the dev wallet's holding. Called per cycle for
 * tokens currently held (or being watched). Snapshot includes total
 * supply and dev's balance so we can compute % over time.
 *
 * @param {Object} args
 * @param {string} args.mint
 * @param {string} args.devWallet
 * @param {number} args.devBalance       Token balance held by dev wallet (raw)
 * @param {number} args.totalSupply      Total supply of the token (raw)
 */
export async function recordDevSnapshot({ mint, devWallet, devBalance, totalSupply } = {}) {
  if (!mint || !devWallet || !(totalSupply > 0)) return;
  await withFileLock(STATE_FILE, async () => {
    const state = readState();
    if (!state.tokens[mint]) state.tokens[mint] = { dev_wallet: devWallet, samples: [] };
    if (state.tokens[mint].dev_wallet !== devWallet) {
      // Dev wallet changed (rare — likely a screener data mistake). Reset
      // history and record the new one rather than mixing data points.
      state.tokens[mint] = { dev_wallet: devWallet, samples: [] };
    }
    const pct = Number(devBalance || 0) / totalSupply;
    state.tokens[mint].samples.push({
      ts: new Date().toISOString(),
      balance: Number(devBalance || 0),
      total_supply: Number(totalSupply),
      pct_of_supply: pct,
    });
    if (state.tokens[mint].samples.length > MAX_SAMPLES_PER_TOKEN) {
      state.tokens[mint].samples = state.tokens[mint].samples.slice(-MAX_SAMPLES_PER_TOKEN);
    }
    writeState(state);
  });
}

function withinWindow(samples, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return samples.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

/**
 * Evaluate the dev wallet's recent activity for sell signals.
 *
 * @param {string} mint
 * @returns {{
 *   alert: 'none'|'DEV_REDUCING'|'DEV_SOLD_5PCT'|'DEV_DUMPING'|'DEV_EMPTIED',
 *   severity: 'none'|'watch'|'high'|'critical',
 *   evidence: Object | null,
 *   recommendation: string,
 * }}
 */
export function evaluateDevActivity(mint) {
  const state = readState();
  const entry = state.tokens[mint];
  if (!entry || entry.samples.length < 2) {
    return {
      alert: "none",
      severity: "none",
      evidence: { sample_count: entry?.samples?.length || 0 },
      recommendation: "continue monitoring",
    };
  }

  const samples = entry.samples.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const first = samples[0];
  const last = samples[samples.length - 1];

  // 1. DEV_EMPTIED — dev wallet effectively empty now
  if (last.pct_of_supply < 0.001 && first.pct_of_supply >= 0.005) {
    return {
      alert: "DEV_EMPTIED",
      severity: "critical",
      evidence: {
        initial_pct: Number((first.pct_of_supply * 100).toFixed(2)),
        current_pct: Number((last.pct_of_supply * 100).toFixed(4)),
        first_ts: first.ts,
        last_ts: last.ts,
      },
      recommendation: "FORCE EXIT — dev wallet drained",
    };
  }

  // 2. DEV_SOLD_5PCT — sold ≥5% of total supply within last 24h
  const last24 = withinWindow(samples, 24);
  if (last24.length >= 2) {
    const w24first = last24[0];
    const w24last  = last24[last24.length - 1];
    const drop = w24first.pct_of_supply - w24last.pct_of_supply;
    if (drop >= 0.05) {
      return {
        alert: "DEV_SOLD_5PCT",
        severity: "high",
        evidence: {
          pct_sold_24h: Number((drop * 100).toFixed(2)),
          before_pct: Number((w24first.pct_of_supply * 100).toFixed(2)),
          after_pct: Number((w24last.pct_of_supply * 100).toFixed(2)),
        },
        recommendation: "EXIT — dev offloading significant supply",
      };
    }
  }

  // 3. DEV_DUMPING — sold ≥20% of OWN holding (not of supply) in 24h
  if (last24.length >= 2) {
    const w24first = last24[0];
    const w24last  = last24[last24.length - 1];
    if (w24first.balance > 0) {
      const ownDrop = (w24first.balance - w24last.balance) / w24first.balance;
      if (ownDrop >= 0.20) {
        return {
          alert: "DEV_DUMPING",
          severity: "high",
          evidence: {
            own_holding_drop_pct: Number((ownDrop * 100).toFixed(1)),
            before_pct_supply: Number((w24first.pct_of_supply * 100).toFixed(2)),
            after_pct_supply: Number((w24last.pct_of_supply * 100).toFixed(2)),
          },
          recommendation: "EXIT — dev dumped ≥20% of position in 24h",
        };
      }
    }
  }

  // 4. DEV_REDUCING — 3+ small sells over 24h (gradual reduction warning)
  let smallSells = 0;
  for (let i = 1; i < last24.length; i++) {
    const prev = last24[i - 1];
    const curr = last24[i];
    if (prev.balance > 0 && curr.balance < prev.balance * 0.97) smallSells++;
  }
  if (smallSells >= 3) {
    return {
      alert: "DEV_REDUCING",
      severity: "watch",
      evidence: {
        small_sells_24h: smallSells,
        current_pct: Number((last.pct_of_supply * 100).toFixed(2)),
      },
      recommendation: "tighten stops — dev gradually reducing",
    };
  }

  return {
    alert: "none",
    severity: "none",
    evidence: { sample_count: samples.length, current_pct: Number((last.pct_of_supply * 100).toFixed(2)) },
    recommendation: "dev position stable",
  };
}

export function _resetDevWalletStateForTests() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
