import { Router } from "express";
import { readBotState } from "../state-reader.js";
import { writeAutomationCommand } from "../command-writer.js";
import { readConfig, writeConfig } from "../config-writer.js";
import { sendBotCommand } from "../ipc.js";
import { stripSensitive } from "../sensitive.js";

// API-2/10: serialize all api-route config writes through a process-local
// mutex. Without this, two endpoints firing in parallel (e.g. /toggle and
// /strategy-overrides) could race on the read-modify-write of
// user-config.json and lose one set of changes.
let _apiWriteChain = Promise.resolve();
function _apiWriteLock(work) {
  const next = _apiWriteChain.then(() => work());
  _apiWriteChain = next.catch(() => {});
  return next;
}
import { resetTradingPlan } from "../../trading-plan-30.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets } from "../../smart-wallets.js";
import { blockDev, unblockDev, listBlockedDevs } from "../../dev-blocklist.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../../token-blacklist.js";
import { getPriorityWallets, getGmgnPriorityWallets, getCopyTradeConfig, getCopyTradeStats, getRecentSignals, confirmCopySignal, rejectCopySignal } from "../../tools/wallet-copy-trade.js";
import { getSmartMoneyCandidates, getRugDevAlerts, getWalletSignalStats, checkRugDevDeployer, autoBlockRugDevToken } from "../../tools/wallet-signal-injector.js";
import { getPositionLimitsConfig, getPositionLimitDashboard, computeKellyPositions } from "../../tools/position-limits.js";
import { getFeeTrackerDashboard, DEX_FEE_BPS, PLATFORM_FEE_BPS, getRentStats, getRpcCostStats } from "../../tools/fee-tracker.js";
import { getPerformanceSummary } from "../../lessons.js";
import { PRESETS, getStrategy, setStrategyOverride, clearStrategyOverrides } from "../../strategies.js";
import { isGmgnEnabled, gmgnCircuitOpen } from "../../tools/gmgn.js";
import { getPortfolioDashboard } from "../../agents/portfolio-manager.js";
import { getSkillLoopDashboard, promoteSkillWithApproval, buildApprovalRequest } from "../../agents/skill-codifier.js";
import { listImportedSkills } from "../../skill-registry.js";
import { setStrategySkillStatus, setStrategySkillWeight } from "../../strategy-skills.js";
import { getStats } from "../../metrics.js";
import { config } from "../../config.js";

const ALLOWED_LIFECYCLE_CMDS = new Set(["start", "stop"]);
const ALLOWED_SLASH_CMDS = new Set([
  "/menu", "/strategies", "/strategy", "/stratset", "/agent", "/auto",
  "/confirm", "/dailyguard", "/continue", "/resetplan", "/plan", "/stoptrade",
  "/pending", "/no", "/yes", "/metrics", "/kill", "/unkill", "/killstate",
  "/wallets", "/pnl", "/status", "/health", "/feature", "/devcheck", "/dayphase",
  "/skills", "/promoteskill", "/rejectskill", "/skillweight",
]);

