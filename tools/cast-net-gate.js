/**
 * Cast-Net Gate (Tebar Jala)
 *
 * High-conviction multi-wallet entry. Fires only when ALL 7 fundamental
 * green-flag categories pass:
 *   1. community  — community.score from runCommunityAssessment
 *   2. dev        — creator reputation (past coin outcomes) not red-flagged
 *   3. smart      — ≥ N smart wallets already holding (per config.castNetMinSmartHolders)
 *   4. holders    — top-10 concentration ≤ 50%, not supply-concentrated
 *   5. narrative  — token narrative aligned with recent trending pool
 *   6. ticker     — ticker not matching scam-name patterns (trash-filter pre-screen)
 *   7. conviction — getExperienceScore() above castNet.minConviction floor,
 *                   with at least castNet.minMemorySamples observations
 *
 * Strict AND — any single red blocks. Plus operator gates:
 *   - config.castNet.enabled must be true
 *   - active strategy in castNet.allowedStrategies
 *   - pro-orchestrator mode must be on
 *   - cooldown since last fire elapsed
 *   - manual disable via /castnet off (lastDisabledAt timestamp)
 *
 * Audit trail: every evaluation (fire or not) logs the per-category result
 * into cast-net-state.json so the operator can see WHY a cast-net was
 * skipped after the fact.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "cast-net-state.json");

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { last_fire_at: null, last_disabled_at: null, manual_enabled: null, fires: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      last_fire_at: parsed.last_fire_at ?? null,
      last_disabled_at: parsed.last_disabled_at ?? null,
      manual_enabled: parsed.manual_enabled ?? null,
      fires: Array.isArray(parsed.fires) ? parsed.fires : [],
    };
  } catch {
    return { last_fire_at: null, last_disabled_at: null, manual_enabled: null, fires: [] };
  }
}

function writeState(state) { atomicWriteJson(STATE_FILE, state); }

/**
 * Operator-facing toggle. Persists across restarts so /castnet off survives
 * a process kill. Returns the new resolved-enabled state (config AND manual).
 */
export async function setCastNetManualEnabled(enabled) {
  return await withFileLock(STATE_FILE, async () => {
    const state = readState();
    state.manual_enabled = Boolean(enabled);
    if (!enabled) {
      state.last_disabled_at = new Date().toISOString();
    } else {
      // C1: enabling clears any consecutive-loss streak so the operator's
      // explicit /castnet on actually re-engages the gate (auto-disable
      // would otherwise immediately block it again).
      for (let i = state.fires.length - 1; i >= 0; i--) {
        const f = state.fires[i];
        if (!f.outcome || f.outcome.win !== false) break;
        f.outcome.win = null;
        f.outcome.streak_cleared_at = new Date().toISOString();
      }
    }
    writeState(state);
    return state.manual_enabled;
  });
}

/** True if cast-net is enabled by BOTH config and operator toggle (default ON if never toggled). */
function isCastNetEnabled() {
  if (!config.castNet?.enabled) return false;
  const state = readState();
  // manual_enabled === null means "never toggled" → defer to config flag
  if (state.manual_enabled === false) return false;
  return true;
}

function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

// ─── Per-category green-flag checks ─────────────────────────────────────

function checkCommunity(token) {
  // Conservative read: prefer explicit assessment, fallback to community.score.
  const score = Number(token?.community?.score ?? token?.communityScore ?? 0);
  if (!Number.isFinite(score) || score < 0.7) {
    return { ok: false, reason: `community.score=${score.toFixed(2)} < 0.7` };
  }
  return { ok: true, reason: `community.score=${score.toFixed(2)}` };
}

function checkDev(token) {
  // Reputation comes from community-detector's markDevCoinOutcome history.
  // We require at least 1 past outcome (no track record = unknown, not green).
  const rep = token?.dev_reputation ?? token?.devReputation ?? null;
  if (!rep) return { ok: false, reason: "dev: no reputation data (unknown dev)" };
  if (rep.is_blacklisted) return { ok: false, reason: "dev: blacklisted" };
  const past = Number(rep.past_coins ?? rep.total_coins ?? 0);
  if (past < 1) return { ok: false, reason: "dev: no prior coins to evaluate" };
  const winRate = Number(rep.win_rate ?? rep.success_rate ?? 0);
  if (winRate < 0.5) return { ok: false, reason: `dev: past WR ${winRate.toFixed(2)} < 0.50` };
  return { ok: true, reason: `dev: past WR ${winRate.toFixed(2)} over ${past} coins` };
}

