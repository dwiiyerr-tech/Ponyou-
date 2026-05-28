// PONYOU — Claude Code-style Terminal Interface

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useStdout, useStdin, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { getWelcome, processMessage } from './agent-brain.js';

// ── Slash commands registry ──
const SLASH_COMMANDS = [
  // Modes / Navigation
  { name: '/monitor',    desc: 'Live monitoring dashboard (full screen)' },
  { name: '/wizard',     desc: 'Setup wizard & bot configuration' },
  { name: '/remote',     desc: 'Remote control panel — all features' },
  // Status & Info
  { name: '/status',     desc: 'Bot status, mode & balance overview' },
  { name: '/positions',  desc: 'Open positions with PnL & risk' },
  { name: '/history',    desc: 'Recent closed trades (last 10)' },
  { name: '/pnl',        desc: 'PnL breakdown by session & strategy' },
  { name: '/metrics',    desc: 'Performance stats, streaks & drawdown' },
  { name: '/config',     desc: 'Current configuration snapshot' },
  { name: '/features',   desc: 'Feature toggles & on/off status' },
  { name: '/tools',      desc: 'Tool health check & status' },
  { name: '/strategies', desc: 'Available trading strategies' },
  { name: '/version',    desc: 'Version, session & uptime info' },
  { name: '/tggroups',   desc: 'Telegram group monitor status & stats' },
  { name: '/social',     desc: 'Top social signals from all sources' },
  // Market Data
  { name: '/screener',   desc: 'Top screened tokens right now' },
  { name: '/wallets',    desc: 'Smart wallets being tracked' },
  { name: '/regime',     desc: 'Market regime & conditions' },
  { name: '/intel',      desc: 'Market intelligence & heatmap' },
  { name: '/lessons',    desc: 'AI trading lessons learned' },
  { name: '/risk',       desc: 'Risk settings & guard status' },
  // Bot Control
  { name: '/start',      desc: 'Start the bot (live or paper mode)' },
  { name: '/stop',       desc: 'Stop the bot gracefully' },
  { name: '/pause',      desc: 'Pause trading (keep positions open)' },
  { name: '/resume',     desc: 'Resume trading from pause' },
  { name: '/scan',       desc: 'Trigger manual market scan now' },
  { name: '/sweep',      desc: 'Trigger vault sweep to safe wallet' },
  { name: '/restart',    desc: 'Restart bot process cleanly' },
  { name: '/emergency',  desc: '⚠ EMERGENCY: close all & stop bot' },
  // Strategy
  { name: '/strategy',   desc: 'Switch strategy: scalp conservative aggressive sniper' },
  // Utility
  { name: '/cmd',        desc: 'Raw bot command: start stop pause sweep' },
  { name: '/clear',      desc: 'Clear chat history' },
  { name: '/help',       desc: 'Show all commands' },
  { name: '/quit',       desc: 'Exit terminal' },
];

// ── Tag parser (handles {color}text{/color} from agent-brain) ──
const TAG_COLOR_MAP = {
  cyan: 'cyan', gray: 'gray', white: 'white', green: 'green',
  red: 'red', yellow: 'yellow', magenta: 'magenta', blue: 'blue', black: 'black',
};

function parseTaggedLine(str) {
  if (!str || !str.includes('{')) return [{ text: str || '', color: null, bold: false }];
  const segments = [];
  const colorStack = [null];
  const boldStack  = [false];
  let pos = 0;
  while (pos < str.length) {
    const tagOpen = str.indexOf('{', pos);
    if (tagOpen === -1) {
      const tail = str.slice(pos);
      if (tail) segments.push({ text: tail, color: colorStack.at(-1), bold: boldStack.at(-1) });
      break;
    }
    if (tagOpen > pos)
      segments.push({ text: str.slice(pos, tagOpen), color: colorStack.at(-1), bold: boldStack.at(-1) });
    const tagClose = str.indexOf('}', tagOpen);
    if (tagClose === -1) {
      segments.push({ text: str.slice(tagOpen), color: colorStack.at(-1), bold: boldStack.at(-1) });
      break;
    }
    const inner = str.slice(tagOpen + 1, tagClose).toLowerCase().trim();
    pos = tagClose + 1;
    if (inner.startsWith('/')) {
      if (colorStack.length > 1) colorStack.pop();
      if (boldStack.length > 1)  boldStack.pop();
    } else {
      const parts = inner.replace(/-fg$/, '').split(',');
      let newColor = colorStack.at(-1), newBold = boldStack.at(-1);
      for (const p of parts) {
        const t = p.trim();
        if (t === 'bold') newBold = true;
        else if (TAG_COLOR_MAP[t]) newColor = TAG_COLOR_MAP[t];
      }
      colorStack.push(newColor);
      boldStack.push(newBold);
    }
  }
  return segments.filter(s => s.text.length > 0);
}

