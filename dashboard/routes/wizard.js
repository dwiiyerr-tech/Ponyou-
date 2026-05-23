import { Router } from "express";
import { readConfig, writeConfig } from "../config-writer.js";

export function createWizardRouter() {
  const router = Router();

  router.get("/config", (req, res) => {
    res.json(readConfig());
  });

  router.post("/save", (req, res) => {
    try {
      const data = req.body || {};
      if (typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "body must be object" });
      }
      if (!data.walletAddress || typeof data.walletAddress !== "string") {
        return res.status(400).json({ error: "walletAddress required" });
      }
      writeConfig(data);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/test-telegram", async (req, res) => {
    const cfg = readConfig();
    const token = cfg.telegramBotToken;
    const chatId = cfg.telegramChatId;
    if (!token || !chatId) return res.status(400).json({ error: "token/chatId not configured" });
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "✅ Ponyou dashboard test message" }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      res.json({ ok: data.ok });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
