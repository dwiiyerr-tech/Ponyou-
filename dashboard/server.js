/**
 * Ponyou Dashboard WebSocket Server
 * Watches Ponyou state files and streams real-time updates to connected browsers.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { pauseSession, resumeSession, checkSessionGate, getPlanSummary } from '../trading-plan.js';
import { getActiveStrategyId, listStrategies, setActiveStrategy, STRATEGY_IDS } from '../strategies.js';
import { readAutomationState, issueAutomationCommand, persistAutomationPreference, readSupervisorState, issueSupervisorCommand } from '../automation-control.js';
import { readSetupSnapshot, applySetupDraft } from '../setup-wizard-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PONYOU_DIR = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;

const FILES = {
  state: path.join(PONYOU_DIR, 'state.json'),
  tradingPlan: path.join(PONYOU_DIR, 'trading-plan.json'),
  observedTokens: path.join(PONYOU_DIR, 'observed-tokens.json'),
  marketIntel: path.join(PONYOU_DIR, 'market-intel.json'),
  lastReport: path.join(PONYOU_DIR, 'last-report.json'),
  learningState: path.join(PONYOU_DIR, 'learning-state.json'),
  userConfig: path.join(PONYOU_DIR, 'user-config.json'),
  automationState: path.join(PONYOU_DIR, 'automation-state.json'),
  envFile: path.join(PONYOU_DIR, '.env'),
};
const LOGS_DIR = path.join(PONYOU_DIR, 'logs');

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
  const a = raw.match(/^\[([^\]]+)\]\s+(.*)$/);
  if (a) return { timestamp: new Date().toISOString(), category: 'ACTION', message: a[2], raw };
  return { timestamp: new Date().toISOString(), category: 'INFO', message: raw, raw };
}

function tailFile(file, n = 300) {
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').filter((line) => line.trim()).slice(-n);
  } catch {
    return [];
  }
}

function getStrategyState() {
  return {
    activeId: getActiveStrategyId(),
    available: listStrategies(),
  };
}

function getFullSnapshot() {
  return {
    state: readJSON(FILES.state, { positions: {}, recentEvents: [] }),
    tradingPlan: readJSON(FILES.tradingPlan, null),
    observedTokens: readJSON(FILES.observedTokens, { observed: [] }),
    marketIntel: readJSON(FILES.marketIntel, { snapshots: [], currentCondition: 'UNKNOWN' }),
    lastReport: readJSON(FILES.lastReport, null),
    learningState: readJSON(FILES.learningState, null),
    userConfig: readJSON(FILES.userConfig, {}),
    strategyState: getStrategyState(),
    automationState: readAutomationState(),
    supervisorState: readSupervisorState(),
    setupState: readSetupSnapshot(),
    recentLogs: tailFile(getLogFile(), 300).map(parseLogLine),
    recentActions: tailFile(getActionsFile(), 100)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean),
    serverTime: Date.now(),
  };
}

const clients = new Set();

function broadcast(msg) {
  if (clients.size === 0) return;
  const data = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function sendSnapshot(ws) {
  ws.send(JSON.stringify({ type: 'init', data: getFullSnapshot() }));
}

function updateUserConfig(mutator) {
  const current = readJSON(FILES.userConfig, {}) || {};
  const next = mutator({ ...current }) || current;
  writeJSON(FILES.userConfig, next);
  return next;
}

function executeControl(msg = {}) {
  const action = String(msg.action || '');

  if (action === 'pause_session') {
    const durationMin = Number(msg.durationMin || 60);
    const ok = pauseSession('DASHBOARD_MANUAL', durationMin);
    return {
      ok,
      action,
      message: ok
        ? `Session paused for ${durationMin} minute(s).`
        : 'Trading plan not initialized, so session pause could not be applied.',
      gate: checkSessionGate(),
      plan: getPlanSummary(),
      live: true,
    };
  }

  if (action === 'resume_session') {
    const ok = resumeSession();
    return {
      ok,
      action,
      message: ok
        ? 'Session pause cleared. New cycles may resume immediately if no other gate blocks them.'
        : 'Trading plan not initialized, so session resume could not be applied.',
      gate: checkSessionGate(),
      plan: getPlanSummary(),
      live: true,
    };
  }

  if (action === 'set_agent_power') {
    const enabled = !!msg.enabled;
    const command = issueSupervisorCommand({ action: 'set_power', enabled, source: 'dashboard' });
    return {
      ok: true,
      action,
      message: `Agent process power ${enabled ? 'ON' : 'OFF'} command queued to supervisor.`,
      command,
      supervisorState: readSupervisorState(),
      live: true,
    };
  }

  if (action === 'set_automation') {
    const enabled = !!msg.enabled;
    persistAutomationPreference(enabled);
    const command = issueAutomationCommand({ action: 'set_enabled', enabled, source: 'dashboard' });
    return {
      ok: true,
      action,
      message: `Automation ${enabled ? 'ON' : 'OFF'} command queued and persisted. The agent should apply it within a few seconds.`,
      command,
      automationState: readAutomationState(),
      live: true,
    };
  }

  if (action === 'set_strategy') {
    const id = String(msg.strategyId || '');
    if (!STRATEGY_IDS.includes(id)) {
      return {
        ok: false,
        action,
        message: `Unknown strategy: ${id || '(empty)'}; valid: ${STRATEGY_IDS.join(', ')}`,
        live: true,
      };
    }
    setActiveStrategy(id);
    return {
      ok: true,
      action,
      message: `Active strategy switched to ${id}. Runtime should hot-apply it on the next strategy read.`,
      strategyState: getStrategyState(),
      live: true,
    };
  }

  if (action === 'set_confirm_mode') {
    const enabled = !!msg.enabled;
    const cfg = updateUserConfig((draft) => {
      draft.confirmMode = enabled;
      return draft;
    });
    return {
      ok: true,
      action,
      message: `confirmMode persisted as ${enabled ? 'ON' : 'OFF'} in user-config.json. Restart the agent to apply it to the live runtime.`,
      config: cfg,
      live: false,
    };
  }

  if (action === 'set_multi_wallet') {
    const enabled = !!msg.enabled;
    const cfg = updateUserConfig((draft) => {
      draft.multiWalletEnabled = enabled;
      return draft;
    });
    return {
      ok: true,
      action,
      message: `multiWalletEnabled persisted as ${enabled ? 'ON' : 'OFF'} in user-config.json. Restart the agent to reload wallet topology.`,
      config: cfg,
      live: false,
    };
  }

  if (action === 'set_daily_report') {
    const enabled = !!msg.enabled;
    const cfg = updateUserConfig((draft) => {
      draft.dailyReportEnabled = enabled;
      return draft;
    });
    return {
      ok: true,
      action,
      message: `dailyReportEnabled persisted as ${enabled ? 'ON' : 'OFF'} in user-config.json. Restart may be required if the scheduler is already running.`,
      config: cfg,
      live: false,
    };
  }

  if (action === 'apply_setup_wizard') {
    const draft = msg.draft || {};
    let snapshot;
    try {
      snapshot = applySetupDraft(draft);
    } catch (error) {
      return {
        ok: false,
        action,
        error: error.message,
        walletTopology: error.walletTopology || null,
        live: false,
      };
    }

    const liveActions = [];
    if (typeof draft.strategyId === 'string' && draft.strategyId.trim()) {
      const strategyId = draft.strategyId.trim();
      setActiveStrategy(strategyId);
      liveActions.push(`strategy:${strategyId}`);
    }
    if (typeof draft.automationEnabled === 'boolean') {
      persistAutomationPreference(draft.automationEnabled);
      issueAutomationCommand({ action: 'set_enabled', enabled: draft.automationEnabled, source: 'setup_wizard' });
      liveActions.push(`automation:${draft.automationEnabled ? 'on' : 'off'}`);
    }
    if (typeof draft.confirmMode === 'boolean') {
      liveActions.push(`confirm:${draft.confirmMode ? 'on' : 'off'}`);
    }
    if (typeof draft.multiWalletEnabled === 'boolean') {
      liveActions.push(`multi_wallet:${draft.multiWalletEnabled ? 'on' : 'off'}`);
    }
    if (typeof draft.dailyReportEnabled === 'boolean') {
      liveActions.push(`daily_report:${draft.dailyReportEnabled ? 'on' : 'off'}`);
    }

    broadcast({ type: 'state_update', data: getFullSnapshot(), ts: Date.now() });
    return {
      ok: true,
      action,
      message: 'Setup wizard saved. Live-hot sections were synced where possible; restart may still be required for wallet/RPC/secret changes.',
      snapshot: snapshot,
      live: true,
      liveActions,
    };
  }

  if (action === 'refresh_state') {
    return {
      ok: true,
      action,
      message: 'Dashboard snapshot refreshed.',
      snapshot: getFullSnapshot(),
      live: true,
    };
  }

  return {
    ok: false,
    action,
    message: `Unknown control action: ${action || '(empty)'}`,
    live: false,
  };
}

const server = http.createServer((req, res) => {
  const DIST = path.join(__dirname, 'dist');
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Ponyou Dashboard server running. Connect via Vite dev server on port 5173.');
    return;
  }

  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(DIST, urlPath);

  const resolved = path.resolve(filePath);
  const distRoot = path.resolve(DIST);
  if (!resolved.startsWith(distRoot + path.sep) && resolved !== distRoot) {
    filePath = path.join(DIST, 'index.html');
  } else if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[ws] client connected (${clients.size} total) from ${req.socket.remoteAddress}`);

  sendSnapshot(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      if (msg.type === 'request_state') sendSnapshot(ws);
      if (msg.type === 'control_action') {
        const result = executeControl(msg);
        ws.send(JSON.stringify({ type: 'action_result', data: result }));
        if (result.snapshot) {
          ws.send(JSON.stringify({ type: 'init', data: result.snapshot }));
        } else {
          broadcast({ type: 'state_update', data: getFullSnapshot(), ts: Date.now() });
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected (${clients.size} total)`);
  });
  ws.on('error', () => clients.delete(ws));
});

const watchedFiles = Object.values(FILES);
watchedFiles.forEach((file) => {
  if (!fs.existsSync(file)) return;
  try {
    fs.watch(file, { persistent: false }, debounce(() => {
      broadcast({
        type: 'state_update',
        data: {
          state: readJSON(FILES.state, {}),
          tradingPlan: readJSON(FILES.tradingPlan, null),
          observedTokens: readJSON(FILES.observedTokens, { observed: [] }),
          marketIntel: readJSON(FILES.marketIntel, {}),
          lastReport: readJSON(FILES.lastReport, null),
          learningState: readJSON(FILES.learningState, null),
          userConfig: readJSON(FILES.userConfig, {}),
          strategyState: getStrategyState(),
          automationState: readAutomationState(),
          supervisorState: readSupervisorState(),
        },
        ts: Date.now(),
      });
    }, 200));
  } catch {}
});

let logPos = 0;
let actionsPos = 0;
let lastLogDate = '';

setInterval(() => {
  const today = todayStr();
  const logFile = getLogFile();
  const actFile = getActionsFile();

  if (today !== lastLogDate) {
    logPos = 0;
    actionsPos = 0;
    lastLogDate = today;
  }

  if (fs.existsSync(logFile)) {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > logPos) {
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - logPos);
        fs.readSync(fd, buf, 0, buf.length, logPos);
        fs.closeSync(fd);
        logPos = stat.size;

        buf.toString('utf8').split('\n').filter((line) => line.trim()).forEach((raw) => {
          broadcast({ type: 'log_line', data: parseLogLine(raw) });
        });
      }
    } catch {}
  }

  if (fs.existsSync(actFile)) {
    try {
      const stat = fs.statSync(actFile);
      if (stat.size > actionsPos) {
        const fd = fs.openSync(actFile, 'r');
        const buf = Buffer.alloc(stat.size - actionsPos);
        fs.readSync(fd, buf, 0, buf.length, actionsPos);
        fs.closeSync(fd);
        actionsPos = stat.size;

        buf.toString('utf8').split('\n').filter((line) => line.trim()).forEach((raw) => {
          try {
            const action = JSON.parse(raw);
            broadcast({ type: 'action', data: action });
          } catch {}
        });
      }
    } catch {}
  }
}, 1000);

setInterval(() => {
  broadcast({ type: 'ping', data: { ts: Date.now(), clients: clients.size } });
}, 15000);

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   PONYOU DASHBOARD SERVER             ║`);
  console.log(`  ╠═══════════════════════════════════════╣`);
  console.log(`  ║   HTTP  : http://localhost:${PORT}        ║`);
  console.log(`  ║   WS    : ws://localhost:${PORT}/ws      ║`);
  console.log(`  ║   Data  : ${PONYOU_DIR.slice(-30).padStart(30)} ║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});
