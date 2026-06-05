// Bridge to Ponyou state — WebSocket (live) with file polling (fallback)
//
// Connects to ws://127.0.0.1:3000 for real-time state + log streaming.
// When WS is unavailable, falls back to reading JSON files from disk.

import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

// ── Event bus ──
export const bus = new EventEmitter();
bus.setMaxListeners(20);

// ── Internal state ──
let _ws = null;
let _connected = false;
let _state = {};
let _logs = [];
let _reconnectAttempt = 0;
let _reconnectTimer = null;
let _stopped = false;
const MAX_LOGS = 500;
const MAX_RECONNECT_DELAY_MS = 60_000; // cap exponential backoff at 1 min

function readDashboardToken() {
  // Token written by dashboard/auth.js at start-up to dashboard-token.txt.
  try {
    const tokenPath = resolve(ROOT, "dashboard-token.txt");
    if (!existsSync(tokenPath)) return null;
    return readFileSync(tokenPath, "utf-8").trim() || null;
  } catch { return null; }
}

function safeRead(fpath, fallback) {
  try {
    if (!existsSync(fpath)) return fallback;
    return JSON.parse(readFileSync(fpath, 'utf-8'));
  } catch { return fallback; }
}

// File-stat memoization. `closed-positions-archive.json` can grow into
// the megabytes and the monitor re-renders every second — parsing it
// per-tick is wasteful. We re-parse only when mtime changes.
import { statSync } from 'fs';
const _readCache = new Map(); // fpath → { mtimeMs, value }

function safeReadCached(fpath, fallback) {
  try {
    if (!existsSync(fpath)) return fallback;
    const st = statSync(fpath);
    const hit = _readCache.get(fpath);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
    const value = JSON.parse(readFileSync(fpath, 'utf-8'));
    _readCache.set(fpath, { mtimeMs: st.mtimeMs, value });
    return value;
  } catch { return fallback; }
}

// ── Demo-redirect awareness ──
// Isolated in demo/: positions (state.json), session (trading-plan.json), and
// simulated execution telemetry (execution-quality.json). All learning stores
// (lessons, conviction, regime-memory, etc.) are shared between demo and live
// so data accumulated in demo is immediately usable when switching to live.
// Mirrors runtime-mode.js PAPER_REDIRECT_STORES.
const REDIRECTED_STORES = new Set([
  'state.json', 'trading-plan.json', 'execution-quality.json',
]);

function isPaperMode(config) {
  const mode = String(config?.executionMode || '').toLowerCase();
  const demo = mode === 'demo' || mode === 'dry' || mode === 'dry-run' || config?.dryRun === true;
  if (!demo) return false;
  return config?.paperTrading !== false; // default ON in demo
}

// Resolve a store filename to its real path, honoring the demo/ redirect.
function storePath(name, paper) {
  return (paper && REDIRECTED_STORES.has(name))
    ? resolve(ROOT, 'demo', name)
    : resolve(ROOT, name);
}

// ── WebSocket connect ──
export async function connectWebSocket(port = 3000) {
  if (_ws || _stopped) return;

  try {
    // Pass the dashboard auth token as ?token=… so the server's
    // validateTokenWs check passes. Without it, the connection is
    // closed with code 4001 and the monitor silently falls back to
    // file polling (with "FILE" instead of "LIVE" in the header).
    const token = readDashboardToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `ws://127.0.0.1:${port}${qs}`;
    const WS = (await import('ws')).default;
    const sock = new WS(url);

    sock.on('open', () => {
      _connected = true;
      _reconnectAttempt = 0;
      bus.emit('connected');
    });

    sock.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state' && msg.data) {
          _state = msg.data;
          bus.emit('state', _state);
        } else if (msg.type === 'log' && msg.data) {
          const line = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
          _logs.push(line);
          if (_logs.length > MAX_LOGS) _logs = _logs.slice(-MAX_LOGS);
          bus.emit('log', line);
        }
      } catch {}
    });

    sock.on('close', () => {
      _connected = false;
      _ws = null;
      bus.emit('disconnected');
      scheduleReconnect(port);
    });

    sock.on('error', () => {
      _connected = false;
      try { sock.close?.(); } catch {}
      // 'close' handler will null _ws and schedule reconnect — don't do
      // it twice here, or we end up with two pending reconnect timers.
    });

    _ws = sock;
  } catch {
    // ws package not available — stay on file fallback
    scheduleReconnect(port);
  }
}