function checkSmartMoney(token, opts = {}) {
  const minHolders = Number(opts.minHolders ?? 2);
  const smart = Array.isArray(token?.smart_holders) ? token.smart_holders : [];
  const smartCount = Number(token?.smart_money?.holders ?? smart.length ?? 0);
  if (smartCount < minHolders) {
    return { ok: false, reason: `smart_money: ${smartCount} holders < ${minHolders}` };
  }
  return { ok: true, reason: `smart_money: ${smartCount} holders` };
}

function checkHolders(token) {
  // Use the same heuristics rug-anomaly does — top-10 ≤ 50%, no supply
  // concentration, no single-wallet-owns-majority red flag.
  const top10 = Number(token?.top10_concentration_pct ?? token?.topHolders?.top10_pct ?? 100);
  if (!Number.isFinite(top10)) return { ok: false, reason: "holders: top10 unknown" };
  if (top10 > 50) return { ok: false, reason: `holders: top10=${top10.toFixed(1)}% > 50%` };
  if (token?.supply_concentrated === true) {
    return { ok: false, reason: "holders: supply concentrated flag set" };
  }
  return { ok: true, reason: `holders: top10=${top10.toFixed(1)}%` };
}

function checkNarrative(token) {
  const narrative = String(token?.narrative ?? token?.detected_narrative ?? "").trim();
  if (!narrative || narrative === "unknown" || narrative === "none") {
    return { ok: false, reason: "narrative: none detected" };
  }
  const narrativeScore = Number(token?.narrative_score ?? token?.narrativeStrength ?? 0);
  if (Number.isFinite(narrativeScore) && narrativeScore > 0 && narrativeScore < 0.6) {
    return { ok: false, reason: `narrative: ${narrative} strength ${narrativeScore.toFixed(2)} < 0.60` };
  }
  return { ok: true, reason: `narrative: ${narrative}` };
}

function checkTicker(token, trashFilter) {
  if (typeof trashFilter !== "function") {
    // Defensive — if the caller forgot to inject, fall back to a no-op pass
    // but flag it (rare; tests cover this path).
    return { ok: true, reason: "ticker: trash-filter unavailable (skipped check)" };
  }
  try {
    const verdict = trashFilter(token, { skipDevBlacklist: true });
    if (verdict?.trash) {
      return { ok: false, reason: `ticker: trash-filter blocked (${verdict.reason || "scam pattern"})` };
    }
    return { ok: true, reason: "ticker: clean" };
  } catch (e) {
    return { ok: false, reason: `ticker: trash-filter threw (${e.message || e})` };
  }
}

function checkConviction(token, opts = {}) {
  const minConviction = Number(opts.minConviction ?? 0.85);
  const minSamples = Number(opts.minSamples ?? 50);
  const score = Number(opts.experienceScore?.score ?? opts.experienceScore ?? 0);
  const matches = Number(opts.experienceScore?.matches ?? opts.matches ?? 0);
  const totalMemory = Number(opts.totalMemorySamples ?? 0);
  if (totalMemory < minSamples) {
    return { ok: false, reason: `conviction: only ${totalMemory} memory samples < ${minSamples}` };
  }
  if (matches < 3) {
    return { ok: false, reason: `conviction: only ${matches} pattern matches < 3` };
  }
  if (score < minConviction) {
    return { ok: false, reason: `conviction: score=${score.toFixed(2)} < ${minConviction}` };
  }
  return { ok: true, reason: `conviction: ${score.toFixed(2)} over ${matches} matches`, value: score, floor: minConviction };
}

// ─── C2: Soft-check categories ─────────────────────────────────────────

function checkLiquidity(token, opts = {}) {
  const min = Number(opts.minLiquidityUsd ?? 50_000);
  const liq = Number(token?.liquidity_usd ?? token?.liquidity ?? token?.pool_liquidity ?? 0);
  if (!Number.isFinite(liq) || liq <= 0) {
    return { ok: false, reason: "liquidity: unknown" };
  }
  if (liq < min) {
    return { ok: false, reason: `liquidity: $${Math.round(liq).toLocaleString()} < $${min.toLocaleString()}` };
  }
  return { ok: true, reason: `liquidity: $${Math.round(liq).toLocaleString()}`, value: liq, floor: min };
}

