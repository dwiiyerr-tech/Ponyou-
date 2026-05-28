// Agent REPL Mode — Claude Code-like command interface
// Main screen with status, output, and slash command bar

import blessed from 'blessed';
import { readPonyouState, getPonyouTools } from '../data/state-bridge.js';
import { sendCommand } from '../data/command-bridge.js';

export function createAgentScreen(screen, { onMonitor, onWizard, onQuit }) {
  const rows = screen.rows;
  const cols = screen.cols;

  // State
  let cmdHistory = [];
  let historyIdx = -1;
  let outputLines = [];
  let cmdValue = '';

  // ── Header ──
  const header = blessed.box({
    top: 0, left: 0, width: cols, height: 5,
    tags: true,
    border: { type: 'line', fg: 'yellow' },
    style: { fg: 'white', border: { fg: 'yellow' }, label: { fg: 'yellow' } },
  });

  // ── Output area (middle) ──
  const output = blessed.box({
    top: 5, left: 0, width: cols, height: rows - 8,
    tags: true,
    border: { type: 'line', fg: '#333333' },
    style: { fg: 'white', border: { fg: '#333333' }, label: { fg: 'yellow' } },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: false,
    mouse: true,
  });

  // ── Command input bar ──
  const cmdBar = blessed.textbox({
    bottom: 1, left: 0, width: cols, height: 3,
    tags: true,
    border: { type: 'line', fg: 'yellow' },
    style: { fg: 'yellow', border: { fg: 'yellow' } },
    inputOnFocus: true,
    keys: true,
    vi: false,
  });

  // ── Help overlay ──
  const helpBox = blessed.box({
    top: 'center', left: 'center', width: 52, height: 20,
    tags: true,
    border: { type: 'line', fg: 'yellow' },
    style: { fg: 'white', border: { fg: 'yellow' }, label: { fg: 'yellow' } },
    hidden: true,
  });

  [header, output, cmdBar, helpBox].forEach((w) => screen.append(w));

  // ── Render header ──
  function renderHeader() {
    const s = readPonyouState();
    const balColor = s.balance > 0 ? 'green' : 'yellow';
    const pnlColor = s.dailyPnl >= 0 ? 'green' : 'red';
    const pnlSign = s.dailyPnl >= 0 ? '+' : '';

    const content = [
      '{yellow-fg}  ___   ___   _   _ \x1b[33m _   _ \x1b[33m _   _ {/yellow-fg}',
      '{yellow-fg} | _ \\ / _ \\ | \\ | | | | | | | | | |{/yellow-fg}',
      '{yellow-fg} |  _/| (_) ||  \\| | | |_| | | |_| |{/yellow-fg}',
      '{yellow-fg} |_|   \\___/ |_|\\__|  \\___/   \\___/ {/yellow-fg}  {cyan-fg}Terminal Agent v2.0{/cyan-fg}',
      '',
      `{white-fg}Mode: {green-fg}${s.mode.toUpperCase()}{/green-fg}  Strategy: {magenta-fg}${s.strategy}{/green-fg}  Balance: {${balColor}-fg}${s.balance.toFixed(2)} SOL{/${balColor}-fg}  PnL: {${pnlColor}-fg}${pnlSign}${s.dailyPnl.toFixed(2)} SOL{/${pnlColor}-fg}  Win: {green-fg}${(s.winRate*100).toFixed(1)}%{/green-fg}`,
    ].join('\n');

    header.setContent(content);
  }

  // ── Render output ──
  function addOutput(line) {
    outputLines.push(line);
    if (outputLines.length > 500) outputLines = outputLines.slice(-500);
    output.setContent(outputLines.join('\n'));
    output.setScrollPerc(100);
    screen.render();
  }

  // ── Render help ──
  function showHelp() {
    helpBox.setContent([
      '{yellow-fg} PONYOU TERMINAL AGENT — Commands{/yellow-fg}',
      '',
      '{cyan-fg}Slash Commands{/cyan-fg}',
      '  {yellow-fg}/monitor{/yellow-fg}      Launch full monitoring dashboard',
      '  {yellow-fg}/monitor logs{/yellow-fg}  Same as /monitor',
      '  {yellow-fg}/wizard{/yellow-fg}       Launch setup wizard',
      '  {yellow-fg}/wizard config{/yellow-fg} Configure bot settings',
      '  {yellow-fg}/status{/yellow-fg}       Show full bot status',
      '  {yellow-fg}/positions{/yellow-fg}    List open positions',
      '  {yellow-fg}/tools{/yellow-fg}        List tool statuses',
      '  {yellow-fg}/config{/yellow-fg}       Show current config',
      '  {yellow-fg}/metrics{/yellow-fg}      Show performance metrics',
      '',
      '{cyan-fg}Bot Commands{/cyan-fg}',
      '  {yellow-fg}/cmd start{/yellow-fg}     Start the bot',
      '  {yellow-fg}/cmd stop{/yellow-fg}      Stop the bot',
      '  {yellow-fg}/cmd pause{/yellow-fg}     Pause trading',
      '  {yellow-fg}/cmd resume{/yellow-fg}    Resume trading',
      '  {yellow-fg}/cmd status{/yellow-fg}    Bot status',
      '  {yellow-fg}/cmd sweep{/yellow-fg}     Trigger vault sweep',
      '  {yellow-fg}/cmd strategies{/yellow-fg} List strategies',
      '',
      '{cyan-fg}Other{/cyan-fg}',
      '  {yellow-fg}/help{/yellow-fg}        Show this help',
      '  {yellow-fg}/clear{/yellow-fg}       Clear output',
      '  {yellow-fg}/quit{/yellow-fg}        Exit app',
      '  {yellow-fg}Ctrl+C{/yellow-fg}       Force exit',
    ].join('\n'));
    helpBox.show();
    screen.render();
  }

  // ── Process commands ──
  async function processCommand(input) {
    const trimmed = input.trim();
    if (!trimmed) return;

    cmdHistory.push(trimmed);
    historyIdx = -1;
    addOutput(`{yellow-fg}> ${trimmed}{/yellow-fg}`);

    const parts = trimmed.split(/\s+/);
    const slash = parts[0].toLowerCase();

    switch (slash) {
      case '/monitor':
        onMonitor();
        return;

      case '/wizard':
        onWizard();
        return;

      case '/status': {
        const s = readPonyouState();
        addOutput(`{cyan-fg}Agent:   {/cyan-fg}{white-fg}${s.agentName}{/white-fg}`);
        addOutput(`{cyan-fg}Mode:    {/cyan-fg}{green-fg}${s.mode.toUpperCase()}{/green-fg}`);
        addOutput(`{cyan-fg}Strategy:{/cyan-fg} {magenta-fg}${s.strategy}{/magenta-fg}`);
        addOutput(`{cyan-fg}Balance: {/cyan-fg}{yellow-fg}${s.balance.toFixed(2)} SOL{/yellow-fg}`);
        addOutput(`{cyan-fg}Positions:{/cyan-fg} {white-fg}${s.openPositions} open{/white-fg}`);
        addOutput(`{cyan-fg}Win Rate:{/cyan-fg} {green-fg}${(s.winRate*100).toFixed(1)}%{/green-fg}`);
        addOutput(`{cyan-fg}Swaps:   {/cyan-fg} {white-fg}${s.totalSwaps}{/white-fg}`);
        addOutput(`{cyan-fg}Risk:    {/cyan-fg} {yellow-fg}${s.riskLevel}{/yellow-fg}`);
        addOutput(`{cyan-fg}RPC:     {/cyan-fg} {green-fg}${s.rpcStatus}{/green-fg}`);
        addOutput(`{cyan-fg}DEX:     {/cyan-fg} {green-fg}${s.dexStatus}{/green-fg}`);
        addOutput(`{cyan-fg}Wallet:  {/cyan-fg} {green-fg}${s.walletStatus}{/green-fg}`);
        addOutput(`{cyan-fg}Uptime:  {/cyan-fg} ${Math.floor(s.uptime/3600)}h${Math.floor((s.uptime%3600)/60)}m`);
        break;
      }

      case '/positions': {
        const s = readPonyouState();
        if (s.openPositionsList.length === 0) {
          addOutput('{gray-fg}No open positions{/gray-fg}');
        } else {
          addOutput('{gray-fg}Symbol     Entry      Current     PnL%     Size      Risk  Age{/gray-fg}');
          s.openPositionsList.forEach((p) => {
            const pnlC = p.pnlPct >= 0 ? 'green' : 'red';
            const sgn = p.pnlPct >= 0 ? '+' : '';
            addOutput(`{white-fg}${p.sym.padEnd(10)} ${String(p.entry).padEnd(10)} ${String(p.current).padEnd(11)} {${pnlC}-fg}${sgn}${p.pnlPct.toFixed(1)}%{/${pnlC}-fg}   ${p.size.toFixed(2).padEnd(7)}  ${p.risk.padEnd(4)} ${p.age}{/white-fg}`);
          });
        }
        break;
      }

      case '/tools': {
        const tools = getPonyouTools();
        tools.forEach((t) => {
          const c = t.status === 'READY' ? 'green' : t.status === 'SYNCING' ? 'cyan' : t.status === 'RATE_LIMIT' ? 'yellow' : 'red';
          addOutput(`{white-fg}${t.name.padEnd(22)}{/white-fg} {${c}-fg}${t.status}{/${c}-fg}  {gray-fg}${t.file}{/gray-fg}`);
        });
        break;
      }

      case '/config': {
        const s = readPonyouState();
        const cfg = s.config;
        addOutput('{cyan-fg}Current Configuration:{/cyan-fg}');
        const keys = ['executionMode','strategy','maxPositions','minSolPerTrade','positionSizePct','confirmMode','trashFilterEnabled','vaultSweepEnabled','dailyGuardEnabled','minMcap','maxMcap','minTvl','maxTvl','minHolders'];
        keys.forEach((k) => {
          const v = cfg[k];
          const display = v === undefined ? '--' : typeof v === 'boolean' ? (v ? '{green-fg}ON{/green-fg}' : '{red-fg}OFF{/red-fg}') : String(v);
          addOutput(`  {white-fg}${k}:{/white-fg} ${display}`);
        });
        break;
      }

      case '/metrics': {
        const m = readPonyouState().metrics;
        addOutput(`{cyan-fg}Win Rate:{/cyan-fg} {green-fg}${((m.winRate||0)*100).toFixed(1)}%{/green-fg}`);
        addOutput(`{cyan-fg}Total Swaps:{/cyan-fg} {white-fg}${m.totalSwaps||0}{/white-fg}`);
        addOutput(`{cyan-fg}Daily PnL:{/cyan-fg} ${(m.dailyPnl||0)>=0?'{green-fg}':'{red-fg}'}${(m.dailyPnl||0).toFixed(2)} SOL{/}`);
        addOutput(`{cyan-fg}Best Streak:{/cyan-fg} {green-fg}${m.bestStreak||0}{/green-fg}`);
        addOutput(`{cyan-fg}Loss Streak:{/cyan-fg} {red-fg}${m.lossStreak||0}{/red-fg}`);
        addOutput(`{cyan-fg}Drawdown:{/cyan-fg} {yellow-fg}${((m.drawdown||0)*100).toFixed(1)}%{/yellow-fg}`);
        break;
      }

      case '/cmd': {
        const cmd = parts.slice(1).join(' ');
        if (!cmd) { addOutput('{red-fg}Usage: /cmd <command>  (e.g. /cmd start, /cmd pause){/red-fg}'); break; }
        addOutput(`{yellow-fg}Sending: ${cmd}...{/yellow-fg}`);
        const result = await sendCommand(cmd);
        if (result.error) {
          addOutput(`{red-fg}Error: ${result.error}{/red-fg}`);
        } else {
          addOutput(`{green-fg}OK: ${result.message || JSON.stringify(result)}{/green-fg}`);
        }
        break;
      }

      case '/clear':
        outputLines = [];
        output.setContent('');
        screen.render();
        break;

      case '/help':
        showHelp();
        break;

      case '/quit':
        onQuit();
        break;

      default:
        if (slash.startsWith('/')) {
          addOutput(`{red-fg}Unknown command: ${slash}. Type /help for available commands.{/red-fg}`);
        } else {
          addOutput(`{gray-fg}Tip: Use / to type commands. /help for list.{/gray-fg}`);
        }
    }
  }

  // ── Keyboard ──
  cmdBar.key(['enter'], () => {
    cmdBar.screen.render();
  });

  cmdBar.on('submit', (val) => {
    const v = val?.trim() || cmdValue?.trim();
    cmdValue = '';
    cmdBar.clearValue();
    cmdBar.setValue('');
    processCommand(v);
    screen.render();
  });

  cmdBar.on('keypress', (ch, key) => {
    if (key && key.name === 'up') {
      if (cmdHistory.length > 0 && historyIdx < cmdHistory.length - 1) {
        historyIdx++;
        const entry = cmdHistory[cmdHistory.length - 1 - historyIdx];
        cmdBar.setValue(entry);
        cmdValue = entry;
      }
      return;
    }
    if (key && key.name === 'down') {
      if (historyIdx > 0) {
        historyIdx--;
        const entry = cmdHistory[cmdHistory.length - 1 - historyIdx];
        cmdBar.setValue(entry);
        cmdValue = entry;
      } else if (historyIdx === 0) {
        historyIdx = -1;
        cmdBar.setValue('');
        cmdValue = '';
      }
      return;
    }
    // Track value for submit
    cmdValue = cmdBar.getValue?.() || '';
  });

  screen.key(['C-c'], onQuit);
  screen.key(['escape'], () => {
    if (helpBox.hidden === false) {
      helpBox.hide();
      screen.render();
    }
  });

  // ── Initial render ──
  renderHeader();
  addOutput('{green-fg} PONYOU Terminal Agent v2.0 — ready.{/green-fg}');
  addOutput('{gray-fg} Type /help for commands, /monitor for dashboard, /wizard for setup{/green-fg}');
  addOutput('');
  output.setScrollPerc(100);
  cmdBar.focus();

  // Periodic header refresh
  const refreshInterval = setInterval(() => {
    renderHeader();
    screen.render();
  }, 5000);

  return {
    refreshInterval,
    addOutput,
    renderHeader,
  };
}
