#!/usr/bin/env node
// PONYOU Setup Wizard — minimalist full-featured config
// ponyou wizard  ▸  12 sections  ▸  writes user-config.json

import blessed from 'blessed';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const CONFIG_PATH = resolve(ROOT, 'user-config.json');

// WS-1: pull in the same atomic + lock primitives the rest of the codebase
// uses for user-config.json. Without these, a wizard save was a raw
// writeFileSync — non-atomic (partial write on process kill) and racing
// against dashboard / executor writes. Loaded dynamically so the wizard
// keeps working in dev environments where the module path resolves
// differently.
let _atomicWriteJson = null;
let _withFileLock = null;
try {
  const aw = await import(`${ROOT}/atomic-write.js`);
  _atomicWriteJson = aw.atomicWriteJson;
  _withFileLock = aw.withFileLock;
} catch {
  // Fall back to raw writeFileSync below if the import fails.
}

// ── Load strategy presets dynamically ─────────────────────────────────────
let STRATEGY_OPTIONS = [];
try {
  const { PRESETS } = await import(`${ROOT}/strategies.js`);
  STRATEGY_OPTIONS = Object.entries(PRESETS).map(([id, s]) => {
    const f = s.filters || {};
    const sl     = s.stoploss ? `SL ${(s.stoploss * 100).toFixed(0)}%` : '';
    const mcap   = (f.min_mcap_usd || f.max_mcap_usd) ? `$${fmtNum(f.min_mcap_usd)}–$${fmtNum(f.max_mcap_usd)} mcap` : '';
    const staged = s.staged_entry?.enabled ? `${s.staged_entry.stages}-stage DCA` : '';
    const holders = f.min_holders ? `${f.min_holders}+ holders` : '';
    const label  = id === 'day_phase_trading' ? 'Day Phase'
                 : id === 'dip_buy'           ? 'Dip Buy'
                 : id === 'smart_money'       ? 'Smart Money'
                 : id.charAt(0).toUpperCase() + id.slice(1);
    // shorten description to fit one line
    const rawDesc = s.description || '';
    const shortDesc = rawDesc.length > 55 ? rawDesc.slice(0, 52) + '…' : rawDesc;
    const stats = [sl, mcap, staged, holders].filter(Boolean).join('  ·  ');
    return { value: id, label, desc: shortDesc, stats };
  });
} catch {
  // fallback if strategies.js unavailable
  STRATEGY_OPTIONS = [
    { value: 'scalping',          label: 'Scalping',    desc: 'Default · Freqtrade ROI · SL -15%' },
    { value: 'sniper',            label: 'Sniper',      desc: 'Low-mcap strict · SL -25%' },
    { value: 'dip_buy',           label: 'Dip Buy',     desc: '3-stage DCA · ATH dip entry · SL -20%' },
    { value: 'smart_money',       label: 'Smart Money', desc: '>1k holders · 2-stage · SL -25%' },
    { value: 'degen',             label: 'Degen',       desc: 'Rule-based · no LLM · SL -15%' },
    { value: 'day_phase_trading', label: 'Day Phase',   desc: 'Swing 3–7 days · weekend entry · SL -30%' },
  ];
}