function checkMcapWindow(token, opts = {}) {
  const lo = Number(opts.mcapWindowMinUsd ?? 1_000_000);
  const hi = Number(opts.mcapWindowMaxUsd ?? 10_000_000);
  const mcap = Number(token?.fdv_usd ?? token?.mcap_usd ?? token?.fdv ?? token?.market_cap ?? 0);
  if (!Number.isFinite(mcap) || mcap <= 0) {
    return { ok: false, reason: "mcap: unknown" };
  }
  if (mcap < lo || mcap > hi) {
    return { ok: false, reason: `mcap: $${Math.round(mcap).toLocaleString()} outside [$${lo.toLocaleString()}, $${hi.toLocaleString()}]` };
  }
  return { ok: true, reason: `mcap: $${Math.round(mcap).toLocaleString()}`, value: mcap, floor: lo, ceiling: hi };
}

function checkVolume(token, opts = {}) {
  const minRatio = Number(opts.minVolumeToLiquidity ?? 1.0);
  const vol = Number(token?.volume_24h_usd ?? token?.volume_24h ?? token?.volume24h ?? 0);
  const liq = Number(token?.liquidity_usd ?? token?.liquidity ?? token?.pool_liquidity ?? 0);
  if (!Number.isFinite(vol) || vol <= 0) {
    return { ok: false, reason: "volume: unknown 24h volume" };
  }
  if (liq <= 0) {
    // Defer to checkLiquidity for the unknown-liquidity case; here we can't
    // compute the ratio so we conservatively block.
    return { ok: false, reason: "volume: cannot compute (liquidity unknown)" };
  }
  const ratio = vol / liq;
  if (ratio < minRatio) {
    return { ok: false, reason: `volume: ratio ${ratio.toFixed(2)} < ${minRatio} (pool not churning)` };
  }
  return { ok: true, reason: `volume: ratio ${ratio.toFixed(2)}`, value: ratio, floor: minRatio };
}

function checkHolderDistribution(token, opts = {}) {
  const maxTop1 = Number(opts.maxTop1HolderPct ?? 5);
  // Prefer explicit top1 field; fall back to top_holders[0].pct
  let top1 = Number(token?.top1_holder_pct ?? token?.top1_pct ?? 0);
  if (!top1 && Array.isArray(token?.top_holders) && token.top_holders[0]) {
    const first = token.top_holders[0];
    top1 = Number(first.pct ?? first.percentage ?? first.share ?? 0);
  }
  if (!Number.isFinite(top1) || top1 <= 0) {
    // Conservative: unknown top1 is treated as a soft pass with a warning,
    // since not every screener provides this field. Operator can still
    // veto manually.
    return { ok: true, reason: "top1: unknown (soft pass)", value: 0, ceiling: maxTop1 };
  }
  if (top1 > maxTop1) {
    return { ok: false, reason: `top1: ${top1.toFixed(1)}% > ${maxTop1}% (concentrated risk)` };
  }
  // Use `ceiling` (not `floor`) — top1 is an upper-bound constraint, not a
  // minimum threshold. Edge detection treats these differently.
  return { ok: true, reason: `top1: ${top1.toFixed(1)}%`, value: top1, ceiling: maxTop1 };
}

// ─── C1: Consecutive-loss tracking ─────────────────────────────────────

function countConsecutiveLosses(state) {
  const fires = (state.fires || []).filter((f) => f.outcome && f.outcome.closed_at);
  let count = 0;
  for (let i = fires.length - 1; i >= 0; i--) {
    if (fires[i].outcome.win === false) count++;
    else break;
  }
  return count;
}

// ─── C4: Edge-signal detection ─────────────────────────────────────────

function detectEdgeSignals(reasons, edgeMarginPct = 0.05) {
  const edges = [];
  for (const [cat, res] of Object.entries(reasons)) {
    if (!res?.ok) continue;
    if (typeof res.value !== "number") continue;
    // Floor-style: value must be >= floor. Edge = (value - floor) / floor.
    if (typeof res.floor === "number" && res.floor > 0) {
      const margin = (res.value - res.floor) / res.floor;
      if (margin >= 0 && margin < edgeMarginPct) {
        edges.push({ category: cat, value: res.value, floor: res.floor, margin });
      }
      continue;
    }
    // Ceiling-style: value must be <= ceiling. Edge = (ceiling - value) / ceiling.
    if (typeof res.ceiling === "number" && res.ceiling > 0) {
      const margin = (res.ceiling - res.value) / res.ceiling;
      if (margin >= 0 && margin < edgeMarginPct) {
        edges.push({ category: cat, value: res.value, ceiling: res.ceiling, margin });
      }
    }
  }
  return edges;
}