export function createApiRouter() {
  const router = Router();

  router.get("/status", async (req, res) => {
    try {
      res.json(await readBotState());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GMGN integration health — surfaces whether the optional GMGN layer is live,
  // whether its rate-limit circuit is currently open, the per-surface feature
  // flags, and the adapter's success/rate-limit/skip counters. Lets an operator
  // tell at a glance if GMGN is silently degraded (circuit open) before relying
  // on its signals.
  router.get("/gmgn-health", (req, res) => {
    try {
      const counters = getStats()?.counters || {};
      res.json({
        ok: true,
        enabled: isGmgnEnabled(),
        circuit_open: gmgnCircuitOpen(),
        features: config.gmgn || null,
        counters: {
          ok: counters.gmgn_ok || 0,
          rate_limit: counters.gmgn_rate_limit || 0,
          circuit_skip: counters.gmgn_circuit_skip || 0,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Phase 2 — multi-strategy portfolio book: staged flags, weighted book, and
  // per-skill P&L attribution. Reads registry/attribution from disk directly.
  router.get("/portfolio", (req, res) => {
    try {
      res.json({ ok: true, ...getPortfolioDashboard() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Phase 3 — self-improvement loop: loop-authored shadow skills + their paper
  // sample, awaiting MANUAL promotion approval (loop never auto-promotes).
  router.get("/skill-loop", (req, res) => {
    try {
      res.json({ ok: true, ...getSkillLoopDashboard() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Set a strategy-skill's weight in the portfolio book (live — the bot reads
  // the registry fresh each cycle, no restart needed). Weight 0 = out of the book.
  router.post("/portfolio/weight", (req, res) => {
    const { skillId, weight } = req.body || {};
    if (typeof skillId !== "string" || !skillId.trim()) return res.status(400).json({ ok: false, error: "skillId required" });
    const w = Number(weight);
    if (!Number.isFinite(w) || w < 0 || w > 1) return res.status(400).json({ ok: false, error: "weight must be a number in [0,1]" });
    try {
      const skill = setStrategySkillWeight(skillId, w);
      return res.json({ ok: true, skillId, weight: skill.weight });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Phase 3 — MANUAL governance gate. The loop never auto-promotes; an operator
  // approves a shadow skill here, which promotes it to active at a capped weight.
  // promoteSkillWithApproval refuses unless approved:true, and the registry
  // re-checks the scorecard gate + quarantine, so this can't bypass safety.
  router.post("/skill-loop/action", (req, res) => {
    const { action, skillId } = req.body || {};
    if (typeof skillId !== "string" || !skillId.trim()) return res.status(400).json({ ok: false, error: "skillId required" });
    try {
      if (action === "promote") {
        const skill = promoteSkillWithApproval(skillId, { approved: true });
        return res.json({ ok: true, action, skillId, status: skill.status, weight: skill.weight });
      }
      if (action === "reject") {
        const skill = setStrategySkillStatus(skillId, "retired");
        return res.json({ ok: true, action, skillId, status: skill.status });
      }
      return res.status(400).json({ ok: false, error: "Unknown action. Use: promote, reject" });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Phase 4 — internal skill marketplace: imported strategy-skill packages and
  // their vetting verdict (execution-class imports are quarantined, never auto-exec).
  router.get("/skill-registry", (req, res) => {
    try {
      res.json({ ok: true, imported: listImportedSkills() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get("/config", (req, res) => {
    // API-1: defense-in-depth — even though /api/* is behind auth, redact
    // secret-shaped fields so a credential leak in the response doesn't
    // expand the compromise to upstream services (shyft, helius, etc.).
    res.json(stripSensitive(readConfig()));
  });

  router.post("/command", (req, res) => {
    const { cmd } = req.body || {};
    if (!ALLOWED_LIFECYCLE_CMDS.has(cmd)) return res.status(400).json({ error: "Unknown cmd" });
    writeAutomationCommand(cmd);
    res.json({ ok: true });
  });

  router.post("/toggle", (req, res) => {
    const { feature, enabled } = req.body || {};
    const FEATURES = {
      vault: "vault.sweep.enabled",
      tradingPlan: "tradingPlan.enabled",
      dailyGuard: "dailyTradeGuard.enabled",
      trashFilter: "trashFilterEnabled",
      devBlacklist: "devBlacklistEnabled",
      stagedEntry: "stagedEntryEnabled",
      dayPhaseScreener: "dayPhaseScreenerEnabled",
      strategyEvolution: "strategyEvolutionEnabled",
      rugCheck: "rugCheckEnabled",
      sellSim: "sellSimEnabled",
      rugAnomaly: "rugAnomalyEnabled",
      darwin: "darwinEnabled",
    };
    if (!FEATURES[feature]) return res.status(400).json({ error: "Unknown feature" });
    const current = readConfig();
    const parts = FEATURES[feature].split(".");
    const rootKey = parts[0];
    const root = (current[rootKey] && typeof current[rootKey] === "object") ? current[rootKey] : {};
    let obj = root;
    for (let i = 1; i < parts.length - 1; i++) {
      obj[parts[i]] = obj[parts[i]] || {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = Boolean(enabled);
    writeConfig({ [rootKey]: root });
    res.json({ ok: true, feature, enabled: Boolean(enabled) });
  });

  router.post("/resetplan", (req, res) => {
    const s = resetTradingPlan();
    res.json({ ok: true, status: s });
  });

  router.post("/trash-wallets", (req, res) => {
    const { action, wallets, address } = req.body || {};
    if (action === "set") {
      if (!Array.isArray(wallets)) return res.status(400).json({ error: "wallets must be an array" });
      writeConfig({ trashWallets: wallets });
      return res.json({ ok: true, count: wallets.length });
    }
    if (action === "add") {
      if (typeof address !== "string" || address.length < 32) return res.status(400).json({ error: "Invalid address" });
      const current = readConfig();
      const list = (current.trashWallets || []).map(w => typeof w === "string" ? { address: w } : w);
      list.push({ address: address.trim() });
      writeConfig({ trashWallets: list });
      return res.json({ ok: true, count: list.length });
    }
    if (action === "remove") {
      if (typeof address !== "string") return res.status(400).json({ error: "Invalid address" });
      const current = readConfig();
      const list = (current.trashWallets || []).map(w => typeof w === "string" ? { address: w } : w);
      // API-8: Solana base58 addresses are case-sensitive — lowercasing for
      // compare would silently fail to remove the intended wallet (or remove
      // a different one whose lowercased form happens to collide).
      const target = address.trim();
      const filtered = list.filter(w => (w.address || w) !== target);
      writeConfig({ trashWallets: filtered });
      return res.json({ ok: true, removed: list.length - filtered.length });
    }
    return res.status(400).json({ error: "Unknown action. Use: set, add, remove" });
  });

  // ─── Smart Wallets (copy-trading signals) ──────────────
  router.get("/smart-wallets", async (req, res) => {
    try {
      res.json({ ok: true, wallets: listSmartWallets() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/smart-wallets", async (req, res) => {
    try {
      const { action, address, label, notes } = req.body || {};
      if (action === "add") {
        if (typeof address !== "string" || address.length < 32) return res.status(400).json({ error: "Invalid address" });
        const result = await addSmartWallet({ address: address.trim(), label: label || "", notes: notes || "" });
        return res.json(result);
      }
      if (action === "remove") {
        if (typeof address !== "string") return res.status(400).json({ error: "Invalid address" });
        const result = await removeSmartWallet({ address: address.trim() });
        return res.json(result);
      }
      return res.status(400).json({ error: "Unknown action. Use: add, remove" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Dev / Rug Wallets (scam deployers) ─────────────────
  router.get("/dev-wallets", (req, res) => {
    try {
      res.json({ ok: true, devs: listBlockedDevs() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/dev-wallets", async (req, res) => {
    try {
      const { action, address, reason } = req.body || {};
      if (action === "add") {
        if (typeof address !== "string" || address.length < 32) return res.status(400).json({ error: "Invalid address" });
        const result = await blockDev({ address: address.trim(), reason: reason || "" });
        return res.json(result);
      }
      if (action === "remove") {
        if (typeof address !== "string") return res.status(400).json({ error: "Invalid address" });
        const result = await unblockDev({ address: address.trim() });
        return res.json(result);
      }
      return res.status(400).json({ error: "Unknown action. Use: add, remove" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Token Blacklist (trash coins) ──────────────────────
  router.get("/token-blacklist", (req, res) => {
    try {
      res.json({ ok: true, tokens: listBlacklist() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/token-blacklist", async (req, res) => {
    try {
      const { action, mint, reason } = req.body || {};
      if (action === "add") {
        if (typeof mint !== "string" || mint.length < 32) return res.status(400).json({ error: "Invalid mint" });
        const result = await addToBlacklist({ mint: mint.trim(), reason: reason || "" });
        return res.json(result);
      }
      if (action === "remove") {
        if (typeof mint !== "string") return res.status(400).json({ error: "Invalid mint" });
        const result = await removeFromBlacklist({ mint: mint.trim() });
        return res.json(result);
      }
      return res.status(400).json({ error: "Unknown action. Use: add, remove" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Hunter Agent Config ────────────────────────────────
  router.get("/hunter-config", (req, res) => {
    const cfg = readConfig();
    res.json({
      ok: true,
      hunter: cfg.hunter || {
        enabled: true,
        sources: ["search", "pumpfun", "gainers", "newest", "geckoterminal", "smart_money", "jupiter"],
        minLiquidity: 500,
        minSwaps: 5,
        minMcap: 5000,
        maxAgeHours: 168,
        minAgeMinutes: 5,
        customQueries: [],
      },
    });
  });

  router.post("/hunter-config", (req, res) => {
    try {
      const { hunter } = req.body || {};
      if (!hunter || typeof hunter !== "object") return res.status(400).json({ error: "hunter object required" });
      writeConfig({ hunter });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Priority Wallets (win rate >= 70%) ─────────────────
  router.get("/priority-wallets", async (req, res) => {
    try {
      const minWr = req.query.min_win_rate ? parseFloat(req.query.min_win_rate) : undefined;
      const threshold = Number.isFinite(minWr) ? minWr : undefined;
      const local = getPriorityWallets(threshold);
      // Augment with GMGN's live smart-money/KOL priority list (no-op without a
      // GMGN key). Dedup by address — local (tracked) entries win.
      const gmgn = await getGmgnPriorityWallets(threshold).catch(() => []);
      const seen = new Set(local.map((w) => w.address));
      const wallets = [...local, ...gmgn.filter((w) => w.address && !seen.has(w.address))];
      res.json({ ok: true, count: wallets.length, local_count: local.length, gmgn_count: wallets.length - local.length, wallets });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Copy Trade Config & Signals ───────────────────────
  router.get("/copy-trade", (req, res) => {
    try {
      const cfg = getCopyTradeConfig();
      const stats = getCopyTradeStats();
      const signals = getRecentSignals(20);
      res.json({ ok: true, config: cfg, stats, signals });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/copy-trade", (req, res) => {
    try {
      const { action, signalIndex } = req.body || {};
      if (action === "config") {
        const { copyTrade } = req.body;
        if (!copyTrade || typeof copyTrade !== "object") return res.status(400).json({ error: "copyTrade object required" });
        writeConfig({ copyTrade });
        return res.json({ ok: true });
      }
      if (action === "confirm") {
        const result = confirmCopySignal(signalIndex ?? 0);
        return res.json(result);
      }
      if (action === "reject") {
        const result = rejectCopySignal(signalIndex ?? 0);
        return res.json(result);
      }
      if (action === "enable") {
        const cfg = getCopyTradeConfig();
        writeConfig({ copyTrade: { ...cfg, enabled: true } });
        return res.json({ ok: true, enabled: true });
      }
      if (action === "disable") {
        const cfg = getCopyTradeConfig();
        writeConfig({ copyTrade: { ...cfg, enabled: false } });
        return res.json({ ok: true, enabled: false });
      }
      return res.status(400).json({ error: "Unknown action. Use: config, confirm, reject, enable, disable" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Wallet Signal Injector ───────────────────────────
  router.get("/wallet-signals", (req, res) => {
    try {
      const minWr = parseFloat(req.query.min_win_rate) || 0.60;
      const smSignals = getSmartMoneyCandidates({ minWinRate: Number.isFinite(minWr) ? minWr : 0.60 });
      const rugAlerts = getRugDevAlerts(20);
      const stats = getWalletSignalStats();
      res.json({ ok: true, smartMoneySignals: smSignals, rugAlerts, stats });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/wallet-signals", async (req, res) => {
    try {
      const { action, creatorWallet, tokenMint, tokenSymbol } = req.body || {};
      if (action === "check_rug_dev") {
        const alert = checkRugDevDeployer({ creatorWallet, tokenMint, tokenSymbol });
        return res.json({ ok: true, alert });
      }
      if (action === "block_rug_token") {
        const result = await autoBlockRugDevToken({ creatorWallet, tokenMint, tokenSymbol });
        return res.json(result);
      }
      return res.status(400).json({ error: "Unknown action. Use: check_rug_dev, block_rug_token" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Position Limits (per-strategy, manual/kelly) ──────
  router.get("/position-limits", (req, res) => {
    try {
      const dashboard = getPositionLimitDashboard();
      res.json({ ok: true, ...dashboard });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/position-limits", (req, res) => {
    try {
      const { action, positionLimits, kellyFraction, strategyId } = req.body || {};
      if (action === "config") {
        if (!positionLimits || typeof positionLimits !== "object") return res.status(400).json({ error: "positionLimits object required" });
        writeConfig({ positionLimits });
        return res.json({ ok: true });
      }
      if (action === "set_strategy") {
        const cfg = getPositionLimitsConfig();
        const limit = Number(req.body.limit);
        if (!strategyId || !Number.isFinite(limit) || limit < 1 || limit > 20) {
          return res.status(400).json({ error: "Invalid strategyId or limit (1-20)" });
        }
        cfg.perStrategy = cfg.perStrategy || {};
        cfg.perStrategy[strategyId] = Math.round(limit);
        writeConfig({ positionLimits: cfg });
        return res.json({ ok: true, strategyId, limit: Math.round(limit) });
      }
      if (action === "set_mode") {
        const mode = req.body.mode;
        if (mode !== "manual" && mode !== "kelly") return res.status(400).json({ error: "mode must be manual or kelly" });
        const cfg = getPositionLimitsConfig();
        cfg.mode = mode;
        writeConfig({ positionLimits: cfg });
        return res.json({ ok: true, mode });
      }
      if (action === "kelly_calc") {
        // API-5: clamp kellyFraction to operationally safe range. Without
        // this, a caller could pass 1e9 or a negative number and corrupt
        // the position-limit calculation.
        const raw = Number(kellyFraction);
        const fraction = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
        const kelly = computeKellyPositions({ kellyFraction: fraction });
        return res.json({ ok: true, kelly, kellyFraction: fraction });
      }
      return res.status(400).json({ error: "Unknown action. Use: config, set_strategy, set_mode, kelly_calc" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Strategy Overrides (per-strategy SL/TP) ──────────
  router.get("/strategy-overrides", (req, res) => {
    try {
      const strategies = Object.keys(PRESETS).map(id => {
        const strat = getStrategy(id);
        const preset = PRESETS[id];
        return {
          id,
          name: preset.name,
          stoploss: strat.stoploss,
          minimal_roi: strat.minimal_roi,
          trailing_stop: strat.trailing_stop,
          partial_tp: strat.partial_tp,
          _source: strat._runtime_source || "preset",
        };
      });
      res.json({ ok: true, strategies });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Evolved Strategy Registry ────────────────────────────
  // Reads data/strategy-registry.json directly — no circular import from index.js.
  router.get("/strategies/evolved", (req, res) => {
    try {
      const { existsSync, readFileSync } = require("fs");
      const { join } = require("path");
      const p = join(process.cwd(), "data", "strategy-registry.json");
      if (!existsSync(p)) return res.json({ ok: true, evolved: [], total: 0 });
      const all = JSON.parse(readFileSync(p, "utf8"));
      const evolved = Array.isArray(all) ? all : [];
      res.json({
        ok: true,
        evolved: evolved.map(s => ({
          id:           s.id,
          name:         s.name,
          status:       s.status,
          regime:       s.regime || null,
          source:       s.source || "unknown",
          scores:       s.scores || {},
          activatedAt:  s.activatedAt || null,
          rejectedAt:   s.rejectedAt || null,
          rejectReason: s.rejectReason || null,
        })),
        total:   evolved.length,
        active:  evolved.filter(s => s.status === "active").length,
        pending: evolved.filter(s => s.status === "candidate").length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/strategy-overrides", (req, res) => {
    try {
      const { action, strategyId, key, value } = req.body || {};
      if (action === "set") {
        if (!strategyId || !key) return res.status(400).json({ error: "strategyId and key required" });
        const result = setStrategyOverride(strategyId, key, value);
        if (result === null) return res.status(400).json({ error: `Invalid value for ${key}` });
        return res.json({ ok: true, strategyId, key, value: result });
      }
      if (action === "reset") {
        clearStrategyOverrides(strategyId || null);
        return res.json({ ok: true });
      }
      if (action === "set_bulk") {
        const { overrides } = req.body || {};
        if (!overrides || typeof overrides !== "object") return res.status(400).json({ error: "overrides object required" });
        for (const [sid, fields] of Object.entries(overrides)) {
          if (!PRESETS[sid]) continue;
          for (const [k, v] of Object.entries(fields)) {
            setStrategyOverride(sid, k, v);
          }
        }
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: "Unknown action. Use: set, reset, set_bulk" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Fee Tracker Dashboard ────────────────────────────
  router.get("/fee-tracker", (req, res) => {
    try {
      const dashboard = getFeeTrackerDashboard();
      const perfSummary = (() => {
        try {
          return getPerformanceSummary();
        } catch { return null; }
      })();
      res.json({
        ok: true,
        dexRegistry: Object.entries(DEX_FEE_BPS).map(([name, bps]) => ({ name, fee_pct: (bps / 100).toFixed(2) + "%", bps })),
        platformFees: Object.entries(PLATFORM_FEE_BPS).filter(([, bps]) => bps > 0).map(([name, bps]) => ({ name, fee_pct: (bps / 100).toFixed(2) + "%", bps })),
        rent: getRentStats(),
        rpc: getRpcCostStats(),
        performance: perfSummary ? {
          totalTrades: perfSummary.total_trades || 0,
          winRate: perfSummary.win_rate || 0,
          totalPnlSol: perfSummary.total_pnl_sol || 0,
        } : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/cmd", async (req, res) => {
    const { cmd, args = [] } = req.body || {};
    if (typeof cmd !== "string" || cmd.length > 64) {
      return res.status(400).json({ error: "Invalid cmd" });
    }
    if (!ALLOWED_SLASH_CMDS.has(cmd.split(" ")[0])) {
      return res.status(400).json({ error: "Unknown or disallowed command" });
    }
    if (!Array.isArray(args) || args.length > 16) {
      return res.status(400).json({ error: "Invalid args" });
    }
    for (const a of args) {
      if (typeof a !== "string" || a.length > 256) {
        return res.status(400).json({ error: "Invalid arg entry" });
      }
    }
    const result = await sendBotCommand({ cmd, args });
    res.json(result);
  });

  return router;
}
