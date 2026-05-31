import express from "express";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { readBotState } from "./state-reader.js";
import { globalLogBuffer } from "./log-buffer.js";
import { createApiRouter } from "./routes/api.js";
import { createWizardRouter } from "./routes/wizard.js";
import { generateToken, authMiddleware, validateTokenWs } from "./auth.js";
import { stripSensitive } from "./sensitive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

export function createDashboardServer({ port = 3000 } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "public")));

  const dashToken = generateToken();
  log("dashboard", `Auth token: ${dashToken.slice(0, 8)}... (see dashboard-token.txt)`);

  // First-time setup detection: wizard endpoints are unauth ONLY when
  // user-config.json has no walletAddress yet. Once configured, the same
  // endpoints require auth like everything else.
  function isFirstTimeSetup() {
    try {
      const cfgPath = path.join(__dirname, "..", "user-config.json");
      if (!fs.existsSync(cfgPath)) return true;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      return !cfg.walletAddress;
    } catch { return true; }
  }

  // Auth middleware — exempt public HTML pages always; exempt wizard API
  // routes only during first-time setup (no walletAddress yet).
  app.use((req, res, next) => {
    const publicPaths = ["/", "/wizard", "/wizard.html", "/index.html"];
    const wizardApiPaths = [
      { method: "GET",  path: "/wizard/config" },
      { method: "POST", path: "/wizard/save" },
      { method: "GET",  path: "/wizard/wallet-status" },
      { method: "GET",  path: "/wizard/test-telegram" },
      { method: "GET",  path: "/wizard/gmgn-key-status" },
      { method: "POST", path: "/wizard/gmgn-keygen" },
    ];
    if (publicPaths.includes(req.path)) return next();
    if (wizardApiPaths.some(p => p.method === req.method && p.path === req.path) && isFirstTimeSetup()) {
      return next();
    }
    authMiddleware(req, res, next);
  });

  // First-time redirect: no walletAddress → wizard
  app.get("/", (req, res, next) => {
    try {
      const cfgPath = path.join(__dirname, "..", "user-config.json");
      if (!fs.existsSync(cfgPath)) return res.redirect("/wizard.html");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (!cfg.walletAddress) return res.redirect("/wizard.html");
    } catch {}
    next();
  });

  app.use("/api", createApiRouter());
  app.use("/wizard", createWizardRouter());

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Broadcast state every 2s
  const broadcastTimer = setInterval(async () => {
    if (wss.clients.size === 0) return;
    try {
      const state = await readBotState();
      const safe = stripSensitive(state);
      const msg = JSON.stringify({ type: "state", data: safe });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(msg);
      }
    } catch {}
  }, 2000);

  // Send buffered logs on connect, then stream new ones
  wss.on("connection", (ws, req) => {
    // Authenticate WebSocket connections
    if (!validateTokenWs(req)) {
      ws.send(JSON.stringify({ type: "error", data: "Unauthorized — provide ?token= or dashtoken cookie" }));
      ws.close(4001, "Unauthorized");
      return;
    }

    const lines = globalLogBuffer.lines();
    for (const line of lines) {
      ws.send(JSON.stringify({ type: "log", data: line }));
    }
    const unsub = globalLogBuffer.subscribe(line => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "log", data: line }));
    });
    ws.on("close", unsub);
  });

  return {
    app,
    server,
    wss,
    start: () => new Promise((resolve, reject) => {
      const onError = async (err) => {
        if (err.code === "EADDRINUSE") {
          // Try to free the port by killing the old owner (best-effort)
          try {
            const { execSync } = await import("child_process");
            const out = execSync(`fuser ${port}/tcp 2>/dev/null || lsof -ti:${port} 2>/dev/null`, { timeout: 3000 }).toString().trim();
            const pid = out.split("\n")[0]?.trim();
            if (pid && pid !== String(process.pid)) {
              console.warn(`[dashboard] Port ${port} held by pid ${pid} — killing stale process`);
              execSync(`kill -TERM ${pid} 2>/dev/null`, { timeout: 2000 });
            }
          } catch (_) { /* best-effort cleanup */ }
          // Retry once after a short delay
          setTimeout(() => {
            server.listen(port, "127.0.0.1", () => resolve()).once("error", (e2) => {
              if (e2.code === "EADDRINUSE") {
                console.warn(`[dashboard] Port ${port} still in use — dashboard disabled`);
                resolve();
              } else {
                reject(e2);
              }
            });
          }, 500);
        } else {
          reject(err);
        }
      };
      server.listen(port, "127.0.0.1", () => resolve()).once("error", onError);
    }),
    shutdown: () => {
      clearInterval(broadcastTimer);
      for (const client of wss.clients) {
        try { client.terminate(); } catch {}
      }
      wss.close();
      return new Promise(r => server.close(() => r()));
    },
  };
}
