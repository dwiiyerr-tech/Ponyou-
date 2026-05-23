import { Router } from "express";
import { readBotState } from "../state-reader.js";
import { writeAutomationCommand } from "../command-writer.js";
import { readConfig, writeConfig } from "../config-writer.js";
import { sendBotCommand } from "../ipc.js";
import { resetTradingPlan } from "../../trading-plan-30.js";

const ALLOWED_LIFECYCLE_CMDS = new Set(["start", "stop"]);
const ALLOWED_SLASH_CMDS = new Set([
  "/menu", "/strategies", "/strategy", "/stratset", "/agent", "/auto",
  "/confirm", "/dailyguard", "/continue", "/resetplan", "/plan", "/stoptrade",
  "/pending", "/no", "/yes", "/metrics", "/kill", "/unkill", "/killstate", "/wallets", "/pnl", "/status",
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

  router.get("/config", (req, res) => {
    res.json(readConfig());
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
