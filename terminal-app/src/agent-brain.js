// Ponyou Agent Brain — Claude Code-style chat responses
// Meme-themed ASCII logo + intelligent command processing

import { readPonyouState, getPonyouTools } from './data/state-bridge.js';
import { sendCommand } from './data/command-bridge.js';

// ── Minimal wordmark ──
const LOGO = [
  '',
  '   {yellow}◆ PONYOU{/yellow}  {gray}Solana Memecoin Agent  ·  AI-Powered{/gray}',
  '',
];

const WELCOME_INTRO = [
  '   {gray}I watch memecoins so you don\'t have to.{/gray}',
  '',
  '   {white}▸ Bot status, balance & positions{/white}',
  '   {white}▸ Live monitoring dashboard{/white}',
  '   {white}▸ Trading strategies & risk settings{/white}',
  '   {white}▸ Remote bot control{/white}',
  '',
];

const CMD_LIST = [
  '   {cyan,bold}Modes{/cyan,bold}',
  '   {cyan}/monitor{/cyan}          {gray}live dashboard — logs, chart, alerts{/gray}',
  '   {cyan}/remote{/cyan}           {gray}remote control panel — full features{/gray}',
  '   {cyan}/wizard{/cyan}           {gray}configure bot settings{/gray}',
  '',
  '   {cyan,bold}Status & Data{/cyan,bold}',
  '   {cyan}/status{/cyan}           {gray}bot overview — mode, balance, PnL{/gray}',
  '   {cyan}/positions{/cyan}        {gray}open positions with PnL{/gray}',
  '   {cyan}/history{/cyan}          {gray}recent closed trades{/gray}',
  '   {cyan}/pnl{/cyan}              {gray}PnL breakdown by session{/gray}',
  '   {cyan}/metrics{/cyan}          {gray}performance stats & streaks{/gray}',
  '   {cyan}/config{/cyan}           {gray}current configuration{/gray}',
  '   {cyan}/features{/cyan}         {gray}feature toggles status{/gray}',
  '   {cyan}/tools{/cyan}            {gray}tools health check{/gray}',
  '   {cyan}/strategies{/cyan}       {gray}available strategies{/gray}',
  '   {cyan}/screener{/cyan}         {gray}screened tokens right now{/gray}',
  '   {cyan}/wallets{/cyan}          {gray}smart wallets being tracked{/gray}',
  '   {cyan}/regime{/cyan}           {gray}market regime & conditions{/gray}',
  '   {cyan}/intel{/cyan}            {gray}market intelligence & heatmap{/gray}',
  '   {cyan}/lessons{/cyan}          {gray}AI trading lessons learned{/gray}',
  '   {cyan}/risk{/cyan}             {gray}risk settings & guard status{/gray}',
  '   {cyan}/version{/cyan}          {gray}version, session & uptime{/gray}',
  '',
  '   {cyan,bold}Bot Control{/cyan,bold}',
  '   {cyan}/start{/cyan}            {gray}start the bot{/gray}',
  '   {cyan}/stop{/cyan}             {gray}stop the bot gracefully{/gray}',
  '   {cyan}/pause{/cyan}            {gray}pause trading (keep positions){/gray}',
  '   {cyan}/resume{/cyan}           {gray}resume trading from pause{/gray}',
  '   {cyan}/scan{/cyan}             {gray}trigger manual market scan{/gray}',
  '   {cyan}/sweep{/cyan}            {gray}trigger vault sweep{/gray}',
  '   {cyan}/restart{/cyan}          {gray}restart bot process{/gray}',
  '   {cyan}/strategy <name>{/cyan}  {gray}switch strategy: scalp conservative aggressive sniper{/gray}',
  '   {red}/emergency{/red}          {gray}⚠ close all positions + emergency stop{/gray}',
  '',
  '   {cyan}/cmd <name>{/cyan}       {gray}raw command: start stop pause sweep{/gray}',
  '',
  '   {gray}Or just ask me anything.{/gray}',
];

export function getWelcome() {
  return [...LOGO, ...WELCOME_INTRO, ...CMD_LIST];
}