function fmtNum(n) {
  if (!n) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

// ── Per-strategy position limit defaults (mirrors position-limits.js) ─────
const STRATEGY_POS_DEFAULTS = {
  scalping:          { maxPositions: 3, minSolToActivate: 0.5,  mult: 1.2 },
  sniper:            { maxPositions: 2, minSolToActivate: 1.0,  mult: 0.6 },
  dip_buy:           { maxPositions: 3, minSolToActivate: 1.0,  mult: 1.0 },
  smart_money:       { maxPositions: 3, minSolToActivate: 0.5,  mult: 1.0 },
  degen:             { maxPositions: 3, minSolToActivate: 0.5,  mult: 1.2 },
  day_phase_trading: { maxPositions: 3, minSolToActivate: 1.5,  mult: 0.8 },
};

// Build per-strategy fields dynamically from STRATEGY_OPTIONS
const STRATEGY_LIMIT_FIELDS = STRATEGY_OPTIONS.flatMap(s => {
  const d = STRATEGY_POS_DEFAULTS[s.value] || { maxPositions: 3, minSolToActivate: 0.5, mult: 1.0 };
  return [
    { type: 'divider', label: `${s.label}  (Kelly ×${d.mult})` },
    {
      key: `positionLimits.perStrategy.${s.value}.maxPositions`,
      label: 'Max Positions',
      hint: `Max concurrent ${s.label} positions (Kelly mode overrides this)`,
      type: 'number', default: d.maxPositions,
    },
    {
      key: `positionLimits.perStrategy.${s.value}.minSolToActivate`,
      label: 'Min SOL to Open',
      hint: 'Minimum wallet SOL balance before any new position is allowed',
      type: 'number', default: d.minSolToActivate,
    },
    {
      key: `positionLimits.perStrategy.${s.value}.maxPerCoin`,
      label: 'Max Per Token',
      hint: 'Max entries for the same token mint (1 = no double-dipping)',
      type: 'number', default: 1,
    },
  ];
});

// ── Load existing config ───────────────────────────────────────────────────
let formData = {};
try { if (existsSync(CONFIG_PATH)) formData = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

// ── Section definitions ────────────────────────────────────────────────────
const SECTIONS = [
  {
    id: 'welcome', label: 'Welcome', icon: '◆', type: 'profile',
    description: 'Choose a starting profile to pre-fill all settings',
    profiles: [
      {
        label: 'Conservative',
        desc: 'Safe defaults · confirm mode · strict filters · low risk',
        apply: { executionMode: 'demo', strategy: 'smart_money', confirmMode: true, maxPositions: 1, positionSizePct: 0.15, minMcap: 300000, minHolders: 800, trashFilterEnabled: true, rugCheckEnabled: true, devBlacklistEnabled: true },
      },
      {
        label: 'Balanced',
        desc: 'Default settings · good for most users',
        apply: { executionMode: 'demo', strategy: 'scalping', confirmMode: true, maxPositions: 2, positionSizePct: 0.35, minMcap: 150000, minHolders: 500, trashFilterEnabled: true, rugCheckEnabled: true, devBlacklistEnabled: true },
      },
      {
        label: 'Aggressive',
        desc: 'Higher risk · more positions · fast-track enabled',
        apply: { executionMode: 'demo', strategy: 'sniper', confirmMode: false, maxPositions: 4, positionSizePct: 0.50, minMcap: 50000, minHolders: 200, fastTrackEnabled: true, trashFilterEnabled: true },
      },
      {
        label: 'Custom',
        desc: 'Configure everything manually from scratch',
        apply: null,
      },
    ],
  },
  {
    id: 'connection', label: 'Connection', icon: '◈', type: 'fields',
    description: 'RPC, wallet keys, and API credentials',
    fields: [
      { key: 'rpcUrl',            label: 'RPC URL',             hint: 'Helius, QuickNode, or Triton endpoint', type: 'text' },
      { key: 'walletKey',         label: 'Wallet Private Key',  hint: 'Base58 encoded · stored locally only',  type: 'secret' },
      { key: 'shyftApiKey',       label: 'Shyft API Key',       hint: 'Required for on-chain data queries',    type: 'secret' },
      { key: 'telegramBotToken',  label: 'Telegram Bot Token',  hint: 'Optional · for Telegram trade alerts',  type: 'secret' },
      { key: 'telegramChatId',    label: 'Telegram Chat ID',    hint: 'Optional · your Telegram chat ID',      type: 'text' },
    ],
  },
  {
    id: 'mode', label: 'Trading Mode', icon: '◉', type: 'select',
    key: 'executionMode',
    description: 'How Ponyou executes trades',
    options: [
      { value: 'demo',   label: 'Demo',   desc: 'Paper trading · no real SOL spent · uses live mainnet data' },
      { value: 'live',   label: 'Live',   desc: 'Real trades on mainnet · spends real SOL' },
      { value: 'devnet', label: 'Devnet', desc: 'Free devnet SOL · for testing only' },
    ],
  },
  {
    id: 'strategy', label: 'Strategy', icon: '◈', type: 'select',
    key: 'strategy',
    description: 'Active trading strategy — loaded from strategies.js',
    options: STRATEGY_OPTIONS,
  },
  {
    id: 'risk', label: 'Exit Rules', icon: '◇', type: 'fields',
    description: 'Stop loss, trailing stop, and take profit',
    fields: [
      // ── Hard Stop Loss ────────────────────────────────────────
      { type: 'divider', label: 'Hard Stop Loss' },
      { key: 'stopLossPct',        label: 'Stop Loss %',          hint: 'Immediate sell at this loss % (e.g. -15). Blank = use strategy default (-15%~-30%)', type: 'number', default: null },
      { key: 'deployAmountSol',    label: 'Deploy Amount SOL',    hint: 'Base SOL to spend per trade entry',                                                   type: 'number', default: 0.5 },
      { key: 'gasReserve',         label: 'Gas Reserve SOL',      hint: 'Always kept aside for transaction fees',                                               type: 'number', default: 0.2 },
      // ── Trailing Stop ─────────────────────────────────────────
      { type: 'divider', label: 'Trailing Stop' },
      { key: 'trailingTakeProfit', label: 'Enable Trailing Stop', hint: 'Activates once profit reaches trigger — then follows peak down',                      type: 'toggle', default: true },
      { key: 'trailingTriggerPct', label: 'Activate at +%',       hint: 'Start trailing when PnL reaches this % (strategy default: scalping=20%, sniper=20%, day_phase=30%)', type: 'number', default: null },
      { key: 'trailingDropPct',    label: 'Drop Tolerance %',     hint: 'Sell when price drops this % from peak (strategy default: scalping=5%, sniper=8%, day_phase=10%)',    type: 'number', default: null },
      // ── Immediate Take Profit ─────────────────────────────────
      { type: 'divider', label: 'Take Profit' },
      { key: 'takeProfitPct',      label: 'Immediate TP %',       hint: 'Instant sell at this profit — bypasses trailing. Blank = let trailing handle exit',  type: 'number', default: null },
    ],
  },
  {
    id: 'positions', label: 'Positions', icon: '◈', type: 'fields',
    description: 'Open position limits and Kelly position-count formula',
    fields: [
      // ── Position Mode ─────────────────────────────────────────
      { type: 'divider', label: 'Position Mode' },
      { key: 'positionLimits.mode',          label: 'Limit Mode',          hint: '"manual" = use maxPositions below  |  "kelly" = auto-compute from win rate',      type: 'text',   default: 'manual' },
      { key: 'positionLimits.kellyFraction', label: 'Kelly Fraction',      hint: 'In kelly mode: 0.5 = half-Kelly (safer), 1.0 = full Kelly  |  formula: K%×frac×12', type: 'number', default: 0.5 },
      // ── Per-Strategy ──────────────────────────────────────────
      { type: 'divider', label: 'Per-Strategy Limits  (manual mode)' },
      ...STRATEGY_LIMIT_FIELDS,
    ],
  },
  {
    id: 'kelly', label: 'Kelly Sizing', icon: '◇', type: 'fields',
    description: 'Kelly criterion for trade size and capital tier thresholds',
    fields: [
      // ── Trade Size Kelly ──────────────────────────────────────
      { type: 'divider', label: 'Trade Size Kelly  f=(b·p−q)/b' },
      { key: 'kellyEnabled',         label: 'Enable Kelly Sizing',  hint: 'Scale deploy amount using Kelly formula from trade history',          type: 'toggle', default: true },
      { key: 'kellyFraction',        label: 'Kelly Fraction',        hint: '0.5 = half-Kelly (recommended). 1.0 = full Kelly (aggressive)',       type: 'number', default: 0.5 },
      { key: 'kellyMinFraction',     label: 'Min Fraction',          hint: 'Kelly never goes below this fraction of deploy amount',               type: 'number', default: 0.1 },
      { key: 'kellyMaxFraction',     label: 'Max Fraction',          hint: 'Kelly never exceeds this fraction of bankroll',                       type: 'number', default: 0.8 },
      { key: 'kellyMinSampleTrades', label: 'Min Sample Trades',     hint: 'Minimum closed trades before Kelly activates — below this = fallback', type: 'number', default: 15 },
      // ── Capital Tiers ─────────────────────────────────────────
      { type: 'divider', label: 'Capital Tiers' },
      { key: 'capitalSizingMicroThreshold', label: 'Micro Cap $',         hint: 'Portfolio below this USD → flat sizing (not Kelly)',                       type: 'number', default: 50 },
      { key: 'capitalSizingMicroHot',       label: 'Micro HOT %',         hint: 'Flat fraction in HOT market when capital < micro cap (0.15 = 15%)',        type: 'number', default: 0.15 },
      { key: 'capitalSizingMicroWarm',      label: 'Micro WARM %',        hint: 'Flat fraction in NORMAL/WARM market when capital < micro cap (0.08 = 8%)', type: 'number', default: 0.08 },
      { key: 'capitalSizingFullThreshold',  label: 'Full Kelly Cap $',    hint: 'Portfolio above this USD → full Kelly (no growth cap)',                    type: 'number', default: 200 },
      { key: 'capitalSizingGrowthCap',      label: 'Growth Cap %',        hint: 'Max deploy fraction in GROWTH tier ($50–$200) — caps Kelly output',       type: 'number', default: 0.20 },
      { key: 'capitalSizingGrowthFallback', label: 'Growth Fallback %',   hint: 'Fraction used in GROWTH tier when no trade history yet',                   type: 'number', default: 0.10 },
      // ── Kelly Mode Unlock ─────────────────────────────────────
      { type: 'divider', label: 'Kelly Mode Unlock' },
      { key: 'kellyMode3MinTrades',     label: 'Mode 3 Min Trades',    hint: 'Mode 3 (Full Kelly on full bankroll) requires ≥N live trades',          type: 'number', default: 50 },
      { key: 'kellyMode3MinWinRate',    label: 'Mode 3 Min Win Rate',   hint: 'Mode 3 requires this win rate (1.0 = 100% wins — effectively disabled)', type: 'number', default: 1.0 },
      { key: 'kellyMode3MinConviction', label: 'Mode 3 Min Conviction', hint: 'Mode 3 requires conviction score ≥ this (0–1)',                         type: 'number', default: 0.99 },
      { key: 'kellyMode3MinMemory',     label: 'Mode 3 Min Memory',     hint: 'Mode 3 requires ≥N semantic memory entries (learned patterns)',          type: 'number', default: 200 },
    ],
  },
  {
    id: 'filters', label: 'Token Filters', icon: '◫', type: 'fields',
    description: 'Screening thresholds for new token candidates',
    fields: [
      { key: 'minMcap',      label: 'Min Market Cap $',  hint: 'Reject tokens below this mcap',    type: 'number', default: 150000 },
      { key: 'maxMcap',      label: 'Max Market Cap $',  hint: 'Reject tokens above this mcap',    type: 'number', default: 10000000 },
      { key: 'minTvl',       label: 'Min TVL $',         hint: 'Minimum pool liquidity',           type: 'number', default: 10000 },
      { key: 'maxTvl',       label: 'Max TVL $',         hint: 'Maximum pool liquidity',           type: 'number', default: 150000 },
      { key: 'minVolume',    label: 'Min Volume $',      hint: '24h volume floor',                 type: 'number', default: 500 },
      { key: 'minHolders',   label: 'Min Holders',       hint: 'Minimum token holder count',       type: 'number', default: 500 },
      { key: 'minOrganic',   label: 'Min Organic %',     hint: 'Organic liquidity floor (0–100)',  type: 'number', default: 60 },
      { key: 'maxTop10Pct',  label: 'Max Top-10 %',      hint: 'Reject if top 10 hold > N%',       type: 'number', default: 60 },
      { key: 'maxBundlePct', label: 'Max Bundle %',      hint: 'Reject if bundles hold > N%',      type: 'number', default: 30 },
      { key: 'minTokenFeesSol', label: 'Min Fees SOL',   hint: 'Global fees as scam filter',       type: 'number', default: 30 },
    ],
  },
  {
    id: 'security', label: 'Security', icon: '◉', type: 'toggles',
    description: 'Scam and rug-pull detection layers',
    fields: [
      { key: 'trashFilterEnabled',             label: 'Trash Filter',        hint: 'Honeypot & scam name detection',       default: true },
      { key: 'devBlacklistEnabled',            label: 'Dev Blacklist',       hint: 'Track and block repeat rug devs',      default: true },
      { key: 'rugCheckEnabled',                label: 'Rug Check',           hint: 'RUG.fyi API integration',             default: true },
      { key: 'sellSimEnabled',                 label: 'Sell Simulation',     hint: 'Simulate exit to detect locked tokens', default: true },
      { key: 'rugAnomalyEnabled',              label: 'Rug Anomaly',         hint: 'Detect unusual holder dump patterns',  default: true },
      { key: 'rugLLMEnabled',                  label: 'LLM Rug Analysis',    hint: 'Costs LLM credits — enable after 10+ rugs', default: false },
      { key: 'excludeHighSupplyConcentration', label: 'Supply Concentration', hint: 'Reject tokens with concentrated supply', default: true },
    ],
  },
  {
    id: 'automation', label: 'Automation', icon: '◈', type: 'fields',
    description: 'Trading flow automation and adaptive features',
    fields: [
      { key: 'confirmMode',              label: 'Confirm Mode',       hint: 'Require Telegram approval before each buy',             type: 'toggle', default: true },
      { key: 'fastTrackEnabled',         label: 'Fast Track',         hint: 'Bypass LLM for high-confidence tokens (see Kelly Sizing)', type: 'toggle', default: false },
      { key: 'stagedEntryEnabled',       label: 'Staged Entry',       hint: 'Multi-stage DCA averaging down',                         type: 'toggle', default: false },
      { key: 'darwinEnabled',            label: 'Darwinian Weights',  hint: 'Auto-adjust signal weights from trade outcomes',          type: 'toggle', default: true },
      { key: 'decisionWorkflowEnabled',  label: 'Decision Workflow',  hint: 'Conviction-gated entry: probe first, full size later',   type: 'toggle', default: true },
      { key: 'strategyEvolutionEnabled', label: 'Strategy Evolution', hint: 'Auto-adapt strategy params over time',                   type: 'toggle', default: false },
      { key: 'jitoEnabled',              label: 'Jito Bundles',       hint: 'MEV-resistant bundles (needs Jito auth token)',          type: 'toggle', default: false },
    ],
  },
  {
    id: 'dailyguard', label: 'Daily Guard', icon: '◇', type: 'fields',
    description: 'Auto-pause trading after hitting daily win/loss limits',
    fields: [
      { key: 'dailyTradeGuard.enabled',         label: 'Enable Daily Guard',  hint: 'Pause when daily limit hit',     type: 'toggle', default: false },
      { key: 'dailyTradeGuard.maxWinsPerDay',   label: 'Max Wins / Day',      hint: 'Stop after N profitable trades', type: 'number', default: 3 },
      { key: 'dailyTradeGuard.maxLossesPerDay', label: 'Max Losses / Day',    hint: 'Stop after N losing trades',     type: 'number', default: 3 },
      { key: 'pilotEnabled',                    label: 'Trading Plan',         hint: 'Compound-growth plan simulator', type: 'toggle', default: true },
      { key: 'dailyTargetPct',                  label: 'Daily Target %',       hint: 'Session pause at this profit',  type: 'number', default: 25 },
      { key: 'dailyStopLossPct',                label: 'Daily Stop Loss %',    hint: 'Negative — max daily loss',     type: 'number', default: -10 },
      { key: 'maxConsecutiveLosses',            label: 'Max Consec. Losses',   hint: 'Trigger learning mode pause',   type: 'number', default: 3 },
    ],
  },
  {
    id: 'aimodel', label: 'AI Model', icon: '◈', type: 'fields',
    description: 'LLM settings for token analysis and decision-making',
    fields: [
      { key: 'llmModel',    label: 'Model ID',     hint: 'e.g. minimax/minimax-m2.7',        type: 'text',   default: 'minimax/minimax-m2.7' },
      { key: 'llmProvider', label: 'Provider',     hint: 'openrouter or custom',              type: 'text',   default: 'openrouter' },
      { key: 'llmBaseUrl',  label: 'Base URL',     hint: 'Leave blank for OpenRouter default', type: 'text',   default: '' },
      { key: 'llmApiKey',   label: 'API Key',      hint: 'Provider API key',                  type: 'secret', default: '' },
      { key: 'temperature', label: 'Temperature',  hint: '0=deterministic → 1=creative',      type: 'number', default: 0.373 },
      { key: 'maxTokens',   label: 'Max Tokens',   hint: 'Max LLM response length',            type: 'number', default: 4096 },
    ],
  },
  {
    id: 'vault', label: 'Vault', icon: '◇', type: 'fields',
    description: 'Auto-sweep profits to a cold wallet address',
    fields: [
      { key: 'vault.sweep.enabled',           label: 'Enable Vault Sweep', hint: 'Auto-transfer profits to cold wallet', type: 'toggle', default: false },
      { key: 'vault.vaultWallet',             label: 'Vault Address',      hint: 'Cold wallet Solana public key',        type: 'text',   default: '' },
      { key: 'vault.sweep.sweepPct',          label: 'Sweep %',            hint: '% of profits to sweep out',           type: 'number', default: 35 },
      { key: 'vault.sweep.sweepIntervalDays', label: 'Interval (days)',    hint: 'How often to sweep (min 1)',           type: 'number', default: 7 },
      { key: 'vault.sweep.minSweepSol',       label: 'Min Sweep SOL',      hint: 'Skip sweep if below this amount',     type: 'number', default: 0.001 },
    ],
  },
  {
    id: 'review', label: 'Review', icon: '◆', type: 'review',
    description: 'Review all settings and save',
  },
];

// ── Screen ─────────────────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'PONYOU', fullUnicode: true, dockBorders: false });
const SIDEBAR_W = 20;

// Dynamic dimensions — always read current terminal size
function W() { return Math.max(40, screen.cols); }
function H() { return Math.max(12, screen.rows); }
function CW() { return W() - SIDEBAR_W; }

let sectionIdx = 0;
let fieldIdx = 0;
let selectCursor = 0;
let inputMode = false;
let message = '';

// ── Widgets ────────────────────────────────────────────────────────────────
const headerBar = blessed.box({
  top: 0, left: 0, width: '100%', height: 4, tags: true,
  style: { fg: 'white' },
});

const divTop = blessed.box({
  top: 4, left: 0, width: '100%', height: 1, tags: true,
  style: {},
});

const sidebar = blessed.box({
  top: 5, left: 0, width: SIDEBAR_W, height: '100%-9', tags: true,
  style: { fg: 'white' },
});

const divVert = blessed.box({
  top: 5, left: SIDEBAR_W, width: 1, height: '100%-9', tags: true,
  style: {},
});

const contentBox = blessed.box({
  top: 5, left: SIDEBAR_W + 1, width: '100%-' + (SIDEBAR_W + 1), height: '100%-9', tags: true,
  scrollable: true, alwaysScroll: true, keys: false,
  style: { fg: 'white' },
});

// divBottom BEFORE inputBar so inputBar renders on top
const divBottom = blessed.box({
  bottom: 3, left: 0, width: '100%', height: 1, tags: true,
  style: {},
});

const inputBar = blessed.textbox({
  bottom: 3, left: SIDEBAR_W + 3, width: '100%-' + (SIDEBAR_W + 6), height: 1, tags: false,
  style: { fg: 'yellow', focus: { fg: 'yellow' } },
  inputOnFocus: true, keys: true, vi: false,
});

const statusBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 3, tags: true,
  style: { fg: 'gray' },
});

