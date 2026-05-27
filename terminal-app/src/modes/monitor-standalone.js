#!/usr/bin/env node
// Ponyou Monitor — professional TUI  (GMGN/Trojan-style)

import blessed from 'blessed';
import { connectWebSocket, disconnectWebSocket, getLogs, readPonyouState, bus } from '../data/state-bridge.js';

// ── Screen ──
const screen = blessed.screen({
  smartCSR: true, title: 'PONYOU', fullUnicode: true,
  dockBorders: true, autoPadding: false,
  grabKeys: true,
});

// ── Style ──
const BORDER = { type: 'line', fg: '#777777' };
const STYLE  = { fg: 'white', border: { fg: '#777777' }, label: { fg: 'yellow' } };

connectWebSocket(3000);

// ── Dimensions (re-read on every resize) ──
function getDims() {
  const rows = process.stdout.rows  || screen.rows || 24;
  const cols  = process.stdout.columns || screen.cols || 80;
  const HDR = 4, FTR = 1;
  const MAIN_TOP = HDR;
  const MAIN_H   = Math.max(rows - HDR - FTR, 4);
  const LW  = Math.floor(cols * 0.24);
  const RW  = Math.floor(cols * 0.26);
  const CW  = Math.max(cols - LW - RW, 4);
  const L_P   = 8;
  const L_POS = Math.max(Math.floor(MAIN_H * 0.30), 2);
  const L_E   = Math.max(MAIN_H - L_P - L_POS, 2);
  return { rows, cols, HDR, FTR, MAIN_TOP, MAIN_H, LW, RW, CW, L_P, L_POS, L_E };
}

let D = getDims();

// ── State ──
let paused = false;
let logFilter = 'all';
let wsConnected = false;
let logLines = [];
let tickCount = 0;

bus.on('log', (line) => {
  if (paused) return;
  logLines.push(parseLine(line));
  if (logLines.length > 400) logLines = logLines.slice(-400);
});
bus.on('connected',    () => { wsConnected = true; });
bus.on('disconnected', () => { wsConnected = false; });

const buffered = getLogs();
if (buffered.length) logLines = buffered.map(parseLine);

function parseLine(raw) {
  const t = new Date().toTimeString().slice(0, 8);
  const m = raw.match(/^\[(\w[\w_]*)\]/);
  const TAG_MAP = {
    TRASH_FILTER: ['SCAN',   'trash'],
    LEARNING:     ['SYS',    'learn'],
    CRON:         ['SYS',    'cron'],
    PLAN_WARN:    ['WARN',   'plan'],
    POSITION:     ['TRADE',  'pos'],
    RUG_CHECK:    ['RISK',   'rug'],
    SIGNAL:       ['SIG',    'signal'],
    DEX:          ['DEX',    'jup'],
    TRADE:        ['TRADE',  'exec'],
    ERROR:        ['ERR',    'core'],
    WARN:         ['WARN',   'core'],
    SCAN:         ['SCAN',   'scan'],
    BUY:          ['TRADE',  'buy'],
    SELL:         ['TRADE',  'sell'],
    VAULT:        ['SYS',    'vault'],
    REGIME:       ['SYS',    'regime'],
    STRATEGY:     ['SYS',    'strat'],
  };
  let level = 'INFO', mod = 'core', msg = raw;
  if (m) {
    const k = m[1].toUpperCase();
    const mapped = TAG_MAP[k] || [k.slice(0, 5), k.toLowerCase().slice(0, 8)];
    level = mapped[0]; mod = mapped[1];
    msg = raw.slice(m[0].length).trim();
  }
  return { t, level, mod, msg: msg.slice(0, 110) };
}