// ── Remote control panel ──
function remoteResponse() {
  const s = readPonyouState();
  const pnlC = s.dailyPnl >= 0 ? 'green' : 'red';
  const pnlS = s.dailyPnl >= 0 ? '+' : '';
  const modeC = s.mode === 'live' ? 'green' : s.mode === 'paper' ? 'yellow' : 'gray';

  function feat(on) { return on ? '{green}● ON{/green}' : '{gray}○ OFF{/gray}'; }
  const f = s.features || {};

  const tokens = s.observedTokens?.slice(0, 5) || [];
  const tokenLine = tokens.length
    ? tokens.map(t => `{cyan}${(t.symbol || t.mint || '?').slice(0, 8)}{/cyan}`).join('  ')
    : '{gray}none{/gray}';

  return [
    '',
    '  {yellow,bold}◆ PONYOU — Remote Control Panel{/yellow,bold}',
    '  {gray}─────────────────────────────────────────────────────{/gray}',
    '',
    '  {white,bold}Status{/white,bold}',
    `  {gray}Mode{/gray}           {${modeC},bold}${s.mode.toUpperCase()}{/${modeC},bold}   {gray}Strategy{/gray}  {magenta}${s.strategy}{/magenta}`,
    `  {gray}Balance{/gray}        {yellow}${s.balance.toFixed(4)} SOL{/yellow}   {gray}SOL Price{/gray}  $${s.solPrice.toFixed(2)}`,
    `  {gray}Positions{/gray}      {cyan}${s.openPositions} open{/cyan}   {gray}Daily PnL{/gray}  {${pnlC}}${pnlS}${s.dailyPnl.toFixed(4)} SOL{/${pnlC}}`,
    `  {gray}Win Rate{/gray}       {green}${(s.winRate * 100).toFixed(1)}%{/green}   {gray}Swaps{/gray}      {white}${s.totalSwaps}{/white}`,
    `  {gray}Uptime{/gray}         ${Math.floor(s.uptime / 3600)}h ${Math.floor((s.uptime % 3600) / 60)}m   {gray}Signals Today{/gray}  {white}${s.signalCount}{/white}`,
    `  {gray}Connection{/gray}     {green}${s.rpcStatus}{/green}  {gray}DEX{/gray} {green}${s.dexStatus}{/green}  {gray}Wallet{/gray} {green}${s.walletStatus}{/green}`,
    '',
    '  {white,bold}Features{/white,bold}',
    `  {gray}vault_sweep{/gray}      ${feat(f.vaultSweep)}   {gray}daily_guard{/gray}    ${feat(f.dailyGuard)}`,
    `  {gray}trash_filter{/gray}     ${feat(f.trashFilter)}   {gray}confirm_mode{/gray}   ${feat(f.confirmMode)}`,
    `  {gray}staged_entry{/gray}     ${feat(f.stagedEntry)}   {gray}copy_trade{/gray}     ${feat(f.copyTrade)}`,
    `  {gray}strategy_evo{/gray}     ${feat(f.strategyEvolution)}   {gray}day_phase{/gray}      ${feat(f.dayPhaseScreener)}`,
    '',
    '  {white,bold}Market{/white,bold}',
    `  {gray}Regime{/gray}         {cyan}${s.regimeMemory?.currentRegime || s.regimeMemory?.regime || 'unknown'}{/cyan}   {gray}Wallets Tracked{/gray}  {white}${s.watchlistCount}{/white}`,
    `  {gray}Tokens{/gray}         ${tokenLine}`,
    '',
    '  {white,bold}Quick Commands{/white,bold}',
    '  {cyan}/start{/cyan}  {cyan}/stop{/cyan}  {cyan}/pause{/cyan}  {cyan}/resume{/cyan}  {cyan}/scan{/cyan}  {cyan}/sweep{/cyan}  {cyan}/restart{/cyan}',
    '  {cyan}/strategy{/cyan} scalp | conservative | aggressive | sniper | recovery',
    '  {red}/emergency{/red}  ⚠ close all positions + stop bot immediately',
    '',
    '  {gray}Use any command above, or ask me anything.{/gray}',
    '',
  ];
}

// ── Features response ──
function featuresResponse() {
  const s = readPonyouState();
  const f = s.features || {};
  function feat(on, desc) {
    return `  ${on ? '{green}● ON {/green}' : '{gray}○ OFF{/gray}'}  ${desc}`;
  }
  return [
    '', '  {bold}Feature Toggles{/bold}', '',
    feat(f.vaultSweep,           '{cyan}vault_sweep{/cyan}       {gray}sweeps profit to safe wallet{/gray}'),
    feat(f.dailyGuard,           '{cyan}daily_guard{/cyan}       {gray}daily loss ceiling guard{/gray}'),
    feat(f.trashFilter,          '{cyan}trash_filter{/cyan}      {gray}hard-blocks scam tokens{/gray}'),
    feat(f.confirmMode,          '{cyan}confirm_mode{/cyan}      {gray}asks before each trade{/gray}'),
    feat(f.stagedEntry,          '{cyan}staged_entry{/cyan}      {gray}splits entry into tranches{/gray}'),
    feat(f.copyTrade,            '{cyan}copy_trade{/cyan}        {gray}mirrors smart wallet moves{/gray}'),
    feat(f.strategyEvolution,    '{cyan}strategy_evo{/cyan}      {gray}auto-evolves strategy params{/gray}'),
    feat(f.dayPhaseScreener,     '{cyan}day_phase{/cyan}         {gray}time-based market phase screen{/gray}'),
    feat(f.tradingPlan,          '{cyan}trading_plan{/cyan}      {gray}follows AI daily trade plan{/gray}'),
    feat(f.devBlacklist,         '{cyan}dev_blacklist{/cyan}     {gray}blocks known bad devs{/gray}'),
    '', '  {gray}Toggle with: {yellow}/wizard{/gray}', '',
  ];
}

