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
const MAX_LOGS = 500;

function safeRead(fpath, fallback) {
  try {
    if (!existsSync(fpath)) return fallback;
    return JSON.parse(readFileSync(fpath, 'utf-8'));
  } catch { return fallback; }
}

// ── WebSocket connect ──
export async function connectWebSocket(port = 3000) {
  if (_ws) return; // already connected

  try {
    // Dynamic import so the module loads even if ws is unavailable
    const url = `ws://127.0.0.1:${port}`;
    const WS = (await import('ws')).default;
    const sock = new WS(url);

    sock.on('open', () => {
      _connected = true;
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
      bus.emit('disconnected');
      // Reconnect after 5s
      setTimeout(() => { _ws = null; connectWebSocket(port); }, 5000);
    });

    sock.on('error', () => {
      _connected = false;
      sock.close?.();
      _ws = null;
    });

    _ws = sock;
  } catch {
    // ws package not available — stay on file fallback
  }
}

export function isConnected() { return _connected; }
export function getLogs() { return [..._logs]; }

// ── File-based state reader (fallback + supplementary data) ──
export function readPonyouState() {
  // If we have live WS state, use it as base
  const ws = _state;

  // Supplement with file data that WS may not include
  const config = safeRead(resolve(ROOT, 'user-config.json'), {});
  const metrics = safeRead(resolve(ROOT, 'metrics.json'), {});
  const marketIntel = safeRead(resolve(ROOT, 'market-heatmap-state.json'), {});
  const observedTokens = safeRead(resolve(ROOT, 'observed-tokens.json'), []);
  const smartWallets = safeRead(resolve(ROOT, 'smart-wallets.json'), []);
  const lessons = safeRead(resolve(ROOT, 'lessons.json'), []);
  const regimeMemory = safeRead(resolve(ROOT, 'regime-memory.json'), {});
  const executionQuality = safeRead(resolve(ROOT, 'execution-quality.json'), {});
  const closedPositions = safeRead(resolve(ROOT, 'closed-positions-archive.json'), []);
  const automationState = safeRead(resolve(ROOT, 'automation-state.json'), {});
  const conviction = safeRead(resolve(ROOT, 'coin-conviction.json'), {});
  const lastReport = safeRead(resolve(ROOT, 'last-report.json'), {});
  const narrative = safeRead(resolve(ROOT, 'narrative-velocity.json'), {});
  const activeStrategy = safeRead(resolve(ROOT, 'active-strategy.json'), {});

  // Positions from WS or file state
  const wsPositions = ws.positions || [];
  const fileState = safeRead(resolve(ROOT, 'state.json'), {});
  const filePositions = Object.entries(fileState.positions || {})
    .filter(([, v]) => v && v.status !== 'closed')
    .map(([k, v]) => ({
      sym: (v.symbol || k).slice(0, 8),
      side: v.side || 'BUY',
      entry: v.entryPrice || 0,
      current: v.currentPrice || v.entryPrice || 0,
      pnlPct: v.pnlPct || 0,
      size: v.sizeSol || v.amountSol || 0,
      risk: v.riskLevel || 'MED',
      age: v.holdDuration || '--',
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
    signalCount: metrics.signalsToday || 0,
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
    recentTokens: (Array.isArray(observedTokens) ? observedTokens : []).slice(-6),
    smartWallets: (Array.isArray(smartWallets) ? smartWallets : []).slice(0, 20),
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
export function getPonyouTools() {
  const tools = [
    { name: 'token_scanner', file: 'day-phase-screener.js', status: 'READY' },
    { name: 'dex_pair_watcher', file: 'dexscreener.js', status: 'READY' },
    { name: 'wallet_tracker', file: 'wallet-discovery.js', status: 'READY' },
    { name: 'signal_parser', file: 'wallet-signal-injector.js', status: 'READY' },
    { name: 'rug_check', file: 'rug-anomaly.js', status: 'READY' },
    { name: 'volume_analyzer', file: 'fee-tracker.js', status: 'READY' },
    { name: 'holder_analyzer', file: 'community-detector.js', status: 'READY' },
    { name: 'pnl_tracker', file: 'sell-simulator.js', status: 'READY' },
    { name: 'narrative_detector', file: 'narratives.js', status: 'READY' },
    { name: 'launch_monitor', file: 'onchain-listener.js', status: 'READY' },
    { name: 'position_limits', file: 'position-limits.js', status: 'READY' },
    { name: 'staged_entry', file: 'staged-entry.js', status: 'READY' },
    { name: 'jupiter_quote', file: 'jupiter.js', status: 'READY' },
    { name: 'coingecko_enrich', file: 'coingecko-enrichment.js', status: 'READY' },
    { name: 'dev_blacklist', file: 'dev-blacklist.js', status: 'READY' },
  ];
  return tools;
}
