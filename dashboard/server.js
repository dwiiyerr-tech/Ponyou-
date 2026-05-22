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
import { generateToken, authMiddleware } from "./auth.js";

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

  // Auth middleware — exempt public HTML pages and first-time wizard config
  app.use((req, res, next) => {
    const publicPaths = ["/", "/wizard", "/wizard.html", "/index.html"];
    const publicApiPaths = [{ method: "GET", path: "/wizard/config" }];
    if (publicPaths.includes(req.path)) return next();
    if (publicApiPaths.some(p => p.method === req.method && p.path === req.path)) return next();
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
  setInterval(async () => {
    if (wss.clients.size === 0) return;
    try {
      const state = await readBotState();
      const msg = JSON.stringify({ type: "state", data: state });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(msg);
      }
    } catch {}
  }, 2000);

  // Send buffered logs on connect, then stream new ones
  wss.on("connection", (ws) => {
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
    start: () => new Promise(r => server.listen(port, "127.0.0.1", r)),
  };
}