// ── PnL breakdown ──
function pnlResponse() {
  const s = readPonyouState();
  const m = s.metrics;
  const r = s.lastReport;
  const pnlC = s.dailyPnl >= 0 ? 'green' : 'red';
  const pnlS = s.dailyPnl >= 0 ? '+' : '';
  const rC = r.pnlPct >= 0 ? 'green' : 'red';
  const rS = r.pnlPct >= 0 ? '+' : '';
  return [
    '', '  {bold}PnL Breakdown{/bold}', '',
    `  {gray}Daily PnL{/gray}       {${pnlC},bold}${pnlS}${s.dailyPnl.toFixed(4)} SOL{/${pnlC},bold}`,
    `  {gray}Win Rate{/gray}        {green}${(s.winRate * 100).toFixed(1)}%{/green}`,
    `  {gray}Total Swaps{/gray}     {white}${s.totalSwaps}{/white}`,
    `  {gray}Best Streak{/gray}     {green}${m.bestStreak || 0} wins{/green}`,
    `  {gray}Loss Streak{/gray}     {red}${m.lossStreak || 0}{/red}`,
    `  {gray}Max Drawdown{/gray}    {yellow}${((m.drawdown || 0) * 100).toFixed(1)}%{/yellow}`,
    '',
    `  {gray}Last Report{/gray}     {white}${r.date}{/white}`,
    `  {gray}  PnL{/gray}          {${rC}}${rS}${(r.pnlPct || 0).toFixed(2)}%{/${rC}}  {gray}Trades{/gray} {white}${r.trades}{/white}  {gray}WR{/gray} {green}${((r.winRate || 0) * 100).toFixed(0)}%{/green}`,
    `  {gray}  Market{/gray}        {cyan}${r.market}{/cyan}`,
    '',
  ];
}

// ── Trade history ──
function historyResponse() {
  const s = readPonyouState();
  const closed = s.closedPositions || [];
  if (closed.length === 0) return ['', '  {gray}No closed positions found.{/gray}', ''];

  const lines = ['', `  {bold}Recent Closed Trades (${closed.length}){/bold}`, ''];
  lines.push(`  {gray}Sym       Entry     PnL%      Size SOL  Strategy{/gray}`);
  closed.slice(-10).reverse().forEach(p => {
    const pc = (p.pnlPct || p.pnl_pct || 0) >= 0 ? 'green' : 'red';
    const ps = (p.pnlPct || p.pnl_pct || 0) >= 0 ? '+' : '';
    const sym = (p.symbol || p.sym || '?').slice(0, 8);
    const entry = (p.entryPrice || p.entry_price || 0).toFixed(6);
    const pnl = (p.pnlPct || p.pnl_pct || 0).toFixed(1);
    const size = (p.sizeSol || p.size_sol || p.amountSol || 0).toFixed(2);
    const strat = (p.strategy || '--').slice(0, 10);
    lines.push(`  {white}${sym.padEnd(9)} ${entry.padEnd(9)} {${pc}}${ps}${pnl}%{/${pc}}     ${size.padEnd(9)} {gray}${strat}{/gray}{/white}`);
  });
  lines.push('');
  return lines;
}

// ── Screener response ──
function screenerResponse() {
  const s = readPonyouState();
  const tokens = s.observedTokens || [];
  if (tokens.length === 0) return ['', '  {gray}No screened tokens found.{/gray}', ''];

  const lines = ['', `  {bold}Screened Tokens (${tokens.length}){/bold}`, ''];
  lines.push(`  {gray}Token          Score  Mcap      Holders  Signal{/gray}`);
  tokens.slice(0, 10).forEach(t => {
    const sym = (t.symbol || (t.mint || '?').slice(0, 8)).padEnd(14);
    const score = String(t.score || t.convictionScore || '--').padEnd(6);
    const mcap = t.marketCap ? `$${(t.marketCap / 1000).toFixed(0)}k` : '--';
    const holders = String(t.holders || '--');
    const sig = t.signal || t.type || '';
    lines.push(`  {cyan}${sym}{/cyan} {yellow}${score}{/yellow} {white}${mcap.padEnd(9)} ${holders.padEnd(8)}{/white} {gray}${sig}{/gray}`);
  });
  lines.push('');
  return lines;
}

// ── Smart wallets ──
function walletsResponse() {
  const s = readPonyouState();
  const wallets = s.smartWallets || [];
  if (wallets.length === 0) return ['', '  {gray}No smart wallets tracked.{/gray}', ''];

  const lines = ['', `  {bold}Smart Wallets (${wallets.length}){/bold}`, ''];
  lines.push(`  {gray}Address           WR%    Trades  Label{/gray}`);
  wallets.slice(0, 12).forEach(w => {
    const addr = (w.address || w.wallet || '?').slice(0, 12) + '...';
    const wr = w.winRate != null ? `${(w.winRate * 100).toFixed(0)}%` : '--';
    const trades = String(w.totalTrades || w.trades || '--');
    const label = w.label || w.name || '';
    lines.push(`  {cyan}${addr}{/cyan}  {green}${wr.padEnd(6)}{/green} {white}${trades.padEnd(7)}{/white} {gray}${label}{/gray}`);
  });
  lines.push('');
  return lines;
}