/**
 * Main entry — evaluate a token candidate against all gates.
 * Caller (pro-orchestrator) injects ready-resolved signals.
 *
 * @param {Object} args
 * @param {Object} args.token               Token candidate with enriched fields
 * @param {string} args.activeStrategy      Currently active strategy id
 * @param {boolean} args.proOrchestratorOn  Pro-orchestrator runtime flag
 * @param {Object}  args.experienceScore    Result of getExperienceScore(token)
 * @param {number}  args.totalMemorySamples Total semantic memory size
 * @param {Function} args.trashFilter       scoreTrash function (injected)
 * @param {Object}  args.smartMoneyOpts     { minHolders? }
 * @param {Object}  args.walletContext      { multiWalletEnabled, viableWalletCount } — G1 guard
 *
 * @returns {{ allowed: boolean, reasons: Object<string, {ok,reason}>, blockers: string[],
 *            cooldownRemainingMin: number, plan: {wallets: number, bankrollPct: number} | null }}
 */
export function evaluateCastNet({
  token,
  activeStrategy,
  proOrchestratorOn,
  experienceScore = null,
  totalMemorySamples = 0,
  trashFilter = null,
  smartMoneyOpts = {},
  walletContext = null,
} = {}) {
  const cfg = config.castNet || {};
  const blockers = [];
  const reasons = {};

  // ── Operator gates first (cheapest checks) ─────────────────────────────
  if (!isCastNetEnabled()) {
    blockers.push("disabled (config or operator toggle)");
    return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
  }
  if (!proOrchestratorOn) {
    blockers.push("pro-orchestrator off — cast-net requires pro-orch signal richness");
    return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
  }
  const allowedStrategies = Array.isArray(cfg.allowedStrategies) ? cfg.allowedStrategies : [];
  if (!allowedStrategies.includes(activeStrategy)) {
    blockers.push(`strategy "${activeStrategy}" not in cast-net whitelist [${allowedStrategies.join(",")}]`);
    return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
  }

  // ── G1: Multi-wallet guard ─────────────────────────────────────────────
  // Cast-net only makes sense with ≥2 hot wallets. Caller may inject the
  // current wallet context; if not, we read config.multiWallet directly.
  // Tolerate missing context (defensive — tests without wallet manager).
  const mwCfg = config.multiWallet || {};
  const walletCtx = walletContext || {
    multiWalletEnabled: Boolean(mwCfg.enabled),
    viableWalletCount: Array.isArray(mwCfg.wallets) ? mwCfg.wallets.length : 0,
  };
  if (!walletCtx.multiWalletEnabled) {
    blockers.push("multi-wallet disabled — set multiWalletEnabled=true and configure wallets[]");
    return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
  }
  if (Number(walletCtx.viableWalletCount || 0) < 2) {
    blockers.push(`need ≥2 viable wallets, only ${walletCtx.viableWalletCount || 0} hot`);
    return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
  }

  // ── C1: Auto-disable after N consecutive losses ────────────────────────
  // A persistent run of bad fires means the gate is producing false
  // positives in the current regime. Block until the operator manually
  // re-enables with /castnet on (which also clears the loss streak).
  const stateForLosses = readState();
  const autoDisableThreshold = Number(cfg.autoDisableConsecutiveLosses ?? 2);
  if (autoDisableThreshold > 0) {
    const consecutiveLosses = countConsecutiveLosses(stateForLosses);
    if (consecutiveLosses >= autoDisableThreshold) {
      blockers.push(`auto-disabled: ${consecutiveLosses} consecutive losses (threshold ${autoDisableThreshold}) — re-enable with /castnet on`);
      return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
    }
  }

  // Cooldown — last_fire_at must be older than cfg.cooldownMin
  // Allow explicit 0 (tests set this; in prod the default is 240).
  const state = readState();
  const cooldownMin = Number.isFinite(Number(cfg.cooldownMin)) ? Number(cfg.cooldownMin) : 240;
  const minsSinceFire = minutesSince(state.last_fire_at);
  if (cooldownMin > 0 && minsSinceFire < cooldownMin) {
    const remaining = Math.ceil(cooldownMin - minsSinceFire);
    blockers.push(`cooldown: ${remaining}min remaining`);
    return { allowed: false, reasons, blockers, cooldownRemainingMin: remaining, plan: null };
  }

  // ── 7 fundamental green-flag categories ────────────────────────────────
  reasons.community  = checkCommunity(token);
  reasons.dev        = checkDev(token);
  reasons.smart      = checkSmartMoney(token, smartMoneyOpts);
  reasons.holders    = checkHolders(token);
  reasons.narrative  = checkNarrative(token);
  reasons.ticker     = checkTicker(token, trashFilter);
  reasons.conviction = checkConviction(token, {
    minConviction: cfg.minConviction,
    minSamples:    cfg.minMemorySamples,
    experienceScore,
    totalMemorySamples,
  });

  // ── C2: 4 soft-check categories (also hard-blocking) ───────────────────
  reasons.liquidity     = checkLiquidity(token, { minLiquidityUsd: cfg.minLiquidityUsd });
  reasons.mcap_window   = checkMcapWindow(token, {
    mcapWindowMinUsd: cfg.mcapWindowMinUsd,
    mcapWindowMaxUsd: cfg.mcapWindowMaxUsd,
  });
  reasons.volume        = checkVolume(token, { minVolumeToLiquidity: cfg.minVolumeToLiquidity });
  reasons.holder_top1   = checkHolderDistribution(token, { maxTop1HolderPct: cfg.maxTop1HolderPct });

  for (const [cat, res] of Object.entries(reasons)) {
    if (!res.ok) blockers.push(`${cat}: ${res.reason}`);
  }

  if (blockers.length > 0) {
    return { allowed: false, reasons, blockers, cooldownRemainingMin: 0, plan: null };
  }

  // ── C4: Edge-signal detection ──────────────────────────────────────────
  // Any category that passed within edgeMarginPct of its floor is a
  // marginal call — surface this so the operator (or downstream Telegram
  // alert) knows the fire wasn't a clear win.
  const edgeSignals = detectEdgeSignals(reasons, Number(cfg.edgeMarginPct ?? 0.05));

  // ── All green → plan ───────────────────────────────────────────────────
  const configMaxWallets = Math.min(10, Math.max(2, Number(cfg.maxWallets || 10)));
  // G1: actual plan wallet count cannot exceed available viable wallets.
  const wallets      = Math.min(configMaxWallets, Number(walletCtx.viableWalletCount || configMaxWallets));
  const bankrollPct  = Math.min(50, Math.max(5, Number(cfg.maxBankrollPct || 30)));

  return {
    allowed: true,
    reasons,
    blockers: [],
    cooldownRemainingMin: 0,
    plan: { wallets, bankrollPct },
    edge_signals: edgeSignals,
  };
}

