import { Router } from "express";
import crypto from "crypto";
import { readConfig, writeConfig } from "../config-writer.js";
import { writeWalletKeys, walletKeyStatus, WALLET_ENV_PATTERN, gmgnKeyStatus, writeGmgnPrivateKey } from "../env-writer.js";
import { stripSensitive } from "../sensitive.js";

const BS58_PRIVKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

function extractWalletKeys(body) {
  const raw = body && typeof body._walletKeys === "object" && !Array.isArray(body._walletKeys)
    ? body._walletKeys
    : null;
  if (!raw) return { ok: true, keys: {} };
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!WALLET_ENV_PATTERN.test(k)) continue;
    if (v == null || v === "") {
      cleaned[k] = "";
      continue;
    }
    if (typeof v !== "string") return { ok: false, error: `_walletKeys.${k} must be a string` };
    const trimmed = v.trim();
    if (!BS58_PRIVKEY_PATTERN.test(trimmed)) {
      return { ok: false, error: `_walletKeys.${k} is not a valid bs58 private key` };
    }
    cleaned[k] = trimmed;
  }
  return { ok: true, keys: cleaned };
}

export function createWizardRouter() {
  const router = Router();

  router.get("/config", (req, res) => {
    // Redact secret-shaped fields. The wizard UI shows empty inputs for
    // [REDACTED] values, so users see "configured but hidden" — they must
    // re-enter to overwrite. This protects against an attacker who gains
    // loopback access during the first-time setup window.
    res.json(stripSensitive(readConfig()));
  });

  router.get("/wallet-status", (req, res) => {
    try {
      res.json(walletKeyStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/save", async (req, res) => {
    try {
      const data = req.body || {};
      if (typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "body must be object" });
      }
      if (!data.walletAddress || typeof data.walletAddress !== "string") {
        return res.status(400).json({ error: "walletAddress required" });
      }
      if (Array.isArray(data.wallets) && data.wallets.length > 10) {
        return res.status(400).json({ error: "max 10 wallets" });
      }
      const walletKeysParse = extractWalletKeys(data);
      if (!walletKeysParse.ok) {
        return res.status(400).json({ error: walletKeysParse.error });
      }
      if (Object.keys(walletKeysParse.keys).length > 0) {
        await writeWalletKeys(walletKeysParse.keys);
      }
      // Strip transport-only field; writeConfig's whitelist would drop it
      // anyway, but be explicit so it never lands in user-config.json.
      delete data._walletKeys;
      writeConfig(data);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Current GMGN credential state (does ~/.config/gmgn/.env already have keys).
  router.get("/gmgn-key-status", (req, res) => {
    try { res.json({ ok: true, ...gmgnKeyStatus() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Generate an Ed25519 keypair for GMGN OpenAPI. The PRIVATE key (signing
  // secret) is written to ~/.config/gmgn/.env (0600) and NEVER returned; only
  // the PUBLIC key is sent back for the user to register at gmgn.ai/ai.
  // Refuses to overwrite an existing private key unless {overwrite:true}, since
  // regenerating invalidates the API key bound to the old public key.
  router.post("/gmgn-keygen", (req, res) => {
    try {
      const overwrite = req.body?.overwrite === true;
      const status = gmgnKeyStatus();
      if (status.hasPrivateKey && !overwrite) {
        return res.status(409).json({
          ok: false, existed: true,
          error: "A GMGN private key already exists. Regenerating it invalidates the API key bound to the old public key. Re-send with overwrite:true to replace.",
        });
      }
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      writeGmgnPrivateKey(privateKey); // private key stays on the machine
      res.json({ ok: true, publicKey, regenerated: status.hasPrivateKey });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
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
