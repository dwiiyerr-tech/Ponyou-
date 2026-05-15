/**
 * Ponyou Dashboard WebSocket Server
 * Watches Ponyou state files and streams real-time updates to connected browsers.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PONYOU_DIR = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;

// ── File paths ────────────────────────────────────────────────────────────────
const FILES = {
  state:         path.join(PONYOU_DIR, 'state.json'),
  tradingPlan:   path.join(PONYOU_DIR, 'trading-plan.json'),
  observedTokens: path.join(PONYOU_DIR, 'observed-tokens.json'),
  marketIntel:   path.join(PONYOU_DIR, 'market-intel.json'),
  lastReport:    path.join(PONYOU_DIR, 'last-report.json'),
  learningState: path.join(PONYOU_DIR, 'learning-state.json'),
  userConfig:    path.join(PONYOU_DIR, 'user-config.json'),
};
const LOGS_DIR = path.join(PONYOU_DIR, 'logs');

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function getLogFile() {
  return path.join(LOGS_DIR, `agent-${todayStr()}.log`);
}

function getActionsFile() {
  return path.join(LOGS_DIR, `actions-${todayStr()}.jsonl`);
}

function parseLogLine(raw) {
  const m = raw.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/);
  if (m) return { timestamp: m[1], category: m[2], message: m[3], raw };
  // Action lines like "[deploy_position] ✓ TOKEN 0.5 SOL (234ms)"
  const a = raw.match(/^\[([^\]]+)\]\s+(.*)$/);
  if (a) return { timestamp: new Date().toISOString(), category: 'ACTION', message: a[2], raw };
  return { timestamp: new Date().toISOString(), category: 'INFO', message: raw, raw };
}

function tailFile(file, n = 300) {
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').filter(l => l.trim()).slice(-n);
  } catch { return []; }
}

function getFullSnapshot() {
  return {
    state:          readJSON(FILES.state,          { positions: {}, recentEvents: [] }),
    tradingPlan:    readJSON(FILES.tradingPlan,     null),
    observedTokens: readJSON(FILES.observedTokens, { observed: [] }),
    marketIntel:    readJSON(FILES.marketIntel,    { snapshots: [], currentCondition: 'UNKNOWN' }),
    lastReport:     readJSON(FILES.lastReport,     null),
    learningState:  readJSON(FILES.learningState,  null),
    userConfig:     readJSON(FILES.userConfig,     {}),
    recentLogs:     tailFile(getLogFile(), 300).map(parseLogLine),
    recentActions:  tailFile(getActionsFile(), 100)
                      .map(l => { try { return JSON.parse(l); } catch { return null; } })
                      .filter(Boolean),
    serverTime:     Date.now(),
  };
}

// ── Clients & Broadcast ───────────────────────────────────────────────────────
const clients = new Set();

function broadcast(msg) {
  if (clients.size === 0) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// ── HTTP Server (serves built frontend in production) ─────────────────────────
const server = http.createServer((req, res) => {
  const DIST = path.join(__dirname, 'dist');
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Ponyou Dashboard server running. Connect via Vite dev server on port 5173.');
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(DIST, urlPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css',   '.json': 'application/json',
    '.png': 'image/png',  '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[ws] client connected (${clients.size} total) from ${req.socket.remoteAddress}`);

  ws.send(JSON.stringify({ type: 'init', data: getFullSnapshot() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      if (msg.type === 'request_state') {
        ws.send(JSON.stringify({ type: 'init', data: getFullSnapshot() }));
      }
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected (${clients.size} total)`);
  });
  ws.on('error', () => clients.delete(ws));
});

// ── File Watchers ─────────────────────────────────────────────────────────────
const watchedFiles = Object.values(FILES);
watchedFiles.forEach(file => {
  if (!fs.existsSync(file)) return;
  try {
    fs.watch(file, { persistent: false }, debounce(() => {
      broadcast({
        type: 'state_update',
        data: {
          state:          readJSON(FILES.state,          {}),
          tradingPlan:    readJSON(FILES.tradingPlan,    null),
          observedTokens: readJSON(FILES.observedTokens, { observed: [] }),
          marketIntel:    readJSON(FILES.marketIntel,    {}),
          lastReport:     readJSON(FILES.lastReport,     null),
          learningState:  readJSON(FILES.learningState,  null),
          userConfig:     readJSON(FILES.userConfig,     {}),
        },
        ts: Date.now(),
      });
    }, 200));
  } catch {}
});

// ── Log tail (poll every second for new lines) ────────────────────────────────
let logPos = 0;
let actionsPos = 0;
let lastLogDate = '';

setInterval(() => {
  const today = todayStr();
  const logFile = getLogFile();
  const actFile = getActionsFile();

  // Reset positions at midnight
  if (today !== lastLogDate) {
    logPos = 0;
    actionsPos = 0;
    lastLogDate = today;
  }

  // Tail agent log
  if (fs.existsSync(logFile)) {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > logPos) {
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - logPos);
        fs.readSync(fd, buf, 0, buf.length, logPos);
        fs.closeSync(fd);
        logPos = stat.size;

        buf.toString('utf8').split('\n').filter(l => l.trim()).forEach(raw => {
          broadcast({ type: 'log_line', data: parseLogLine(raw) });
        });
      }
    } catch {}
  }

  // Tail actions log
  if (fs.existsSync(actFile)) {
    try {
      const stat = fs.statSync(actFile);
      if (stat.size > actionsPos) {
        const fd = fs.openSync(actFile, 'r');
        const buf = Buffer.alloc(stat.size - actionsPos);
        fs.readSync(fd, buf, 0, buf.length, actionsPos);
        fs.closeSync(fd);
        actionsPos = stat.size;

        buf.toString('utf8').split('\n').filter(l => l.trim()).forEach(raw => {
          try {
            const action = JSON.parse(raw);
            broadcast({ type: 'action', data: action });
          } catch {}
        });
      }
    } catch {}
  }
}, 1000);

// ── Heartbeat ─────────────────────────────────────────────────────────────────
setInterval(() => {
  broadcast({ type: 'ping', data: { ts: Date.now(), clients: clients.size } });
}, 15000);

// ── Utils ─────────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   PONYOU DASHBOARD SERVER             ║`);
  console.log(`  ╠═══════════════════════════════════════╣`);
  console.log(`  ║   HTTP  : http://localhost:${PORT}        ║`);
  console.log(`  ║   WS    : ws://localhost:${PORT}/ws      ║`);
  console.log(`  ║   Data  : ${PONYOU_DIR.slice(-30).padStart(30)} ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});
