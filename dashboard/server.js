import express from "express";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { spawn } from "child_process";
import { readBotState } from "./state-reader.js";
import { globalLogBuffer } from "./log-buffer.js";
import { createApiRouter } from "./routes/api.js";
import { createWizardRouter } from "./routes/wizard.js";
import { getToken, checkToken, validateToken, validateTokenWs } from "./auth.js";
import { stripSensitive } from "./sensitive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

export function createDashboardServer({ port = 3000 } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // getToken (not generateToken): keep the token stable across pm2 restarts so
  // operator sessions survive a bot restart; it still rotates after 24h.
  const dashToken = getToken();
  log("dashboard", `Auth token: ${dashToken.slice(0, 8)}... (see dashboard-token.txt)`);

  const COOKIE_OPTS = { httpOnly: true, sameSite: "strict", maxAge: 24 * 60 * 60 * 1000, path: "/" };
  const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ponyou — Login</title>
<style>body{background:#0b0e14;color:#d7dce5;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
form{background:#11151f;border:1px solid #1f2533;border-radius:10px;padding:28px;width:320px}h1{font-size:15px;margin:0 0 6px}p{font-size:12px;color:#8a93a5;margin:0 0 16px}
input{width:100%;box-sizing:border-box;background:#0b0e14;color:#d7dce5;border:1px solid #2a3245;border-radius:6px;padding:9px;font:inherit;margin-bottom:12px}
button{width:100%;background:#2563eb;color:#fff;border:0;border-radius:6px;padding:9px;font:inherit;cursor:pointer}.err{color:#f87171;font-size:12px;margin:0 0 10px}</style></head>
<body><form method="POST" action="/login"><h1>Ponyou Mission Control</h1><p>Paste the token from <code>dashboard-token.txt</code> on the host.</p>__ERR__<input type="password" name="token" placeholder="dashboard token" autofocus autocomplete="off"><button type="submit">Sign in</button></form></body></html>`;

  // Login: GET /login?token=… (one-click from the host) or the form POST.
  app.get("/login", (req, res) => {
    const qs = req.query?.token;
    if (qs && checkToken(qs)) {
      res.cookie("dashtoken", getToken(), COOKIE_OPTS);
      return res.redirect("/");
    }
    res.type("html").send(LOGIN_HTML.replace("__ERR__", qs ? '<p class="err">Invalid token.</p>' : ""));
  });
  app.post("/login", (req, res) => {
    if (checkToken(req.body?.token)) {
      res.cookie("dashtoken", getToken(), COOKIE_OPTS);
      return res.redirect("/");
    }
    res.status(401).type("html").send(LOGIN_HTML.replace("__ERR__", '<p class="err">Invalid token.</p>'));
  });
  app.post("/logout", (req, res) => {
    res.clearCookie("dashtoken", { path: "/" });
    res.redirect("/login");
  });

  // Auth gate — registered BEFORE express.static so "/" can't be served as
  // dist/index.html without a session. All API routes (including wizard
  // routes) require the dashboard token even during first-time setup.
  // P1-3: previously wizard write endpoints were unauth during setup window —
  // any local process could overwrite config before the operator completed setup.
  // Static assets (JS/CSS bundles) stay public: they contain no data — every
  // sensitive byte flows through /api or the WebSocket, both gated.
  app.use((req, res, next) => {
    if (validateToken(req)) return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/wizard")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (req.path === "/" || req.path === "/index.html") {
      return res.redirect("/login");
    }
    return next();
  });
  app.use(express.static(path.join(__dirname, "dist")));

  // First-time redirect: only when user-config.json does not exist at all.
  // Keying on walletAddress hid the monitor forever on deployments that keep
  // the wallet in .env (this one) — a configured, trading bot was redirected
  // to the setup wizard on every visit to "/".
  app.get("/", (req, res, next) => {
    try {
      const cfgPath = path.join(__dirname, "..", "user-config.json");
      if (!fs.existsSync(cfgPath)) return res.redirect("/wizard.html");
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

  const tail = spawn("bash", ["-c", `tail -F ${path.join(__dirname, '..', 'logs', 'agent-*.log')} 2>/dev/null`]);
  tail.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) globalLogBuffer.push(line.trim());
    }
  });

  wss.on("connection", (ws, req) => {
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
            server.listen(port, "0.0.0.0", () => resolve()).once("error", (e2) => {
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
      server.listen(port, "0.0.0.0", () => resolve()).once("error", onError);
    }),
    shutdown: () => {
      clearInterval(broadcastTimer);
      for (const client of wss.clients) {
        try { client.terminate(); } catch {}
      }
      wss.close();
      if (tail) tail.kill();
      return new Promise(r => server.close(() => r()));
    },
  };
}