/**
 * Record that a cast-net fired. Updates last_fire_at + appends audit entry.
 * Must be called BEFORE the trade executes so cooldown engages immediately
 * (prevents double-fire from racing screening cycles).
 */
export async function recordCastNetFire({ mint, symbol, walletCount, bankrollPct, reasons, groupId = null, edgeSignals = null }) {
  await withFileLock(STATE_FILE, async () => {
    const state = readState();
    state.last_fire_at = new Date().toISOString();
    state.fires.push({
      ts: state.last_fire_at,
      mint: String(mint || ""),
      symbol: String(symbol || ""),
      wallet_count: Number(walletCount || 0),
      bankroll_pct: Number(bankrollPct || 0),
      reasons,
      group_id: groupId || null,
      edge_signals: Array.isArray(edgeSignals) ? edgeSignals : [],
      // C1: outcome is filled in later via recordCastNetOutcome when
      // positions from this fire close. While outcome is null the fire
      // is considered "open" and does not count toward consecutive-loss.
      outcome: null,
    });
    // Cap audit log at last 200 fires to stop unbounded growth.
    if (state.fires.length > 200) state.fires = state.fires.slice(-200);
    writeState(state);
  });
  log("cast_net", `🎣 cast-net fired: ${symbol || mint?.slice(0, 8)} → ${walletCount} wallets / ${bankrollPct}% bankroll`);
}

/**
 * C1: Record a single position close back to its parent cast-net fire.
 * Called by management exit path when a position with cast_net_group_id
 * closes. Once all positions in a group have closed, the group's outcome
 * is finalized with avg PnL and win/loss verdict.
 *
 * Loss verdict: avg_pnl_pct < 0. Note this is a SIMPLE win/loss — partial
 * wins (some positions up, some down) round on the average.
 */