// ── Market regime ──
function regimeResponse() {
  const s = readPonyouState();
  const r = s.regimeMemory || {};
  const regimes = s.regimeStats || [];

  const lines = [
    '', '  {bold}Market Regime{/bold}', '',
    `  {gray}Current Regime{/gray}   {cyan,bold}${r.currentRegime || r.regime || 'unknown'}{/cyan,bold}`,
    `  {gray}Phase{/gray}            {white}${r.phase || r.marketPhase || '--'}{/white}`,
    `  {gray}Trend{/gray}            {white}${r.trend || '--'}{/white}`,
    `  {gray}Volatility{/gray}       {yellow}${r.volatility || '--'}{/yellow}`,
    `  {gray}Updated{/gray}          {gray}${r.updatedAt || r.timestamp || '--'}{/gray}`,
    '',
  ];

  if (regimes.length > 0) {
    lines.push('  {gray}Regime History{/gray}');
    regimes.forEach(rg => {
      const wr = rg.winRate != null ? `  WR ${(rg.winRate * 100).toFixed(0)}%` : '';
      lines.push(`  {cyan}${(rg.name || rg.regime || '?').padEnd(18)}{/cyan} {white}${rg.count || 0} trades${wr}{/white}`);
    });
    lines.push('');
  }
  return lines;
}

// ── Market intel ──
function intelResponse() {
  const s = readPonyouState();
  const m = s.marketIntel || {};
  const nv = s.narrativeVelocity || {};

  return [
    '', '  {bold}Market Intelligence{/bold}', '',
    `  {gray}SOL Price{/gray}      $${(m.solPrice || s.solPrice || 0).toFixed(2)}`,
    `  {gray}24h Volume{/gray}     {white}${m.volume24h ? '$' + (m.volume24h / 1e6).toFixed(1) + 'M' : '--'}{/white}`,
    `  {gray}Market Cap{/gray}     {white}${m.totalMcap ? '$' + (m.totalMcap / 1e9).toFixed(1) + 'B' : '--'}{/white}`,
    `  {gray}Top Narrative{/gray}  {cyan}${nv.topNarrative || nv.dominant || '--'}{/cyan}`,
    `  {gray}Hype Score{/gray}     {yellow}${nv.hypeScore || nv.score || '--'}{/yellow}`,
    `  {gray}Updated{/gray}        {gray}${m.updatedAt || '--'}{/gray}`,
    '',
  ];
}

// ── Lessons ──
function lessonsResponse() {
  const s = readPonyouState();
  const lessons = s.lessons || [];
  if (lessons.length === 0) return ['', '  {gray}No lessons recorded yet.{/gray}', ''];

  const lines = ['', `  {bold}AI Trading Lessons (last ${lessons.length}){/bold}`, ''];
  lessons.slice(-8).forEach((l, i) => {
    const text = typeof l === 'string' ? l : (l.lesson || l.text || JSON.stringify(l));
    lines.push(`  {gray}${i + 1}.{/gray} {white}${text.slice(0, 80)}${text.length > 80 ? '…' : ''}{/white}`);
  });
  lines.push('');
  return lines;
}

// ── Risk settings ──
function riskResponse() {
  const s = readPonyouState();
  const c = s.config;
  const riskC = s.riskLevel === 'LOW' ? 'green' : s.riskLevel === 'MEDIUM' ? 'yellow' : 'red';
  const auto = s.automationState;

  return [
    '', '  {bold}Risk Settings{/bold}', '',
    `  {gray}Risk Level{/gray}        {${riskC},bold}${s.riskLevel}{/${riskC},bold}`,
    `  {gray}Max Positions{/gray}     {white}${c.maxPositions || '--'}{/white}`,
    `  {gray}Min SOL/Trade{/gray}     {white}${c.minSolPerTrade || '--'}{/white}`,
    `  {gray}Position Size{/gray}     {white}${c.positionSizePct != null ? c.positionSizePct + '%' : '--'}{/white}`,
    `  {gray}Min Mcap{/gray}          {white}${c.minMcap ? '$' + c.minMcap.toLocaleString() : '--'}{/white}`,
    `  {gray}Max Mcap{/gray}          {white}${c.maxMcap ? '$' + c.maxMcap.toLocaleString() : '--'}{/white}`,
    `  {gray}Min TVL{/gray}           {white}${c.minTvl ? '$' + c.minTvl.toLocaleString() : '--'}{/white}`,
    `  {gray}Min Holders{/gray}       {white}${c.minHolders || '--'}{/white}`,
    '',
    `  {gray}Daily Guard{/gray}       ${c.dailyGuardEnabled ? '{green}ON{/green}' : '{red}OFF{/red}'}`,
    `  {gray}Trash Filter{/gray}      ${c.trashFilterEnabled ? '{green}ON{/green}' : '{red}OFF{/red}'}`,
    `  {gray}Confirm Mode{/gray}      ${c.confirmMode ? '{green}ON{/green}' : '{red}OFF{/red}'}`,
    '',
    `  {gray}Automation{/gray}        ${auto.active ? '{green}● active{/green}' : '{gray}○ inactive{/gray}'}  {gray}Progress${auto.progressPct ? ' ' + auto.progressPct + '%' : ''}{/gray}`,
    '', '  {gray}Edit: {yellow}/wizard{/gray}', '',
  ];
}