function TagLine({ text }) {
  if (!text) return React.createElement(Text, null, '');
  if (!text.includes('{')) return React.createElement(Text, null, text);
  const segs = parseTaggedLine(text);
  if (!segs.length) return React.createElement(Text, null, '');
  return React.createElement(Text, null,
    ...segs.map((s, i) =>
      React.createElement(Text, { key: i, color: s.color || undefined, bold: s.bold || undefined }, s.text)
    )
  );
}

// ── Header ──
function Header({ state }) {
  const modeColor = state?.mode === 'live'  ? 'green'
                  : state?.mode === 'paper' ? 'yellow'
                  : '#888888';
  const pnlVal   = state?.dailyPnl || 0;
  const pnlColor = pnlVal >= 0 ? '#5a9f5a' : '#c04040';
  const pnlSign  = pnlVal >= 0 ? '+' : '';
  const winRate  = ((state?.winRate || 0) * 100).toFixed(0);
  const solPrice = state?.solPrice > 0 ? `$${state.solPrice.toFixed(2)}` : '—';

  return React.createElement(Box, { flexDirection: 'column', paddingX: 2, paddingTop: 0 },
    // Single text row — no flex splitting, fits 80 cols
    React.createElement(Box, null,
      React.createElement(Text, null,
        React.createElement(Text, { color: '#c8a020', bold: true }, '◆ PONYOU'),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: modeColor, bold: true }, (state?.mode || 'demo').toUpperCase()),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: '#888888' }, (state?.balance || 0).toFixed(4) + ' SOL'),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: '#888888' }, state?.strategy || '—'),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: '#888888' }, (state?.openPositions || 0) + ' pos'),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: '#888888' }, winRate + '% win'),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: pnlColor }, pnlSign + pnlVal.toFixed(4) + ' SOL'),
        React.createElement(Text, { color: '#2e2e2e' }, ' │ '),
        React.createElement(Text, { color: '#555555' }, solPrice),
      ),
    ),
    // Thin divider
    React.createElement(Box, {
      borderStyle: 'single', borderColor: '#2a2a2a',
      borderTop: false, borderLeft: false, borderRight: false, borderBottom: true,
    }),
  );
}

// ── Message components ──
function UserMessage({ text }) {
  return React.createElement(Box, { flexDirection: 'column', marginBottom: 1 },
    React.createElement(Box, { paddingLeft: 2 },
      React.createElement(Text, { color: 'yellow', bold: true }, '❯  '),
      React.createElement(Text, { color: 'white', bold: true }, text),
    ),
  );
}

function AssistantMessage({ lines }) {
  return React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 5 },
    lines.map((line, i) => React.createElement(TagLine, { key: i, text: line })),
  );
}

function WelcomeMessage({ lines }) {
  return React.createElement(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 2 },
    lines.map((line, i) => React.createElement(TagLine, { key: i, text: line })),
  );
}

function InfoMessage({ text }) {
  return React.createElement(Box, { paddingLeft: 5, marginBottom: 0 },
    React.createElement(TagLine, { text: text || '' }),
  );
}

function Message({ msg }) {
  switch (msg.type) {
    case 'welcome':   return React.createElement(WelcomeMessage, { lines: msg.lines });
    case 'user':      return React.createElement(UserMessage, { text: msg.text });
    case 'assistant': return React.createElement(AssistantMessage, { lines: msg.lines });
    case 'info':      return React.createElement(InfoMessage, { text: msg.text });
    default:          return null;
  }
}