// ── Helpers ──
function pad(s, n) { const str = String(s ?? ''); return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length); }
function rpad(s, n) { const str = String(s ?? ''); return str.length >= n ? str.slice(0, n) : ' '.repeat(n - str.length) + str; }
function pct(v) { const n = Number(v) || 0; return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
function fmtNum(n) {
  if (!n || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
function fmtAge(ms) {
  if (!ms) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
}
function uptime(sec) {
  if (!sec) return '0m';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}
function dot(ok) { return ok ? '{green-fg}●{/green-fg}' : '{#444444-fg}○{/#444444-fg}'; }
function lc(c) { return `{${c}-fg}`; }
function lce(c) { return `{/${c}-fg}`; }
function pnlColor(v) { return Number(v) >= 0 ? 'green' : 'red'; }

// ── Widget factory ──
function box(opts) {
  const w = blessed.box({
    border: BORDER,
    style: { ...STYLE },
    tags: true, scrollable: opts.scrollable || false,
    alwaysScroll: opts.alwaysScroll || false,
    keys: opts.keys || false, vi: opts.vi || false,
    mouse: opts.mouse || false,
    ...opts,
  });
  screen.append(w);
  return w;
}

// ── Widgets ──
const wHeader = blessed.box({ top: 0, left: 0, width: D.cols, height: D.HDR,
  tags: true, style: { fg: 'white', bg: 'default' } });
screen.append(wHeader);

const wPortfolio = box({ top: D.MAIN_TOP, left: 0, width: D.LW, height: D.L_P,
  label: ' portfolio ' });
const wPositions = box({ top: D.MAIN_TOP + D.L_P, left: 0, width: D.LW, height: D.L_POS,
  label: ' positions ', scrollable: true, keys: true, vi: true });
const wEngine = box({ top: D.MAIN_TOP + D.L_P + D.L_POS, left: 0, width: D.LW, height: D.L_E,
  label: ' engine ', scrollable: true, keys: true, vi: true });

const wActivity = box({ top: D.MAIN_TOP, left: D.LW, width: D.CW, height: D.MAIN_H,
  label: ' activity ', scrollable: true, alwaysScroll: true,
  keys: true, vi: true, mouse: true });

const wRight = box({ top: D.MAIN_TOP, left: D.LW + D.CW, width: D.RW, height: D.MAIN_H,
  label: ' market·tokens·perf ', scrollable: true, alwaysScroll: false, keys: true, vi: true });

const wFooter = blessed.box({ top: D.rows - D.FTR, left: 0, width: D.cols, height: D.FTR,
  tags: true, style: { fg: 'gray' } });
screen.append(wFooter);

// ── Render ──
function render() {
  tickCount++;
  const s = readPonyouState();

  // ── Header ──
  const wsTag   = wsConnected ? '{green-fg}LIVE{/green-fg}' : '{#555555-fg}FILE{/#555555-fg}';
  const modeTag = s.mode === 'live'  ? '{green-fg}LIVE{/green-fg}' :
                  s.mode === 'paper' ? '{yellow-fg}PAPER{/yellow-fg}' :
                                       '{#888888-fg}DEMO{/#888888-fg}';
  const solTag  = s.solPrice > 0 ? `{white-fg}$${s.solPrice.toFixed(2)}{/white-fg}` : '{#888888-fg}--{/#888888-fg}';
  const walletStr = s.config.walletAddress
    ? s.config.walletAddress.slice(0, 6) + '…' + s.config.walletAddress.slice(-4)
    : 'not set';
  wHeader.setContent([
    `  {yellow-fg}╔═╗ ╔═╗ ╔╗╔ ╦ ╦ ╔═╗ ╦ ╦   ╔═╗ ╔═╗ ╔═╗ ╔╗╔ ╔╦╗{/yellow-fg}`,
    `  {yellow-fg}╠═╝ ║ ║ ║║║ ╚╦╝ ║ ║ ║ ║   ╠═╣ ║ ╦ ║╣  ║║║  ║ {/yellow-fg}`,
    `  {yellow-fg}╩   ╚═╝ ╝╚╝  ╩  ╚═╝ ╚═╝   ╩ ╩ ╚═╝ ╚═╝ ╝╚╝  ╩ {/yellow-fg}`,
    `  ${modeTag}  {#555555-fg}·{/#555555-fg}  SOL ${solTag}  {#555555-fg}·{/#555555-fg}  {white-fg}↑ ${uptime(s.uptime)}{/white-fg}  {#555555-fg}·{/#555555-fg}  ${wsTag}  {#555555-fg}·{/#555555-fg}  {#666666-fg}${s.sessionId || 'new'}  ·  ${walletStr}{/#666666-fg}`,
  ].join('\n'));

  // ── Portfolio ──
  const balC = s.balance > 0 ? 'white' : '#555555';
  const pnlV = s.dailyPnl, pnlC = pnlColor(pnlV);
  const wrC  = s.winRate >= 0.55 ? 'green' : s.winRate >= 0.4 ? 'yellow' : 'red';
  wPortfolio.setContent([
    `  {#555555-fg}balance{/#555555-fg}  ${lc(balC)}${s.balance.toFixed(4)} SOL${lce(balC)}`,
    `  {#555555-fg}daily   {/#555555-fg}  ${lc(pnlC)}${pct(pnlV)} SOL${lce(pnlC)}`,
    `  {#555555-fg}win     {/#555555-fg}  ${lc(wrC)}${(s.winRate * 100).toFixed(1)}%${lce(wrC)}`,
    `  {#555555-fg}pos     {/#555555-fg}  {white-fg}${s.openPositions}{/white-fg}  {#555555-fg}open{/#555555-fg}`,
    `  {#555555-fg}signals {/#555555-fg}  {white-fg}${s.signalCount}{/white-fg}`,
    `  {#555555-fg}watched {/#555555-fg}  {white-fg}${s.watchlistCount}{/white-fg}`,
  ].join('\n'));

  // ── Positions ──
  const pos = s.openPositionsList;
  if (pos.length === 0) {
    const closed = s.closedPositions.slice(-6);
    if (closed.length > 0) {
      const lines = [`  {yellow-fg}no open   recent closed{/yellow-fg}`, ``];
      closed.forEach(p => {
        const v = p.pnl_pct || p.pnlPct || 0;
        const c = pnlColor(v);
        lines.push(`  {#555555-fg}${pad((p.symbol || '?').slice(0, 7), 8)}{/#555555-fg}${lc(c)}${pct(v)}${lce(c)}`);
      });
      wPositions.setContent(lines.join('\n'));
    } else {
      wPositions.setContent(`\n  {#444444-fg}no open positions{/#444444-fg}`);
    }
  } else {
    const hdr = `  {white-fg}${pad('sym', 8)} ${rpad('entry', 9)}  ${rpad('pnl', 8)}  ${pad('size', 7)}  age{/white-fg}`;
    const rows = pos.map(p => {
      const pC = pnlColor(p.pnlPct);
      return `  {white-fg}${pad(p.sym, 8)}{/white-fg} {#555555-fg}${rpad(p.entry ? p.entry.toFixed(4) : '--', 9)}{/#555555-fg}  ${lc(pC)}${rpad(pct(p.pnlPct), 8)}${lce(pC)}  {#666666-fg}${pad(p.size.toFixed(3), 7)}  ${p.age}{/#666666-fg}`;
    });
    wPositions.setContent(hdr + '\n' + rows.join('\n'));
  }

  // ── Engine + Features ──
  const strat = s.activeStrategy?.name || s.strategy || '--';
  const regime = s.marketIntel.regime || s.marketIntel.condition || 'NORMAL';
  const regC = regime === 'HOT' ? 'yellow' : regime === 'RISK_OFF' ? 'red' : 'green';
  const condC = s.marketIntel.condition === 'HOT' ? 'yellow' : 'green';
  const evolOn = s.features.strategyEvolution || s.features.strategy_evolution_enabled;
  const aut = s.automationState;
  const qualPct = aut.progressPct || 0;
  const barLen = 14;
  const filled = Math.floor(qualPct / 100 * barLen);
  const qualBar = '{green-fg}' + '█'.repeat(filled) + '{/green-fg}' + '{#333333-fg}' + '░'.repeat(barLen - filled) + '{/#333333-fg}';

  const engLines = [
    `  {yellow-fg}strategy{/yellow-fg}`,
    `  {#555555-fg}mode    {/#555555-fg}{white-fg}${strat}{/white-fg}`,
    `  {#555555-fg}regime  {/#555555-fg}${lc(regC)}${regime}${lce(regC)}`,
    `  {#555555-fg}evolve  {/#555555-fg}${dot(evolOn)}  ${lc('cyan')}${s.cycleMetrics.mgmtCount}{/cyan-fg} {#444444-fg}cycles{/#444444-fg}`,
    ``,
    `  {yellow-fg}automation{/yellow-fg}`,
    `  {#555555-fg}cron    {/#555555-fg}${dot(aut.cronStarted)}  {#555555-fg}tg  {/#555555-fg}${dot(aut.telegramPolling)}`,
    `  {#555555-fg}active  {/#555555-fg}${dot(aut.active)}  {#555555-fg}qual{/#555555-fg}${dot(aut.qualified)}`,
    `  {#555555-fg}progress{/#555555-fg}  ${qualBar} {#555555-fg}${qualPct.toFixed(0)}%{/#555555-fg}`,
    ``,
    `  {yellow-fg}features{/yellow-fg}`,
  ];

  const feat = s.features;
  const featureRows = [
    ['rug_check',   feat.rug_check_enabled    ?? feat.rugCheck ?? true],
    ['trash_filter',feat.trash_filter_enabled ?? feat.trashFilter ?? true],
    ['staged_entry',feat.staged_entry_enabled ?? feat.stagedEntry ?? false],
    ['day_phase',   feat.day_phase_enabled    ?? feat.dayPhaseScreener ?? false],
    ['vault',       feat.vault_enabled        ?? feat.vaultSweep ?? false],
    ['copy_trade',  feat.copy_trade_enabled   ?? feat.copyTrade ?? false],
    ['daily_guard', feat.daily_guard_enabled  ?? feat.dailyGuard ?? false],
    ['confirm',     feat.confirm_mode         ?? feat.confirmMode ?? false],
    ['dev_blacklist',feat.dev_blacklist_enabled ?? feat.devBlacklist ?? true],
    ['darwin',      feat.darwin_enabled       ?? false],
  ];

  const fRows = [];
  for (let i = 0; i < featureRows.length; i += 2) {
    const [n1, v1] = featureRows[i];
    const [n2, v2] = featureRows[i + 1] || ['', null];
    const r1 = `${dot(v1)} {#555555-fg}${pad(n1, 12)}{/#555555-fg}`;
    const r2 = n2 ? `  ${dot(v2)} {#555555-fg}${n2}{/#555555-fg}` : '';
    fRows.push(`  ${r1}${r2}`);
  }
  wEngine.setContent([...engLines, ...fRows].join('\n'));

  // ── Activity Feed ──
  const filtered = logFilter === 'all'
    ? logLines
    : logLines.filter(l => l.level === logFilter.toUpperCase());

  const lvlColor = {
    INFO: 'white', SCAN: 'cyan', SIG: 'yellow', TRADE: '#aa55ff',
    RISK: 'red', WARN: 'yellow', ERR: 'red', SYS: 'green',
    TOOL: '#4488ff', DEX: 'cyan', WALLET: 'green', BUY: 'green',
    SELL: 'red',
  };
  const actLabel = paused ? ' activity · {red-fg}PAUSED{/red-fg} ' :
    logFilter === 'all' ? ' activity ' : ` activity · ${logFilter.toLowerCase()} `;
  wActivity.setLabel({ text: actLabel, side: 'left' });
  wActivity.setContent(filtered.slice(-80).map(l => {
    const c = lvlColor[l.level] || '#555555';
    const timeStr = `{gray-fg}${l.t}{/gray-fg}`;
    const lvlStr  = `{${c}-fg}${pad(l.level, 5)}{/${c}-fg}`;
    const modStr  = `{gray-fg}${pad(l.mod, 10)}{/gray-fg}`;
    const msgStr  = `{white-fg}${l.msg}{/white-fg}`;
    return ` ${timeStr} ${lvlStr} ${modStr} ${msgStr}`;
  }).join('\n'));
  if (!paused) wActivity.setScrollPerc(100);

  // ── Right Panel (market · tokens · internal, elegant separators) ──
  const tokens   = s.observedTokens.length > 0 ? s.observedTokens : s.recentTokens;
  const hasTokens = tokens.length > 0;
  const rpcC     = wsConnected ? 'green' : '#555555';
  const regimes  = s.regimeStats;
  const aq       = s.executionQuality;
  const winRate  = aq.win_rate != null ? (aq.win_rate * 100).toFixed(1) + '%' : '--';
  const cycMgmt  = s.cycleMetrics.mgmtMeanMs > 0 ? s.cycleMetrics.mgmtMeanMs.toFixed(0) + 'ms' : '--';
  const cycScan  = s.cycleMetrics.scanMeanMs > 0  ? s.cycleMetrics.scanMeanMs.toFixed(0)  + 'ms' : '--';
  const lr       = s.lastReport;

  const routes    = s.executionRoutes;
  const routeLines = routes.length > 0
    ? routes.map(r => {
        const sr = r.attempts > 0 ? ((r.successes / r.attempts) * 100).toFixed(0) : '0';
        const rC2 = parseInt(sr) >= 80 ? 'green' : parseInt(sr) >= 50 ? 'yellow' : 'red';
        return `  {#555555-fg}${pad((r.provider || r.wallet_address || '?').slice(0, 7), 7)}{/#555555-fg} ${lc(rC2)}${sr}%${lce(rC2)} {#333333-fg}${r.attempts}tx{/#333333-fg}`;
      })
    : [`  {#333333-fg}no route data{/#333333-fg}`];

  const coinLines = s.convictionCoins.slice(0, 3).map(c => {
    const wr = c.win_count + c.loss_count > 0
      ? ((c.win_count / (c.win_count + c.loss_count)) * 100).toFixed(0) + '%' : '--';
    const wrC2 = parseInt(wr) >= 60 ? 'green' : parseInt(wr) >= 40 ? 'yellow' : 'red';
    return `  {#555555-fg}${pad((c.symbol || '?').slice(0, 7), 8)}{/#555555-fg}${lc(wrC2)}${wr}${lce(wrC2)} {#333333-fg}${c.win_count}W/${c.loss_count}L{/#333333-fg}`;
  });

  const lessons    = s.lessons;
  const lastLesson = lessons.length > 0
    ? (lessons[lessons.length - 1].lesson || lessons[lessons.length - 1].text || '').slice(0, 40)
    : null;

  // Solid separator — full ─ line matching panel width
  const SEP = ` {#555555-fg}${'─'.repeat(Math.max(4, D.RW - 3))}{/#555555-fg}`;

  const rightContent = [
    // ── market ──
    `  {yellow-fg}market{/yellow-fg}`,
    `  {#555555-fg}SOL    {/#555555-fg}{white-fg}$${s.solPrice > 0 ? s.solPrice.toFixed(2) : '--'}{/white-fg}`,
    `  {#555555-fg}regime {/#555555-fg}${lc(regC)}${regime}${lce(regC)}`,
    `  {#555555-fg}RPC    {/#555555-fg}${lc(rpcC)}${s.rpcStatus}${lce(rpcC)}  {#555555-fg}DEX {/#555555-fg}{green-fg}${s.dexStatus}{/green-fg}`,
    `  {#555555-fg}scan/s {/#555555-fg}{white-fg}${s.scanRate || '--'}{/white-fg}`,
    ``,
    ...(regimes.length > 0
      ? [`  {yellow-fg}regimes{/yellow-fg}`,
         ...regimes.map(r => `  {#555555-fg}${pad((r.market_condition || '?').slice(0, 4), 4)}{/#555555-fg} {#444444-fg}│{/#444444-fg} {white-fg}${r.verdict || '--'}{/white-fg} {#333333-fg}${r.trade_count || 0}tx{/#333333-fg}`)]
      : [`  {#333333-fg}no regime history{/#333333-fg}`]),
    ``,
    SEP,
    ``,
    // ── tokens ──
    `  {yellow-fg}tokens{/yellow-fg}`,
    ...(hasTokens
      ? [`  {white-fg}${pad('sym', 7)} ${rpad('scr', 4)} ${rpad('liq', 8)} ${rpad('vol', 8)} ${rpad('mc', 8)}{/white-fg}`,
         ...tokens.slice(0, 12).map(t => {
           const sym   = (t.symbol || t.ticker || '?').slice(0, 6);
           const score = t.score || t.quality_score || 0;
           const sC    = score >= 70 ? 'green' : score >= 40 ? 'yellow' : 'red';
           return `  {white-fg}${pad(sym, 7)}{/white-fg} ${lc(sC)}${rpad(score, 4)}${lce(sC)} {#555555-fg}${rpad(fmtNum(t.liquidity || t.liq), 8)} ${rpad(fmtNum(t.volume24h || t.vol), 8)} ${rpad(fmtNum(t.marketCap || t.mcap || t.mc), 8)}{/#555555-fg}`;
         })]
      : [`  {#444444-fg}no token data{/#444444-fg}`, `  {#333333-fg}start bot to populate{/#333333-fg}`]),
    ``,
    SEP,
    ``,
    // ── internal / performance ──
    `  {yellow-fg}performance{/yellow-fg}`,
    `  {#555555-fg}win rate{/#555555-fg}  {white-fg}${winRate}{/white-fg}`,
    `  {#555555-fg}mgmt    {/#555555-fg}  {#666666-fg}${cycMgmt}{/#666666-fg}  {#555555-fg}scan{/#555555-fg}  {#666666-fg}${cycScan}{/#666666-fg}`,
    `  {#555555-fg}report  {/#555555-fg}  {#444444-fg}${lr.date}  ${lr.trades}tx  ${lr.market}{/#444444-fg}`,
    ``,
    `  {yellow-fg}exec routes{/yellow-fg}`,
    ...routeLines,
    ...(coinLines.length > 0 ? [``, `  {yellow-fg}conviction{/yellow-fg}`, ...coinLines] : []),
    ...(lastLesson ? [``, `  {yellow-fg}last lesson{/yellow-fg}`, `  {#888888-fg}${lastLesson}{/#888888-fg}`] : []),
  ];
  wRight.setContent(rightContent.join('\n'));

  // ── Footer ──
  const fp = s.dailyPnl >= 0 ? '+' : '';
  const filterHint = logFilter === 'all' ? '' : ` [${logFilter}]`;
  wFooter.setContent(
    ` {white-fg}SOL $${s.solPrice.toFixed(2)}  ·  ${s.rpcStatus}  ·  ${s.dexStatus}  ·` +
    `  pos ${s.openPositions}  ·  signals ${s.signalCount}  ·  pnl ${fp}${s.dailyPnl.toFixed(2)}SOL` +
    `  ·  [q] quit  [space] pause  [1-5] filter${filterHint}{/white-fg}`
  );

  screen.render();
}

// ── Resize handler ──
screen.on('resize', () => {
  D = getDims();
  wHeader.width = D.cols;

  wPortfolio.width = D.LW; wPortfolio.height = D.L_P;
  wPositions.top   = D.MAIN_TOP + D.L_P;           wPositions.width = D.LW; wPositions.height = D.L_POS;
  wEngine.top      = D.MAIN_TOP + D.L_P + D.L_POS; wEngine.width    = D.LW; wEngine.height    = D.L_E;

  wActivity.top = D.MAIN_TOP; wActivity.left = D.LW; wActivity.width = D.CW; wActivity.height = D.MAIN_H;

  wRight.left = D.LW + D.CW; wRight.width = D.RW; wRight.height = D.MAIN_H;

  wFooter.top = D.rows - D.FTR; wFooter.width = D.cols;

  render();
});

// ── Keyboard ──
let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  clearInterval(renderTimer);
  try { disconnectWebSocket(); } catch {}
  screen.destroy();
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  process.exit(0);
}
screen.key(['q', 'Q'],   quit);
screen.key(['C-c'],      quit);
screen.key(['space'],    () => { paused = !paused; render(); });
screen.key(['1'],        () => { logFilter = 'all';   render(); });
screen.key(['2'],        () => { logFilter = 'SCAN';  render(); });
screen.key(['3'],        () => { logFilter = 'TRADE'; render(); });
screen.key(['4'],        () => { logFilter = 'RISK';  render(); });
screen.key(['5'],        () => { logFilter = 'ERR';   render(); });
screen.key(['tab'],      () => { wActivity.focus(); });
screen.key(['S-tab'],    () => { wRight.focus(); });

// ── Refresh ──
// Primary trigger: WS state/log events push us to re-render immediately.
// Secondary trigger: a 2s heartbeat catches changes from file-only data
// sources (e.g. closed-positions-archive.json) when WS is offline.
let _dirty = false;
function scheduleRender() {
  if (paused || quitting) return;
  if (_dirty) return;
  _dirty = true;
  setImmediate(() => { _dirty = false; render(); });
}
bus.on('state', scheduleRender);
bus.on('log', scheduleRender);
bus.on('connected', scheduleRender);
bus.on('disconnected', scheduleRender);

const renderTimer = setInterval(() => { if (!paused) render(); }, 2000);
render();
wActivity.focus();