// ── Telegram group monitor status ──
function tggroupsResponse() {
  const config = readPonyouState().config;
  const raw    = process.env.TELEGRAM_GROUP_IDS || '';
  const mode   = raw.trim() === '*' ? 'ALL' : raw ? 'WHITELIST' : 'DISABLED';
  const ids    = raw === '*' ? [] : raw.split(',').map(s => s.trim()).filter(Boolean);

  const lines = [
    '', '  {bold}Telegram Group Monitor{/bold}', '',
    `  {gray}Status{/gray}    ${mode === 'DISABLED' ? '{red}DISABLED{/red}' : '{green}ACTIVE{/green}'}`,
    `  {gray}Mode{/gray}      {cyan}${mode}{/cyan}`,
    `  {gray}Call parse{/gray} ${config.useTelegramCalls ? '{green}ON{/green}' : '{gray}OFF{/gray}'}`,
    '',
  ];

  if (mode === 'ALL') {
    lines.push('  {yellow}Monitoring ALL groups the bot is a member of{/yellow}');
  } else if (ids.length > 0) {
    lines.push('  {gray}Monitored groups:{/gray}');
    ids.forEach(id => lines.push(`  {cyan}${id}{/cyan}`));
  } else {
    lines.push('  {gray}No groups configured.{/gray}');
    lines.push('  {gray}Add to .env:{/gray}');
    lines.push('  {yellow}TELEGRAM_GROUP_IDS=-100xxxxxx,-100yyyyyy{/yellow}');
    lines.push('  {gray}or use {yellow}TELEGRAM_GROUP_IDS=*{/gray} for all groups');
  }

  lines.push('');
  lines.push('  {gray}Setup guide:{/gray}');
  lines.push('  {white}1.{/white} {gray}Buat bot di t.me/BotFather → copy token{/gray}');
  lines.push('  {white}2.{/white} {gray}Invite bot ke grup alpha kamu{/gray}');
  lines.push('  {white}3.{/white} {gray}Ambil Group ID dari t.me/username_to_id_bot{/gray}');
  lines.push('  {white}4.{/white} {gray}Set TELEGRAM_GROUP_IDS di .env{/gray}');
  lines.push('  {white}5.{/white} {gray}Set TELEGRAM_BOT_TOKEN + useTelegramCalls: true{/gray}');
  lines.push('');
  return lines;
}

// ── Social signals overview ──
function socialResponse() {
  const s = readPonyouState();
  // Read from state supplementary data
  const observed = s.observedTokens || [];

  const lines = [
    '', '  {bold}Social Hunter — Top Signals{/bold}', '',
    `  {gray}Sources{/gray}  Reddit · CoinGecko · Dexscreener · Nitter · Discord · Telegram`,
    `  {gray}Refresh{/gray}  every 30 min  ·  gate: 7 layers`,
    '',
  ];

  if (observed.length === 0) {
    lines.push('  {gray}No signals yet. First scan runs on startup.{/gray}');
    lines.push('  {gray}Check social-signals.json after 1-2 minutes.{/gray}');
  } else {
    lines.push('  {gray}Symbol          Score   Mentions  Sources{/gray}');
    observed.slice(0, 10).forEach(t => {
      const sym   = (t.symbol || '?').padEnd(14);
      const score = String(t.socialScore || t.score || '--').padEnd(7);
      const ment  = String(t.mentions || '--').padEnd(9);
      const src   = (t.sources || []).map(s => s.split(':')[0]).join(',').slice(0, 20);
      lines.push(`  {cyan}${sym}{/cyan} {yellow}${score}{/yellow} {white}${ment}{/white} {gray}${src}{/gray}`);
    });
  }

  lines.push('');
  lines.push('  {gray}Social score feeds into signal-aggregator as {cyan}social_buzz{/gray} (8% weight)');
  lines.push('');
  return lines;
}

// ── Version info ──
function versionResponse() {
  const s = readPonyouState();
  const uptimeH = Math.floor(s.uptime / 3600);
  const uptimeM = Math.floor((s.uptime % 3600) / 60);
  return [
    '', '  {bold}Version & Session{/bold}', '',
    `  {gray}Agent{/gray}        {white}${s.agentName}{/white}`,
    `  {gray}Version{/gray}      {cyan}${s.version || '2.0.0'}{/cyan}`,
    `  {gray}Session ID{/gray}   {gray}${s.sessionId || '--'}{/gray}`,
    `  {gray}Uptime{/gray}       {white}${uptimeH}h ${uptimeM}m{/white}`,
    `  {gray}Connection{/gray}   ${s.rpcStatus === 'WS' ? '{green}WebSocket{/green}' : '{yellow}File Fallback{/yellow}'}`,
    `  {gray}Network{/gray}      {cyan}${s.network || 'Solana'}{/cyan}`,
    `  {gray}Mode{/gray}         {white}${s.mode.toUpperCase()}{/white}`,
    '',
  ];
}