// divBottom appended before inputBar — inputBar renders on top
[headerBar, divTop, sidebar, divVert, contentBox, divBottom, inputBar, statusBar]
  .forEach(w => screen.append(w));
inputBar.hide();

// ── Helpers ────────────────────────────────────────────────────────────────
function getVal(key) {
  const parts = key.split('.');
  let cur = formData;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

function setVal(key, val) {
  const parts = key.split('.');
  let cur = formData;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

function fmtVal(val, field) {
  if (val === undefined || val === null || val === '') return `{gray-fg}—{/gray-fg}`;
  if (typeof val === 'boolean') return val ? `{green-fg}ON{/green-fg}` : `{gray-fg}OFF{/gray-fg}`;
  if (field?.type === 'secret' && typeof val === 'string' && val.length > 0) return `{gray-fg}${val.slice(0, 4)}••••{/gray-fg}`;
  return `{yellow-fg}${val}{/yellow-fg}`;
}

function renderProgress() {
  const n = sectionIdx + 1;
  const total = SECTIONS.length;
  const bw = Math.max(12, Math.floor(W() * 0.25));
  const filled = Math.round(bw * n / total);
  const bar = '{yellow-fg}' + '█'.repeat(filled) + '{/yellow-fg}' + '{gray-fg}' + '░'.repeat(bw - filled) + '{/gray-fg}';
  return `${bar}  {white-fg}${n}/${total}{/white-fg}`;
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const sec = SECTIONS[sectionIdx];
  const w = W();
  const h = H();
  const cw = CW();

  // Update dynamic separator lines with current width
  divTop.setContent(`{gray-fg}${'─'.repeat(w)}{/gray-fg}`);
  divBottom.setContent(`{gray-fg}${'─'.repeat(w)}{/gray-fg}`);
  // Update vertical divider height
  const midH = Math.max(1, h - 9);
  divVert.setContent(Array(midH).fill('{gray-fg}│{/gray-fg}').join('\n'));

  // Show input prompt in status when in input mode
  const inputPrompt = inputMode ? `  {yellow-fg}❯  {/yellow-fg}` : '';

  headerBar.setContent([
    `  {yellow-fg}╔═╗ ╔═╗ ╔╗╔ ╦ ╦ ╔═╗ ╦ ╦{/yellow-fg}  {white-fg}Setup Wizard{/white-fg}`,
    `  {yellow-fg}╠═╝ ║ ║ ║║║ ╚╦╝ ║ ║ ║ ║{/yellow-fg}`,
    `  {yellow-fg}╩   ╚═╝ ╝╚╝  ╩  ╚═╝ ╚═╝{/yellow-fg}  ${renderProgress()}`,
    `  {white-fg}${sec.label}{/white-fg}  {gray-fg}${sec.description || ''}{/gray-fg}`,
  ].join('\n'));

  // Sidebar
  const sLines = [' ', ' {gray-fg}SECTIONS{/gray-fg}', ' '];
  SECTIONS.forEach((s, i) => {
    if (i === sectionIdx) {
      sLines.push(` {yellow-fg}${s.icon} ${s.label}{/yellow-fg}`);
    } else if (i < sectionIdx) {
      sLines.push(` {green-fg}✓{/green-fg} {white-fg}${s.label}{/white-fg}`);
    } else {
      sLines.push(`   {white-fg}${s.label}{/white-fg}`);
    }
  });
  sidebar.setContent(sLines.join('\n'));

  // Content
  renderSection(sec, cw);

  // Status bar — 3 rows: message / input hint / key hints
  const msgLine = message ? `  {yellow-fg}${message}{/yellow-fg}` : '';
  const inputLine = inputMode
    ? `  {gray-fg}Type value and press{/gray-fg} {white-fg}Enter{/white-fg} {gray-fg}to confirm ·{/gray-fg} {white-fg}Esc{/white-fg} {gray-fg}to cancel{/gray-fg}`
    : '';
  const keyHints = inputMode
    ? ''
    : (sec.type === 'review'
      ? `  {white-fg}Enter{/white-fg} save & exit  {white-fg}Tab{/white-fg} back  {white-fg}q{/white-fg} quit`
      : `  {white-fg}↑ ↓{/white-fg} navigate  {white-fg}Enter{/white-fg} edit  {white-fg}Tab{/white-fg} next section  {white-fg}Esc{/white-fg} back  {white-fg}q{/white-fg} quit`);
  statusBar.setContent([msgLine || '', inputLine || keyHints, ''].join('\n'));

  screen.render();
}

function renderSection(sec, cw) {
  const contentW = cw || CW();
  const lines = [];
  lines.push('');
  lines.push(`  {bold}{white-fg}${sec.label}{/white-fg}{/bold}`);
  if (sec.description) lines.push(`  {gray-fg}${sec.description}{/gray-fg}`);
  lines.push(`  {gray-fg}${'─'.repeat(Math.max(1, contentW - 5))}{/gray-fg}`);
  lines.push('');

  switch (sec.type) {
    case 'profile':  renderProfileContent(lines, sec); break;
    case 'select':   renderSelectContent(lines, sec); break;
    case 'fields':   renderFieldsContent(lines, sec, contentW); break;
    case 'toggles':  renderTogglesContent(lines, sec); break;
    case 'review':   renderReviewContent(lines); break;
  }

  contentBox.setContent(lines.join('\n'));
}

function renderProfileContent(lines, sec) {
  sec.profiles.forEach((p, i) => {
    const active = i === selectCursor;
    if (active) {
      lines.push(`  {yellow-fg}▶  ${p.label}{/yellow-fg}`);
      lines.push(`     {gray-fg}${p.desc}{/gray-fg}`);
    } else {
      lines.push(`     {white-fg}${p.label}{/white-fg}`);
      lines.push(`     {gray-fg}${p.desc}{/gray-fg}`);
    }
    lines.push('');
  });
  lines.push('');
  lines.push(`  {gray-fg}Profiles pre-fill all sections — you can customize each afterward.{/gray-fg}`);
  lines.push(`  {gray-fg}Press Enter to apply and continue.{/gray-fg}`);
}

function renderSelectContent(lines, sec) {
  const current = getVal(sec.key);
  sec.options.forEach((opt, i) => {
    const active = i === selectCursor;
    const selected = current === opt.value;
    let bullet, label;
    if (active && selected) { bullet = '{yellow-fg}●{/yellow-fg}'; label = `{yellow-fg}${opt.label}{/yellow-fg}`; }
    else if (active)        { bullet = '{yellow-fg}▶{/yellow-fg}'; label = `{yellow-fg}${opt.label}{/yellow-fg}`; }
    else if (selected)      { bullet = '{green-fg}●{/green-fg}';   label = `{green-fg}${opt.label}{/green-fg}`; }
    else                    { bullet = '{gray-fg}○{/gray-fg}';     label = `{white-fg}${opt.label}{/white-fg}`; }
    lines.push(`  ${bullet}  ${label}`);
    if (opt.desc)  lines.push(`     {gray-fg}${opt.desc}{/gray-fg}`);
    if (opt.stats) lines.push(`     {gray-fg}${opt.stats}{/gray-fg}`);
    lines.push('');
  });
}

function renderFieldsContent(lines, sec, contentW) {
  const cw = contentW || CW();
  // find the real (non-divider) field at fieldIdx
  const activeField = sec.fields[fieldIdx];

  if (inputMode && activeField?.type !== 'divider') {
    const f = activeField;
    const cur = getVal(f.key);
    lines.push(`  {white-fg}${f.label}{/white-fg}`);
    lines.push(`  {gray-fg}${f.hint || ''}{/gray-fg}`);
    lines.push('');
    lines.push(`  {gray-fg}Current:{/gray-fg}  ${fmtVal(cur !== undefined ? cur : f.default, f)}`);
    lines.push('');
    lines.push(`  {yellow-fg}New value — type below and press Enter:{/yellow-fg}`);
    lines.push(`  {gray-fg}${'─'.repeat(Math.max(1, Math.min(40, cw - 6)))}{/gray-fg}`);
    lines.push('');
    lines.push(`  {gray-fg}(input bar is at the bottom of this panel){/gray-fg}`);
  } else {
    const colW = 26;
    sec.fields.forEach((f, i) => {
      // ── divider row ──
      if (f.type === 'divider') {
        lines.push('');
        lines.push(`  {gray-fg}${f.label.toUpperCase()}  ${'─'.repeat(Math.max(2, cw - f.label.length - 8))}{/gray-fg}`);
        return;
      }

      const active = i === fieldIdx;
      const val = getVal(f.key);
      const display = val !== undefined ? val : f.default;
      const bullet = active ? '{yellow-fg}▶{/yellow-fg}' : ' ';
      const lbl    = active ? `{yellow-fg}${f.label}{/yellow-fg}` : `{white-fg}${f.label}{/white-fg}`;

      if (f.type === 'toggle') {
        const isOn = typeof display === 'boolean' ? display : f.default;
        const tog = isOn ? `{green-fg}[ ON ]{/green-fg}` : `{gray-fg}[OFF]{/gray-fg}`;
        lines.push(`  ${bullet}  ${lbl.padEnd(colW + (active ? 21 : 0))}  ${tog}`);
      } else {
        lines.push(`  ${bullet}  ${lbl.padEnd(colW + (active ? 21 : 0))}  ${fmtVal(display, f)}`);
      }
      if (active && f.hint) {
        lines.push(`       {gray-fg}${f.hint}{/gray-fg}`);
      }
    });
    lines.push('');
    if (activeField?.type === 'toggle') {
      lines.push(`  {gray-fg}Press Enter or Space to toggle{/gray-fg}`);
    } else if (activeField?.type !== 'divider') {
      lines.push(`  {gray-fg}Press Enter to edit · leave blank to keep current value{/gray-fg}`);
    }
  }
}

function renderTogglesContent(lines, sec) {
  const colW = 24;
  sec.fields.forEach((f, i) => {
    const active = i === fieldIdx;
    const val = getVal(f.key);
    const isOn = val !== undefined ? val : f.default;
    const tog = isOn ? `{green-fg}[ ON ]{/green-fg}` : `{gray-fg}[OFF]{/gray-fg}`;
    const bullet = active ? '{yellow-fg}▶{/yellow-fg}' : ' ';
    const lbl = active ? `{yellow-fg}${f.label}{/yellow-fg}` : `{white-fg}${f.label}{/white-fg}`;
    lines.push(`  ${bullet}  ${lbl.padEnd(colW + (active ? 21 : 0))}  ${tog}`);
    if (active && f.hint) lines.push(`       {gray-fg}${f.hint}{/gray-fg}`);
  });
  lines.push('');
  lines.push(`  {gray-fg}Press Enter or Space to toggle on/off{/gray-fg}`);
}

function renderReviewContent(lines) {
  function flattenObj(obj, prefix) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(out, flattenObj(v, key));
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  const flat = flattenObj(formData);
  const keys = Object.keys(flat);

  if (keys.length === 0) {
    lines.push('  {gray-fg}No settings configured yet. Go back to fill in the sections.{/gray-fg}');
  } else {
    lines.push(`  {gray-fg}${keys.length} settings ready to save:{/gray-fg}`);
    lines.push('');
    keys.forEach(k => {
      let v = flat[k];
      const isSecret = k.toLowerCase().includes('key') || k.toLowerCase().includes('token');
      if (isSecret && typeof v === 'string' && v.length > 4) v = v.slice(0, 4) + '••••';
      else if (typeof v === 'string' && v.length > 40) v = v.slice(0, 38) + '…';
      const display = typeof v === 'boolean'
        ? (v ? '{green-fg}ON{/green-fg}' : '{gray-fg}OFF{/gray-fg}')
        : `{yellow-fg}${v ?? '—'}{/yellow-fg}`;
      lines.push(`  {gray-fg}${k.padEnd(34)}{/gray-fg}  ${display}`);
    });
  }

  lines.push('');
  lines.push('');
  lines.push(`  {yellow-fg}Press Enter to save  →  user-config.json{/yellow-fg}`);
}

// ── Navigation ─────────────────────────────────────────────────────────────
function sec() { return SECTIONS[sectionIdx]; }

function skipDividers(fields, idx, dir) {
  let i = idx;
  while (i >= 0 && i < fields.length && fields[i]?.type === 'divider') i += dir;
  if (i < 0 || i >= fields.length) return idx; // no valid field, stay
  return i;
}

function navUp() {
  if (inputMode) return;
  const s = sec();
  if (s.type === 'select' || s.type === 'profile') {
    const len = (s.options || s.profiles).length;
    selectCursor = (selectCursor - 1 + len) % len;
  } else if (s.type === 'fields' || s.type === 'toggles') {
    const next = skipDividers(s.fields, fieldIdx - 1, -1);
    fieldIdx = Math.max(0, next);
  }
  message = '';
  render();
}

function navDown() {
  if (inputMode) return;
  const s = sec();
  if (s.type === 'select' || s.type === 'profile') {
    const len = (s.options || s.profiles).length;
    selectCursor = (selectCursor + 1) % len;
  } else if (s.type === 'fields' || s.type === 'toggles') {
    const next = skipDividers(s.fields, fieldIdx + 1, 1);
    fieldIdx = Math.min(s.fields.length - 1, next);
  }
  message = '';
  render();
}

function syncFieldIdx(s) {
  if (s.type === 'fields' && s.fields) {
    fieldIdx = skipDividers(s.fields, 0, 1);
  } else {
    fieldIdx = 0;
  }
  if (s.type === 'select' && s.key) {
    const cur = getVal(s.key);
    const idx = s.options.findIndex(o => o.value === cur);
    if (idx >= 0) selectCursor = idx;
  }
}

function navNext() {
  message = '';
  selectCursor = 0;
  if (sectionIdx < SECTIONS.length - 1) {
    sectionIdx++;
    syncFieldIdx(sec());
  }
  render();
}

function navBack() {
  message = '';
  selectCursor = 0;
  if (sectionIdx > 0) {
    sectionIdx--;
    syncFieldIdx(sec());
  }
  render();
}

function handleActivate() {
  if (inputMode) return;
  const s = sec();

  if (s.type === 'review') { saveConfig().catch(() => {}); return; }

  if (s.type === 'profile') {
    const p = s.profiles[selectCursor];
    if (p.apply) { Object.assign(formData, p.apply); message = `Profile "${p.label}" applied`; }
    navNext(); return;
  }

  if (s.type === 'select') {
    const opt = s.options[selectCursor];
    setVal(s.key, opt.value);
    message = `${s.key} = ${opt.value}`;
    render(); return;
  }

  if (s.type === 'toggles') {
    const f = s.fields[fieldIdx];
    const cur = getVal(f.key);
    const newVal = !(cur !== undefined ? cur : f.default);
    setVal(f.key, newVal);
    message = `${f.label} → ${newVal ? 'ON' : 'OFF'}`;
    render(); return;
  }

  if (s.type === 'fields') {
    const f = s.fields[fieldIdx];
    if (f.type === 'toggle') {
      const cur = getVal(f.key);
      const newVal = !(cur !== undefined ? cur : f.default);
      setVal(f.key, newVal);
      message = `${f.label} → ${newVal ? 'ON' : 'OFF'}`;
      render(); return;
    }
    // Enter edit mode
    inputMode = true;
    const cur = getVal(f.key);
    const prefill = cur !== undefined && cur !== null ? String(cur) : '';
    inputBar.show();
    inputBar.setValue(prefill);
    inputBar.focus();
    render(); return;
  }
}

async function saveConfig() {
  // WS-1: atomic + locked write so a wizard crash mid-save doesn't leave a
  // corrupt user-config.json half-file, and a concurrent write from the
  // dashboard or executor's update_config doesn't race us. Falls back to
  // raw writeFileSync only if the atomic-write helper failed to load
  // (preserves wizard usability in degraded environments).
  try {
    if (_atomicWriteJson && _withFileLock) {
      await _withFileLock(CONFIG_PATH, async () => {
        _atomicWriteJson(CONFIG_PATH, formData);
      });
    } else {
      writeFileSync(CONFIG_PATH, JSON.stringify(formData, null, 2));
    }
    message = '{green-fg}✓ Saved to user-config.json{/green-fg}';
    render();
    setTimeout(() => { screen.destroy(); process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); process.exit(0); }, 1200);
  } catch (e) {
    message = `{red-fg}✗ Save failed: ${e.message}{/red-fg}`;
    render();
  }
}

// ── Input box ──────────────────────────────────────────────────────────────
inputBar.on('submit', (val) => {
  const s = sec();
  const f = s.fields?.[fieldIdx];
  if (!f) { inputMode = false; inputBar.hide(); contentBox.focus(); render(); return; }

  const v = (val || '').trim();
  if (v !== '') {
    let parsed;
    if (v === 'true')  parsed = true;
    else if (v === 'false') parsed = false;
    else if (v === 'null' || v === '-') parsed = null;
    else if (f.type === 'number') {
      const n = parseFloat(v);
      parsed = isNaN(n) ? null : n;
      if (isNaN(n)) { message = `Must be a number`; inputMode = false; inputBar.hide(); contentBox.focus(); render(); return; }
    } else {
      parsed = v;
    }
    if (parsed !== null) {
      setVal(f.key, parsed);
      message = `${f.label} saved`;
    }
  }

  inputMode = false;
  inputBar.hide();
  contentBox.focus();
  render();
});

// ── Keys ───────────────────────────────────────────────────────────────────
screen.key(['up', 'k'],   navUp);
screen.key(['down', 'j'], navDown);

screen.key(['tab'],   () => { if (!inputMode) navNext(); });
screen.key(['S-tab'], () => { if (!inputMode) navBack(); });

screen.key(['enter'], () => {
  if (inputMode) {
    // screen.key intercepts Enter before the textbox — manually trigger submit
    const val = inputBar.getValue();
    inputBar.emit('submit', val);
    return;
  }
  handleActivate();
});
screen.key(['space'], () => {
  if (!inputMode) {
    const s = sec();
    if (s.type === 'toggles' || (s.type === 'fields' && s.fields[fieldIdx]?.type === 'toggle')) {
      handleActivate();
    } else if (s.type === 'select') {
      handleActivate();
    }
  }
});

screen.key(['escape'], () => {
  if (inputMode) {
    inputMode = false;
    inputBar.hide();
    contentBox.focus();
    message = '';
    render();
  } else if (sectionIdx > 0) {
    navBack();
  } else {
    screen.destroy();
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    process.exit(0);
  }
});

screen.key(['q', 'C-c'], () => {
  if (!inputMode) {
    screen.destroy();
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    process.exit(0);
  }
});

// ── Resize handler ─────────────────────────────────────────────────────────
screen.on('resize', () => {
  // Update inputBar width dynamically on resize
  inputBar.width = '100%-' + (SIDEBAR_W + 6);
  render();
});

// ── Boot ───────────────────────────────────────────────────────────────────
contentBox.focus();
render();