// ── Slash command panel — minimal Claude Code style ──
function SlashPanel({ commands, selectedIdx, visible }) {
  if (!visible || commands.length === 0) return null;

  const MAX_SHOW = 7;
  const scrollOffset = Math.max(0, Math.min(
    selectedIdx - Math.floor(MAX_SHOW / 2),
    Math.max(0, commands.length - MAX_SHOW),
  ));
  const shown      = commands.slice(scrollOffset, scrollOffset + MAX_SHOW);
  const aboveCount = scrollOffset;
  const belowCount = Math.max(0, commands.length - scrollOffset - MAX_SHOW);

  const hintText = [
    `${selectedIdx + 1}/${commands.length}`,
    aboveCount > 0 ? `↑${aboveCount}` : '',
    belowCount > 0 ? `↓${belowCount}` : '',
    'Tab',
    'Enter',
    'Esc',
  ].filter(Boolean).join('  ·  ');

  return React.createElement(Box, {
    flexDirection: 'column',
    marginX: 1,
    borderStyle: 'round',
    borderColor: '#3a3a3a',
    paddingX: 1,
  },
    // Command rows
    ...shown.map((cmd, i) => {
      const sel = (i + scrollOffset) === selectedIdx;
      return React.createElement(Box, { key: cmd.name },
        sel
          ? React.createElement(Text, null,
              React.createElement(Text, { color: 'cyan' }, '▸ '),
              React.createElement(Text, { color: 'white', bold: true }, cmd.name.padEnd(17)),
              React.createElement(Text, { color: '#888888' }, cmd.desc),
            )
          : React.createElement(Text, null,
              React.createElement(Text, null, '  '),
              React.createElement(Text, { color: '#5a9fd4' }, cmd.name.padEnd(17)),
              React.createElement(Text, { color: '#555555' }, cmd.desc),
            ),
      );
    }),
    // Footer hint — thin separator + compact hint line
    React.createElement(Box, {
      key: '__footer',
      borderStyle: 'single',
      borderColor: '#333333',
      borderTop: true, borderLeft: false, borderRight: false, borderBottom: false,
    },
      React.createElement(Text, { color: '#444444' }, hintText),
    ),
  );
}

// ── Input box ── (custom, no ink-text-input to avoid v6 focus conflict)
function InputArea({ value, onChange, onSubmit, disabled }) {
  const valueRef    = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => { valueRef.current    = value;    }, [value]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSubmitRef.current = onSubmit; }, [onSubmit]);

  useInput((char, key) => {
    if (disabled) return;
    if (key.return) { onSubmitRef.current(valueRef.current); return; }
    if (key.backspace || key.delete) { onChangeRef.current(valueRef.current.slice(0, -1)); return; }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (key.ctrl || key.meta || key.escape || key.tab) return;
    if (char && char.length === 1 && char.charCodeAt(0) >= 32)
      onChangeRef.current(valueRef.current + char);
  }, { isActive: !disabled });

  const cursor = React.createElement(Text, { inverse: true }, ' ');

  return React.createElement(Box, {
    borderStyle: 'single',
    borderColor: disabled ? '#3a3a3a' : '#555555',
    paddingX: 1,
    marginX: 1,
  },
    React.createElement(Text, { color: disabled ? '#444444' : '#888888' }, '❯ '),
    disabled
      ? React.createElement(Box, null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: '#555555' }, '  thinking…'),
        )
      : React.createElement(Box, null,
          React.createElement(Text, { color: 'white' }, value),
          cursor,
          value.length === 0
            ? React.createElement(Text, { color: '#3a3a3a' }, ' type a message or /command')
            : null,
        ),
  );
}