// ── Status response ──
function statusResponse() {
  const s = readPonyouState();
  const pnlC = s.dailyPnl >= 0 ? 'green' : 'red';
  const pnlS = s.dailyPnl >= 0 ? '+' : '';
  const riskC = s.riskLevel === 'LOW' ? 'green' : s.riskLevel === 'MEDIUM' ? 'yellow' : 'red';
  return [
    '',
    `  {bold}${s.agentName}{/bold} {gray}▸ {/gray}{green}${s.mode.toUpperCase()}{/green} {gray}| {/gray}{magenta}${s.strategy}{/magenta} {gray}| {/gray}{white}${s.totalSwaps} swaps{/white}`,
    '',
    `  {gray}Balance{/gray}      {yellow}${s.balance.toFixed(2)} SOL{/yellow}`,
    `  {gray}Open Positions{/gray} {cyan}${s.openPositions}{/cyan}`,
    `  {gray}Win Rate{/gray}      {green}${(s.winRate * 100).toFixed(1)}%{/green}`,
    `  {gray}Daily PnL{/gray}      {${pnlC}}${pnlS}${s.dailyPnl.toFixed(2)} SOL{/${pnlC}}`,
    `  {gray}Risk Level{/gray}    {${riskC}}${s.riskLevel}{/${riskC}}`,
    `  {gray}RPC{/gray}          {green}${s.rpcStatus}{/green}  {gray}DEX{/gray} {green}${s.dexStatus}{/green}  {gray}Wallet{/gray} {green}${s.walletStatus}{/green}`,
    `  {gray}SOL Price{/gray}     $${s.solPrice.toFixed(2)}`,
    `  {gray}Uptime{/gray}       ${Math.floor(s.uptime / 3600)}h ${Math.floor((s.uptime % 3600) / 60)}m`,
    '',
  ];
}

// ── Positions response ──
function positionsResponse() {
  const s = readPonyouState();
  if (s.openPositionsList.length === 0) {
    return ['', '  {gray}No open positions.{/gray}', ''];
  }
  const lines = ['', `  {bold}Open Positions (${s.openPositionsList.length}){/bold}`, ''];
  lines.push(`  {gray}Sym       Entry      Current     PnL%      Size SOL   Risk   Age{/gray}`);
  s.openPositionsList.forEach(p => {
    const pc = p.pnlPct >= 0 ? 'green' : 'red';
    const ps = p.pnlPct >= 0 ? '+' : '';
    const rc = p.risk === 'LOW' ? 'green' : p.risk === 'MED' ? 'yellow' : 'red';
    lines.push(`  {white}${p.sym.padEnd(9)} ${String(p.entry).padEnd(10)} ${String(p.current).padEnd(11)} {${pc}}${ps}${p.pnlPct.toFixed(1)}%{/${pc}}   ${p.size.toFixed(2).padEnd(8)} {${rc}}${p.risk.padEnd(5)}{/${rc}} ${p.age}{/white}`);
  });
  lines.push('');
  return lines;
}