function scheduleReconnect(port) {
  if (_stopped || _reconnectTimer) return;
  // Exponential backoff: 1s, 2s, 4s, … capped at 60s.
  const delay = Math.min(1000 * 2 ** _reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  _reconnectAttempt += 1;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connectWebSocket(port);
  }, delay);
  // Don't keep node alive solely for the reconnect timer.
  _reconnectTimer.unref?.();
}

export function disconnectWebSocket() {
  _stopped = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  _connected = false;
}

export function isConnected() { return _connected; }
export function getLogs() { return [..._logs]; }

// ── File-based state reader (fallback + supplementary data) ──
export function readPonyouState() {
  // If we have live WS state, use it as base
  const ws = _state;

  // Supplement with file data that WS may not include
  const config = safeRead(resolve(ROOT, 'user-config.json'), {});
  const paper = isPaperMode(config); // demo → read the isolated demo/ stores
  const metrics = safeRead(resolve(ROOT, 'metrics.json'), {});
  const marketIntel = safeRead(resolve(ROOT, 'market-heatmap-state.json'), {});
  const smartWalletsRaw = safeReadCached(storePath('smart-wallets.json', false), {});
  // smart-wallets.json is an OBJECT keyed by address — normalize to an array.
  const smartWallets = Array.isArray(smartWalletsRaw)
    ? smartWalletsRaw
    : Object.entries(smartWalletsRaw || {}).map(([address, w]) => ({ address, ...(w || {}) }));
  const lessons = safeReadCached(storePath('lessons.json', paper), []);
  const regimeMemory = safeRead(storePath('regime-memory.json', paper), {});
  const executionQuality = safeRead(storePath('execution-quality.json', paper), {});
  // Closed positions archive can be many MB; cache by mtime so we don't
  // re-parse on every 1s render.
  const closedPositions = safeReadCached(resolve(ROOT, 'closed-positions-archive.json'), []);
  const automationState = safeRead(resolve(ROOT, 'automation-state.json'), {});
  const conviction = safeRead(storePath('coin-conviction.json', paper), {});
  const lastReport = safeRead(resolve(ROOT, 'last-report.json'), {});
  const narrative = safeRead(resolve(ROOT, 'narrative-velocity.json'), {});
  const activeStrategy = safeRead(resolve(ROOT, 'active-strategy.json'), {});
  // Social/Telegram hunter signals (source: telegram=channel calls, reddit,
  // coingecko, dexscreener, discord, nitter). Written by social-hunter.js +
  // telegram-user-client.js call handler. Not redirected (market data).
  const socialCache = safeReadCached(resolve(ROOT, 'social-signals.json'), {});
  const socialSignals = (Array.isArray(socialCache?.signals) ? socialCache.signals : [])
    .map(s => ({
      symbol: s.symbol || '?',
      source: s.source || 'social',
      score: s.socialScore ?? 0,
      mentions: s.mentions ?? 0,
      mint: s.mint || null,
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  // "Observed tokens" — observed-tokens.json is dead (nothing writes it). Derive
  // the recent-tokens panel from the live conviction corpus instead.
  const observedTokens = Object.entries(conviction.coins || {})
    .map(([mint, c]) => ({
      symbol: (c.symbol || mint).slice(0, 8),
      mint,
      score: Math.round(c.conviction_score ?? c.score ?? 0),
      seen: c.observations ?? c.times_seen ?? 0,
      lastSeen: c.last_seen || c.updated_at || null,
    }))
    .sort((a, b) => (new Date(b.lastSeen || 0)) - (new Date(a.lastSeen || 0)));

  // Positions from WS or file state
  const wsPositions = ws.positions || [];
  const fileState = safeRead(storePath('state.json', paper), {});
  // Schema (state.js trackPosition): key off `closed` (boolean, NOT `status`),
  // mint is `position`, symbol in signal_snapshot/pool_name, size is amount_sol,
  // pnl is peak_pnl_pct, age derived from deployed_at.
  const filePositions = Object.entries(fileState.positions || {})
    .filter(([, v]) => v && !v.closed)
    .map(([k, v]) => ({
      sym: (v.signal_snapshot?.symbol || v.pool_name || v.symbol || v.position || k).slice(0, 8),
      side: 'BUY',
      entry: v.signal_snapshot?.entry_price || 0,
      current: 0,
      pnlPct: v.peak_pnl_pct || 0,
      size: v.amount_sol || 0,
      risk: (v.signal_snapshot?.rug_score >= 60 ? 'HIGH' : v.signal_snapshot?.rug_score >= 30 ? 'MED' : 'LOW'),
      age: v.deployed_at
        ? Math.round((Date.now() - new Date(v.deployed_at).getTime()) / 60000) + 'm'
        : '--',
    }));

  const openPositions = wsPositions.length > 0
    ? wsPositions.map(p => ({
        sym: (p.symbol || '?').slice(0, 8),
        side: 'BUY',
        entry: p.entry_sol || 0,
        current: 0,
        pnlPct: p.pnl_pct || 0,
        size: p.entry_sol || 0,
        risk: 'MED',
        age: (p.hold_minutes || 0) + 'm',
      }))
    : filePositions;

  const balance = ws.balance_sol ?? fileState.balance_sol ?? config.walletBalance ?? 0;
  const solPrice = ws.sol_price ?? fileState.sol_price ?? marketIntel.solPrice ?? 0;

  return {
    agentName: config.agentName || 'ponyou-agent',
    mode: config.executionMode || 'demo',
    paper, // paper-trading active (virtual balance + demo/ isolated stores)
    strategy: config.strategy || 'scalping',
    network: 'Solana',
    balance,
    solPrice,
    openPositions: openPositions.length,
    openPositionsList: openPositions,
    winRate: ws.win_rate ?? metrics.winRate ?? 0,
    dailyPnl: ws.pnl_today_usd ?? metrics.dailyPnl ?? 0,
    totalSwaps: metrics.totalSwaps || 0,
    riskLevel: 'MEDIUM',
    uptime: process.uptime(),
    rpcStatus: _connected ? 'WS' : 'FILE',
    dexStatus: 'OK',
    walletStatus: config.walletAddress ? 'connected' : 'disabled',
    scanRate: metrics.scansPerMinute || 0,
    watchlistCount: smartWallets.length || 0,
    signalCount: metrics.signalsToday || socialSignals.length || 0,
    nextScanSec: 8,
    version: '2.0.0',
    sessionId: (fileState.sessionId || '').slice(0, 12),

    // Features from WS or config
    features: (ws.features && typeof ws.features === 'object' && !Array.isArray(ws.features) && Object.keys(ws.features).length > 0)
      ? ws.features
      : {
          vaultSweep: !!config.vaultSweepEnabled,
          tradingPlan: !!config.tradingPlanEnabled,
          dailyGuard: !!config.dailyGuardEnabled,
          confirmMode: !!config.confirmMode,
          trashFilter: !!config.trashFilterEnabled,
          devBlacklist: true,
          stagedEntry: !!config.stagedEntryEnabled,
          dayPhaseScreener: !!config.dayPhaseScreenerEnabled,
          strategyEvolution: !!config.strategyEvolutionEnabled,
          copyTrade: !!config.copyTradeEnabled,
        },

    // Supplementary data
    observedTokens: (Array.isArray(observedTokens) ? observedTokens : []).slice(0, 10),
    recentTokens: (Array.isArray(observedTokens) ? observedTokens : []).slice(0, 6),
    smartWallets: (Array.isArray(smartWallets) ? smartWallets : []).slice(0, 20),
    socialSignals: socialSignals.slice(0, 12), // hunters-social + telegram/discord calls
    // Telegram user-client status (live via WS; file mode only knows bot polling).
    telegram: ws.telegram || { enabled: false, connected: false, bot_polling: !!automationState.telegramPolling },
    lessons: (Array.isArray(lessons) ? lessons : []).slice(-5),
    regimeMemory,
    marketIntel,
    closedPositions: Array.isArray(closedPositions) ? closedPositions.slice(-10) : [],

    // Raw refs
    config,
    metrics,
    state: fileState,
    executionQuality,

    // ── Internal activity data ──
    automationState: {
      active: automationState.automationActive ?? false,
      cronStarted: automationState.cronStarted ?? false,
      telegramPolling: automationState.telegramPolling ?? false,
      qualified: automationState.qualified ?? false,
      progressPct: automationState.qualificationSummary?.progressPct ?? 0,
      qualSummary: automationState.qualificationSummary?.summary ?? {},
      qualFailed: (automationState.qualificationSummary?.failed ?? []).slice(0, 4),
      source: automationState.source || '--',
      updatedAt: automationState.updatedAt || null,
    },
    executionRoutes: Object.values(executionQuality.routes || {}).slice(0, 5),
    regimeStats: Object.values(regimeMemory.regimes || {}).slice(0, 4),
    convictionCoins: Object.values(conviction.coins || {})
      .sort((a, b) => (b.win_count || 0) - (a.win_count || 0))
      .slice(0, 5),
    lastReport: {
      date: lastReport.date || '--',
      pnlPct: lastReport.summary?.pnl_pct ?? 0,
      trades: lastReport.summary?.trades ?? 0,
      winRate: lastReport.summary?.win_rate ?? 0,
      market: lastReport.summary?.market || '--',
    },
    narrativeVelocity: narrative,
    activeStrategy: activeStrategy,
    cycleMetrics: {
      mgmtMeanMs: metrics.series?.management_cycle_ms?.mean ?? 0,
      mgmtCount: metrics.series?.management_cycle_ms?.count ?? 0,
      scanMeanMs: metrics.series?.screening_cycle_ms?.mean ?? 0,
      scanCount: metrics.series?.screening_cycle_ms?.count ?? 0,
    },
  };
}

// ── Tools registry ──
//
// Reports tool *availability* (file exists on disk) and a *liveness hint*
// when we can derive one from WS-broadcast state. Status values:
//   READY    — file exists, bot is alive and we have no negative signal
//   DOWN     — file is missing on disk
//   OFFLINE  — no WS connection (file polling only; can't probe liveness)
//   RATE_LIMIT — WS state surfaced a 429/rate-limit flag for this module
//
// This is best-effort — we don't crawl process internals; we read what
// the bot publishes via dashboard state. Each tool entry is rooted at
// the project root (or `tools/` for files under that subdir).
export function getPonyouTools() {
  const ROOT_FILES = [
    { name: 'token_scanner',    file: 'tools/day-phase-screener.js' },
    { name: 'dex_pair_watcher', file: 'tools/dexscreener.js' },
    { name: 'wallet_tracker',   file: 'smart-wallets.js' },
    { name: 'signal_parser',    file: 'signal-aggregator.js' },
    { name: 'rug_check',        file: 'tools/rug-anomaly.js' },
    { name: 'volume_analyzer',  file: 'execution-quality-memory.js' },
    { name: 'holder_analyzer',  file: 'holder-memory.js' },
    { name: 'pnl_tracker',      file: 'tools/sell-simulator.js' },
    { name: 'narrative_detector', file: 'narrative-contagion.js' },
    { name: 'launch_monitor',   file: 'tools/onchain-listener.js' },
    { name: 'position_limits',  file: 'tools/position-limits.js' },
    { name: 'staged_entry',     file: 'tools/staged-entry.js' },
    { name: 'jupiter_quote',    file: 'tools/jupiter.js' },
    { name: 'coingecko_enrich', file: 'market-intelligence.js' },
    { name: 'dev_blacklist',    file: 'dev-blacklist.js' },
  ];
  const wsFeatures = (_state && _state.features) || {};
  const wsRateLimited = new Set(Array.isArray(_state?.rate_limited) ? _state.rate_limited : []);
  return ROOT_FILES.map(t => {
    const abs = resolve(ROOT, t.file);
    if (!existsSync(abs)) return { ...t, status: 'DOWN' };
    if (wsRateLimited.has(t.name)) return { ...t, status: 'RATE_LIMIT' };
    // If the bot is publishing features and explicitly disables this one,
    // surface as OFFLINE instead of READY.
    const explicit = wsFeatures[t.name];
    if (explicit === false) return { ...t, status: 'OFFLINE' };
    return { ...t, status: _connected ? 'READY' : 'OFFLINE' };
  });
}