// ── App ──
function App({ onAction, initialMessage }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();

  const [messages,      setMessages]      = useState([]);
  const [input,         setInput]         = useState('');
  const [thinking,      setThinking]      = useState(false);
  const [ponyouState,   setPonyouState]   = useState(null);
  const [slashSelected, setSlashSelected] = useState(0);
  const [termSize,      setTermSize]      = useState({
    rows: stdout?.rows || process.stdout.rows || 24,
    cols: stdout?.columns || process.stdout.columns || 80,
  });

  // Terminal resize
  useEffect(() => {
    function onResize() {
      setTermSize({
        rows: stdout?.rows || process.stdout.rows || 24,
        cols: stdout?.columns || process.stdout.columns || 80,
      });
    }
    stdout?.on('resize', onResize);
    return () => stdout?.off('resize', onResize);
  }, [stdout]);

  // Bot state polling
  useEffect(() => {
    async function load() {
      try {
        const { readPonyouState } = await import('./data/state-bridge.js');
        setPonyouState(readPonyouState());
      } catch {}
    }
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Welcome
  useEffect(() => {
    const msgs = [{ type: 'welcome', lines: getWelcome() }];
    if (initialMessage === 'monitor-returned')
      msgs.push({ type: 'info', text: '{gray}returned from monitor{/gray}' });
    else if (initialMessage === 'wizard-returned')
      msgs.push({ type: 'info', text: '{gray}returned from wizard{/gray}' });
    setMessages(msgs);
  }, []);

  // Slash panel
  const showSlashPanel = input.startsWith('/') && !thinking;
  const filteredCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const q = input.split(' ')[0].toLowerCase();
    return SLASH_COMMANDS.filter(c => c.name.startsWith(q));
  }, [input]);

  // Reset selection when list changes
  useEffect(() => { setSlashSelected(0); }, [filteredCommands.length]);

  // Keyboard intercept
  useInput((char, key) => {
    if (key.escape) {
      if (input.length > 0) setInput('');
      return;
    }
    // Ctrl+L clears messages like a terminal
    if (key.ctrl && char === 'l') {
      setMessages([]);
      return;
    }
    if (!showSlashPanel || filteredCommands.length === 0) return;
    if (key.upArrow) {
      setSlashSelected(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSlashSelected(prev => Math.min(filteredCommands.length - 1, prev + 1));
    } else if (key.tab) {
      const cmd = filteredCommands[slashSelected] ?? filteredCommands[0];
      if (cmd) setInput(cmd.name + ' ');
    }
  }, { isActive: true });

  const addMsg = useCallback((msg) => {
    setMessages(prev => {
      const next = [...prev, msg];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const handleSubmit = useCallback(async (raw) => {
    let text = raw?.trim();
    if (!text || thinking) return;

    // Autocomplete if typing partial slash command
    if (showSlashPanel && filteredCommands.length > 0) {
      const isExact = SLASH_COMMANDS.some(c => c.name === text.split(' ')[0]);
      if (!isExact) {
        const sel = filteredCommands[slashSelected] ?? filteredCommands[0];
        if (sel) {
          const args = text.includes(' ') ? text.slice(text.indexOf(' ')) : '';
          text = sel.name + args;
        }
      }
    }

    setInput('');
    addMsg({ type: 'user', text });

    const result = processMessage(text);

    if (result.type === 'action') {
      addMsg({ type: 'info', text: result.message || '' });
      setTimeout(() => {
        if (onAction) onAction(result.action);
        else if (result.action === 'quit') exit();
      }, 300);
      return;
    }
    if (result.type === 'clear') { setMessages([]); return; }
    if (result.type === 'async') {
      addMsg({ type: 'info', text: result.message || '' });
      setThinking(true);
      try {
        const lines = await result.asyncFn();
        setThinking(false);
        addMsg({ type: 'assistant', lines });
      } catch (e) {
        setThinking(false);
        addMsg({ type: 'assistant', lines: [`  {red}Error: ${e.message}{/red}`] });
      }
      return;
    }
    if (result.type === 'response') {
      addMsg({ type: 'assistant', lines: result.lines });
    }
  }, [addMsg, exit, onAction, thinking, showSlashPanel, filteredCommands, slashSelected]);

  const visibleMessages = messages.slice(-40);

  return React.createElement(Box, { flexDirection: 'column', height: termSize.rows },
    // Header
    React.createElement(Header, { state: ponyouState }),

    // Chat area
    React.createElement(Box, {
      flexDirection: 'column',
      flexGrow: 1,
      overflow: 'hidden',
      paddingTop: 1,
    },
      visibleMessages.map((msg, i) => React.createElement(Message, { key: i, msg })),
    ),

    // Thinking indicator (shown in chat area when processing)
    thinking && React.createElement(Box, { paddingLeft: 5, paddingBottom: 1 },
      React.createElement(Spinner, { type: 'dots' }),
      React.createElement(Text, { color: '#444444' }, '  processing'),
    ),

    // Slash command panel (above input, only when typing /)
    React.createElement(SlashPanel, {
      commands: filteredCommands,
      selectedIdx: slashSelected,
      visible: showSlashPanel,
    }),

    // Input box
    React.createElement(InputArea, {
      value: input,
      onChange: setInput,
      onSubmit: handleSubmit,
      disabled: thinking,
    }),

    // Footer hint
    React.createElement(Box, { paddingX: 2 },
      React.createElement(Text, { color: 'gray' },
        showSlashPanel
          ? ''
          : 'type /command or ask anything   ·   Tab   ·   Esc   ·   Ctrl+C exit',
      ),
    ),
  );
}

export default App;
