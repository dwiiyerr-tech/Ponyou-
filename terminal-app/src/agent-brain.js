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
  '   {cyan}/monitor{/cyan}     {gray}live dashboard — logs, chart, alerts{/gray}',
  '   {cyan}/wizard{/cyan}      {gray}configure bot settings{/gray}',
  '   {cyan}/status{/cyan}      {gray}overview — mode, balance, PnL{/gray}',
  '   {cyan}/positions{/cyan}   {gray}open positions with PnL{/gray}',
  '   {cyan}/config{/cyan}      {gray}current configuration{/gray}',
  '   {cyan}/metrics{/cyan}     {gray}performance stats{/gray}',
  '   {cyan}/tools{/cyan}       {gray}tools status{/gray}',
  '   {cyan}/cmd <name>{/cyan}  {gray}send command: start stop pause sweep{/gray}',
  '',
  '   {gray}Or just ask me anything.{/gray}',
];

export function getWelcome() {
  return [...LOGO, ...WELCOME_INTRO, ...CMD_LIST];
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