// ── Main processor ──
export function processMessage(input) {
  const t = input.trim();
  const parts = t.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // Action commands
  if (cmd === '/monitor' || cmd === '/logs' || cmd === '/dashboard') {
    return { type: 'action', action: 'monitor', message: '{gray}Launching live dashboard...{/gray}' };
  }
  if (cmd === '/wizard' || cmd === '/setup' || cmd === '/config-wizard') {
    return { type: 'action', action: 'wizard', message: '{gray}Opening setup wizard...{/gray}' };
  }
  if (cmd === '/quit' || cmd === '/exit' || cmd === '/q') {
    return { type: 'action', action: 'quit', message: '{gray}such goodbye, very exit wow{/gray}' };
  }
  if (cmd === '/clear' || cmd === '/cls') {
    return { type: 'clear' };
  }
  if (cmd === '/help' || cmd === '/?') {
    return { type: 'response', lines: ['', '{cyan,bold}Commands{/cyan,bold}', '', ...CMD_LIST.slice(0, -2), ''] };
  }

  // Data commands
  if (cmd === '/status' || /^(how|what).*bot|bot.*(doing|status|going)/i.test(t)) {
    return { type: 'response', lines: statusResponse() };
  }
  if (cmd === '/positions' || /position|trade.*open|holding/i.test(t)) {
    return { type: 'response', lines: positionsResponse() };
  }
  if (cmd === '/strategies' || /strateg/i.test(t)) {
    const s = readPonyouState();
    return { type: 'response', lines: [
      '', '  {bold}Strategies{/bold}', '',
      '  {cyan}scalp{/cyan}            {gray}▸ Quick entries, 5-15m holds, new pairs{/gray}',
      '  {cyan}conservative{/cyan}      {gray}▸ Higher conviction, larger caps{/gray}',
      '  {cyan}aggressive{/cyan}        {gray}▸ Early entries, higher risk tolerance{/gray}',
      '  {cyan}sniper{/cyan}           {gray}▸ Ultra-fast launch entries, tight SL{/gray}',
      '  {cyan}recovery{/cyan}          {gray}▸ DCA-based loss recovery{/gray}',
      '  {cyan}day_phase_swing{/cyan}   {gray}▸ Time-based entries per market phase{/gray}',
      '', `  {gray}Active: {magenta}${s.strategy}{/magenta}    {gray}Change: {yellow}/wizard{/yellow}`, '',
    ]};
  }
  if (cmd === '/config') {
    const s = readPonyouState(); const c = s.config;
    return { type: 'response', lines: [
      '', '  {bold}Configuration{/bold}', '',
      ...[
        ['executionMode', c.executionMode, 'green'],
        ['strategy', c.strategy, 'magenta'],
        ['maxPositions', c.maxPositions], ['minSolPerTrade', c.minSolPerTrade],
        ['minMcap', c.minMcap], ['maxMcap', c.maxMcap], ['minTvl', c.minTvl],
        ['trashFilterEnabled', c.trashFilterEnabled ? '{green}ON{/green}' : '{red}OFF{/red}'],
        ['vaultSweepEnabled', c.vaultSweepEnabled ? '{green}ON{/green}' : '{red}OFF{/red}'],
        ['dailyGuardEnabled', c.dailyGuardEnabled ? '{green}ON{/green}' : '{red}OFF{/red}'],
        ['confirmMode', c.confirmMode ? '{green}ON{/green}' : '{red}OFF{/red}'],
      ].map(([k, v, col]) => `  {gray}${String(k).padEnd(22)}{/gray} {${col || 'white'}}${v !== undefined ? v : '{gray}--{/gray}'}{/${col || 'white'}}`),
      '', `  {gray}Edit: {yellow}/wizard{/yellow}  or  {yellow}user-config.json{/yellow}`, '',
    ]};
  }
  if (cmd === '/metrics') {
    const m = readPonyouState().metrics;
    return { type: 'response', lines: [
      '', '  {bold}Performance{/bold}', '',
      `  {gray}Win Rate{/gray}      {green}${((m.winRate||0)*100).toFixed(1)}%{/green}`,
      `  {gray}Total Swaps{/gray}    {white}${m.totalSwaps||0}{/white}`,
      `  {gray}Daily PnL{/gray}      ${(m.dailyPnl||0)>=0?'{green}':'{red}'}${(m.dailyPnl||0)>=0?'+':''}${(m.dailyPnl||0).toFixed(2)} SOL{/}`,
      `  {gray}Best Streak{/gray}    {green}${m.bestStreak||0}{/green}`,
      `  {gray}Loss Streak{/gray}    {red}${m.lossStreak||0}{/red}`,
      `  {gray}Max Drawdown{/gray}   {yellow}${((m.drawdown||0)*100).toFixed(1)}%{/yellow}`,
      '',
    ]};
  }
  if (cmd === '/tools') {
    return { type: 'response', lines: [
      '', '  {bold}Tools{/bold}', '',
      ...getPonyouTools().map(t => {
        const c = t.status==='READY'?'green':t.status==='SYNCING'?'cyan':t.status==='RATE_LIMIT'?'yellow':'red';
        return `  {white}${t.name.padEnd(24)}{/white} {${c}}● ${t.status}{/${c}}  {gray}${t.file}{/gray}`;
      }),
      '',
    ]};
  }
  if (cmd === '/cmd') {
    const botCmd = parts.slice(1).join(' ');
    if (!botCmd) return { type: 'response', lines: [
      '', '  {red}Usage: /cmd <command>{/red}',
      '  {gray}Examples:{/gray} {yellow}/cmd start  /cmd stop  /cmd pause  /cmd sweep{/yellow}', '',
    ]};
    return {
      type: 'async',
      message: `{gray}Sending: {yellow}${botCmd}{/yellow}...{/gray}`,
      asyncFn: async () => {
        const r = await sendCommand(botCmd);
        return r.error
          ? ['', `  {red}Error: ${r.error}{/red}`, '']
          : ['', `  {green}Sent: ${botCmd}{/green}`, `  {gray}${r.message||'OK'}{/gray}`, ''];
      },
    };
  }

  // ── New data commands ──
  if (cmd === '/remote') {
    return { type: 'response', lines: remoteResponse() };
  }
  if (cmd === '/features') {
    return { type: 'response', lines: featuresResponse() };
  }
  if (cmd === '/pnl') {
    return { type: 'response', lines: pnlResponse() };
  }
  if (cmd === '/history') {
    return { type: 'response', lines: historyResponse() };
  }
  if (cmd === '/screener') {
    return { type: 'response', lines: screenerResponse() };
  }
  if (cmd === '/wallets') {
    return { type: 'response', lines: walletsResponse() };
  }
  if (cmd === '/regime') {
    return { type: 'response', lines: regimeResponse() };
  }
  if (cmd === '/intel') {
    return { type: 'response', lines: intelResponse() };
  }
  if (cmd === '/lessons') {
    return { type: 'response', lines: lessonsResponse() };
  }
  if (cmd === '/risk') {
    return { type: 'response', lines: riskResponse() };
  }
  if (cmd === '/version') {
    return { type: 'response', lines: versionResponse() };
  }
  if (cmd === '/tggroups') {
    return { type: 'response', lines: tggroupsResponse() };
  }
  if (cmd === '/social') {
    return { type: 'response', lines: socialResponse() };
  }

  // ── Strategy switch ──
  if (cmd === '/strategy') {
    const name = parts[1]?.toLowerCase();
    const valid = ['scalp', 'conservative', 'aggressive', 'sniper', 'recovery', 'day_phase_swing'];
    if (!name) {
      const s = readPonyouState();
      return { type: 'response', lines: [
        '', '  {bold}Strategy{/bold}', '',
        `  {gray}Active:{/gray} {magenta}${s.strategy}{/magenta}`, '',
        '  {gray}Available:{/gray}',
        ...valid.map(v => `  {cyan}${v}{/cyan}`),
        '', '  {gray}Usage: {yellow}/strategy scalp{/gray}', '',
      ]};
    }
    if (!valid.includes(name)) {
      return { type: 'response', lines: [
        '', `  {red}Unknown strategy: ${name}{/red}`,
        `  {gray}Valid: ${valid.join(', ')}{/gray}`, '',
      ]};
    }
    return {
      type: 'async',
      message: `{gray}Switching strategy to {yellow}${name}{/yellow}...{/gray}`,
      asyncFn: async () => {
        const r = await sendCommand(`strategy ${name}`);
        return r.error
          ? ['', `  {red}Error: ${r.error}{/red}`, '']
          : ['', `  {green}Strategy switched to: {magenta}${name}{/magenta}{/green}`, `  {gray}${r.message || 'OK'}{/gray}`, ''];
      },
    };
  }

  // ── Bot control quick commands ──
  const BOT_CMDS = { '/start': 'start', '/stop': 'stop', '/pause': 'pause', '/resume': 'resume', '/scan': 'scan', '/sweep': 'sweep', '/restart': 'restart' };
  if (BOT_CMDS[cmd]) {
    const botCmd = BOT_CMDS[cmd];
    const labels = { start: 'Starting bot...', stop: 'Stopping bot...', pause: 'Pausing trading...', resume: 'Resuming trading...', scan: 'Triggering manual scan...', sweep: 'Triggering vault sweep...', restart: 'Restarting bot process...' };
    return {
      type: 'async',
      message: `{gray}${labels[botCmd]}{/gray}`,
      asyncFn: async () => {
        const r = await sendCommand(botCmd);
        return r.error
          ? ['', `  {red}Error: ${r.error}{/red}`, '']
          : ['', `  {green}✓ ${botCmd.charAt(0).toUpperCase() + botCmd.slice(1)}{/green}`, `  {gray}${r.message || 'OK'}{/gray}`, ''];
      },
    };
  }

  // ── Emergency stop ──
  if (cmd === '/emergency') {
    return {
      type: 'async',
      message: '{red}⚠ EMERGENCY: closing all positions + stopping bot...{/red}',
      asyncFn: async () => {
        const r = await sendCommand('emergency');
        return r.error
          ? ['', `  {red}Error: ${r.error}{/red}`, '']
          : ['', `  {red,bold}⚠ Emergency executed{/red,bold}`, `  {gray}${r.message || 'OK'}{/gray}`, ''];
      },
    };
  }

  // Greetings
  if (/^(hi|hey|hello|yo|sup|hola|gm|gn)/i.test(t)) {
    const s = readPonyouState();
    return { type: 'response', lines: [
      '',
      `  {yellow}such hello, very gm!{/yellow} {gray}Bot is {green}${s.mode.toUpperCase()}{/green} {gray}on{/gray} {magenta}${s.strategy}{/magenta}.`,
      `  {gray}Balance: {yellow}${s.balance.toFixed(2)} SOL{/yellow}  {gray}|  PnL: ${s.dailyPnl>=0?'{green}+':'{red}'}${s.dailyPnl.toFixed(2)} SOL{/gray}`,
      '  {gray}Try {cyan}/status{/gray} or {cyan}/monitor{/gray}!{/gray}',
      '',
    ]};
  }

  // Topic questions
  if (/monitor|dashboard|logs/i.test(t)) {
    return { type: 'response', lines: [
      '', '  {cyan}/monitor{/cyan} {gray}opens a full dashboard:{/gray}',
      '  {white}▸ Real-time agent logs with color-coded levels{/white}',
      '  {white}▸ Position table, market scan, risk alerts{/white}',
      '  {white}▸ ASCII sparkline charts, tools status panel{/white}',
      '  {gray}Press {yellow}q{/gray} to exit and return here.{/gray}', '',
    ]};
  }
  if (/wizard|setup|config/i.test(t)) {
    return { type: 'response', lines: [
      '', '  {cyan}/wizard{/cyan} {gray}▸ 10-step interactive setup{/gray}',
      '  {gray}Wallet → Mode → Strategy → LLM → Screening →{/gray}',
      '  {gray}Position → Guard → Vault → Features → Save{/gray}', '',
    ]};
  }

  // Unknown slash command
  if (cmd.startsWith('/')) {
    return { type: 'response', lines: [
      '', `  {red}Unknown: ${cmd}{/red}`,
      '  {gray}Type {cyan}/help{gray} for available commands.{/gray}', '',
    ]};
  }

  // Fallback
  return { type: 'response', lines: [
    '',
    `  {gray}I understand you're asking about:{/gray} "${t.slice(0,50)}${t.length>50?'...':''}"`,
    '',
    '  {gray}Try these:{/gray}',
    '  {cyan}/status{/cyan}     {gray}▸ Bot status overview{/gray}',
    '  {cyan}/monitor{/cyan}    {gray}▸ Live dashboard{/gray}',
    '  {cyan}/wizard{/cyan}     {gray}▸ Setup wizard{/gray}',
    '  {cyan}/help{/cyan}       {gray}▸ All commands{/gray}',
    '',
  ]};
}