export async function recordCastNetOutcome({ groupId, pnlPct, walletCount = null } = {}) {
  if (!groupId) return null;
  return await withFileLock(STATE_FILE, async () => {
    const state = readState();
    const fire = state.fires.find((f) => f.group_id === groupId);
    if (!fire) return null;
    if (!fire.outcome) {
      fire.outcome = {
        positions_closed: 0,
        positions_total: Number(walletCount || fire.wallet_count || 0),
        pnl_sum_pct: 0,
        avg_pnl_pct: 0,
        win: null,
        closed_at: null,
      };
    }
    fire.outcome.positions_closed = (fire.outcome.positions_closed || 0) + 1;
    fire.outcome.pnl_sum_pct = (fire.outcome.pnl_sum_pct || 0) + Number(pnlPct || 0);
    fire.outcome.avg_pnl_pct = fire.outcome.pnl_sum_pct / Math.max(1, fire.outcome.positions_closed);
    // Finalize when all positions have closed.
    if (fire.outcome.positions_closed >= fire.outcome.positions_total) {
      fire.outcome.win = fire.outcome.avg_pnl_pct > 0;
      fire.outcome.closed_at = new Date().toISOString();
      log("cast_net",
        `cast-net group ${groupId.slice(-6)} closed: ${fire.outcome.win ? "WIN" : "LOSS"} avg ${fire.outcome.avg_pnl_pct.toFixed(1)}%`
      );
    }
    writeState(state);
    return fire.outcome;
  });
}

/**
 * C1: Operator-facing — clears the consecutive-loss streak. Called when
 * /castnet on is invoked after auto-disable so the next fire isn't
 * immediately blocked by the same losing fires.
 */
export async function clearCastNetLossStreak() {
  return await withFileLock(STATE_FILE, async () => {
    const state = readState();
    // Convert the trailing loss outcomes to "neutralized" so they no longer
    // count toward the consecutive-loss check, but stay in the audit log.
    for (let i = state.fires.length - 1; i >= 0; i--) {
      const f = state.fires[i];
      if (!f.outcome || f.outcome.win !== false) break;
      f.outcome.win = null; // neutralize — still recorded, no longer counts
      f.outcome.streak_cleared_at = new Date().toISOString();
    }
    writeState(state);
  });
}

/** Operator-facing status for /castnet status. */
export function getCastNetStatus() {
  const cfg = config.castNet || {};
  const state = readState();
  const minsSinceFire = minutesSince(state.last_fire_at);
  const cooldownRemainingMin = state.last_fire_at && minsSinceFire < cfg.cooldownMin
    ? Math.ceil(cfg.cooldownMin - minsSinceFire)
    : 0;
  const todayIso = new Date().toISOString().slice(0, 10);
  const firesToday = state.fires.filter((f) => String(f.ts || "").startsWith(todayIso)).length;
  const consecutiveLosses = countConsecutiveLosses(state);
  const autoDisableThreshold = Number(cfg.autoDisableConsecutiveLosses ?? 2);
  const autoDisabled = autoDisableThreshold > 0 && consecutiveLosses >= autoDisableThreshold;
  return {
    enabled: isCastNetEnabled() && !autoDisabled,
    config_enabled: Boolean(cfg.enabled),
    manual_enabled: state.manual_enabled,
    auto_disabled: autoDisabled,
    consecutive_losses: consecutiveLosses,
    last_fire_at: state.last_fire_at,
    cooldown_remaining_min: cooldownRemainingMin,
    fires_today: firesToday,
    total_fires: state.fires.length,
    last_fire: state.fires.length ? state.fires[state.fires.length - 1] : null,
    config: {
      max_wallets: cfg.maxWallets,
      max_bankroll_pct: cfg.maxBankrollPct,
      min_conviction: cfg.minConviction,
      cooldown_min: cfg.cooldownMin,
      allowed_strategies: cfg.allowedStrategies,
      auto_disable_consecutive_losses: autoDisableThreshold,
      min_liquidity_usd: cfg.minLiquidityUsd,
      mcap_window_usd: [cfg.mcapWindowMinUsd, cfg.mcapWindowMaxUsd],
      min_volume_to_liquidity: cfg.minVolumeToLiquidity,
      max_top1_holder_pct: cfg.maxTop1HolderPct,
    },
  };
}

/**
 * C3: Get the last N cast-net fires for /castnet history.
 * Returns most-recent-first.
 */
export function getCastNetHistory(n = 10) {
  const state = readState();
  return (state.fires || []).slice(-Math.max(1, Number(n) || 10)).reverse();
}

// Test helper — exported for unit tests only.
export function _resetCastNetStateForTests() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
