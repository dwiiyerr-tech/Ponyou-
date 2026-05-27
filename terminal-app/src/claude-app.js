// PONYOU — Claude Code-style Terminal Interface

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useStdout, useStdin, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { getWelcome, processMessage } from './agent-brain.js';

// ── Slash commands registry ──
const SLASH_COMMANDS = [
  { name: '/monitor',    desc: 'Live monitoring dashboard' },
  { name: '/wizard',     desc: 'Setup wizard & bot config' },
  { name: '/status',     desc: 'Bot status, mode & balance' },
  { name: '/positions',  desc: 'Open positions with PnL' },
  { name: '/strategies', desc: 'Available trading strategies' },
  { name: '/tools',      desc: 'Tool health check' },
  { name: '/config',     desc: 'Current configuration' },
  { name: '/metrics',    desc: 'Performance stats & streaks' },
  { name: '/cmd',        desc: 'Send bot command: start stop pause sweep' },
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
                  : 'gray';
  const pnlVal   = state?.dailyPnl || 0;
  const pnlColor = pnlVal >= 0 ? 'green' : 'red';
  const pnlSign  = pnlVal >= 0 ? '+' : '';
  const winRate  = ((state?.winRate || 0) * 100).toFixed(0);
  const solPrice = state?.solPrice > 0 ? `$${state.solPrice.toFixed(2)}` : '--';

  return React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'gray',
    paddingX: 1,
  },
    // Logo + tagline row
    React.createElement(Box, { flexDirection: 'row' },
      React.createElement(Box, { flexDirection: 'column', marginRight: 3 },
        React.createElement(Text, { color: 'yellow' }, '╔═╗ ╔═╗ ╔╗╔ ╦ ╦ ╔═╗ ╦ ╦'),
        React.createElement(Text, { color: 'yellow' }, '╠═╝ ║ ║ ║║║ ╚╦╝ ║ ║ ║ ║'),
        React.createElement(Text, { color: 'yellow' }, '╩   ╚═╝ ╝╚╝  ╩  ╚═╝ ╚═╝'),
      ),
      React.createElement(Box, { flexDirection: 'column', justifyContent: 'center' },
        React.createElement(Text, { color: 'white' }, 'Solana Trading Agent'),
        React.createElement(Text, { color: 'gray' }, 'AI-powered memecoin bot  ·  SOL ' + solPrice),
      ),
    ),
    // Status row
    React.createElement(Box, { flexDirection: 'row', marginTop: 0 },
      React.createElement(Text, { color: modeColor, bold: true }, (state?.mode || 'demo').toUpperCase()),
      React.createElement(Text, { color: 'gray' }, '  ·  '),
      React.createElement(Text, { color: 'yellow' }, (state?.balance || 0).toFixed(4) + ' SOL'),
      React.createElement(Text, { color: 'gray' }, '  ·  '),
      React.createElement(Text, { color: 'white' }, state?.strategy || '—'),
      React.createElement(Text, { color: 'gray' }, '  ·  '),
      React.createElement(Text, { color: 'cyan' }, (state?.openPositions || 0) + ' pos'),
      React.createElement(Text, { color: 'gray' }, '  ·  '),
      React.createElement(Text, { color: 'white' }, winRate + '% win'),
      React.createElement(Text, { color: 'gray' }, '  ·  '),
      React.createElement(Text, { color: pnlColor }, pnlSign + pnlVal.toFixed(2) + ' SOL pnl'),
    ),
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

// ── Slash command panel ──
function SlashPanel({ commands, selectedIdx, visible }) {
  if (!visible || commands.length === 0) return null;

  const MAX_SHOW = 8;
  const shown    = commands.slice(0, MAX_SHOW);

  return React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: 'gray',
  },
    // Header row
    React.createElement(Box, { paddingX: 2 },
      React.createElement(Text, { color: 'gray' }, `${commands.length} command${commands.length !== 1 ? 's' : ''}`),
    ),
    // Command rows
    ...shown.map((cmd, i) => {
      const sel = i === selectedIdx;
      return React.createElement(Box, { key: cmd.name, paddingX: 1 },
        React.createElement(Text, { color: sel ? 'yellow' : 'gray' }, sel ? ' ▶ ' : '   '),
        React.createElement(Text, {
          color: sel ? 'yellow' : 'white',
          bold: sel,
        }, cmd.name.padEnd(16)),
        React.createElement(Text, { color: 'gray' }, cmd.desc),
      );
    }),
    commands.length > MAX_SHOW && React.createElement(Box, { paddingX: 4 },
      React.createElement(Text, { color: 'gray' }, `+${commands.length - MAX_SHOW} more`),
    ),
    // Nav hint
    React.createElement(Box, { paddingX: 2 },
      React.createElement(Text, { color: 'gray' }, '↑↓ navigate   Tab complete   Esc dismiss'),
    ),
  );
}

// ── Input box ──
function InputArea({ value, onChange, onSubmit, disabled }) {
  return React.createElement(Box, {
    borderStyle: 'round',
    borderColor: disabled ? 'gray' : 'yellow',
    paddingX: 1,
  },
    React.createElement(Text, { color: disabled ? 'gray' : 'yellow', bold: true }, '❯  '),
    disabled
      ? React.createElement(Box, null,
          React.createElement(Spinner, { type: 'dots' }),
          React.createElement(Text, { color: 'gray' }, '  processing'),
        )
      : React.createElement(TextInput, {
          value,
          onChange,
          onSubmit,
          placeholder: 'type a message or /command',
        }),
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
    if (!showSlashPanel || filteredCommands.length === 0) return;
    if (key.upArrow) {
      setSlashSelected(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSlashSelected(prev => Math.min(filteredCommands.length - 1, prev + 1));
    } else if (key.tab) {
      const cmd = filteredCommands[slashSelected] ?? filteredCommands[0];
      if (cmd) setInput(cmd.name + ' ');
    }
  }, { isActive: isRawModeSupported });

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
          ? '↑↓ navigate   Tab complete   Esc dismiss   Enter execute'
          : 'type /command or ask anything   ·   Esc clear   ·   Ctrl+C exit',
      ),
    ),
  );
}

export default App;
