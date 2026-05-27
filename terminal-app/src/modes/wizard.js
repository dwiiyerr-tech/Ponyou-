// Setup Wizard Mode — interactive configuration for Ponyou
// Activated via /wizard command from Agent REPL

import blessed from 'blessed';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const STEPS = [
  {
    title: '1/10 — Wallet & RPC',
    fields: [
      { key: 'walletAddress', label: 'Wallet Address (Solana public key)', type: 'text', hint: 'Your Solana wallet public key' },
      { key: 'rpcUrl', label: 'Primary RPC URL', type: 'text', hint: 'e.g. https://mainnet.helius-rpc.com/?api-key=...' },
    ],
  },
  {
    title: '2/10 — Execution Mode',
    fields: [
      { key: 'executionMode', label: 'Mode', type: 'select', options: ['demo','paper','live'], hint: 'demo=dry run, paper=simulated, live=real' },
      { key: 'dryRun', label: 'Dry Run (true/false)', type: 'text', hint: 'true = no real transactions' },
      { key: 'pipelineTestMode', label: 'Pipeline Test Mode', type: 'text', hint: 'true for testing pipeline without trading' },
    ],
  },
  {
    title: '3/10 — Strategy',
    fields: [
      { key: 'strategy', label: 'Strategy', type: 'select', options: ['scalping','conservative','aggressive','sniper','recovery','day_phase_swing'], hint: 'Trading strategy preset' },
      { key: 'positionSizePct', label: 'Position Size %', type: 'number', hint: 'Percentage of balance per trade (e.g. 0.35 = 35%)' },
      { key: 'maxPositions', label: 'Max Positions', type: 'number', hint: 'Max concurrent open positions' },
      { key: 'minSolPerTrade', label: 'Min SOL Per Trade', type: 'number', hint: 'Minimum SOL to deploy per trade' },
    ],
  },
  {
    title: '4/10 — LLM / AI',
    fields: [
      { key: 'llmModel', label: 'LLM Model', type: 'text', hint: 'e.g. minimax/minimax-m2.7' },
      { key: 'llmBaseUrl', label: 'LLM Base URL (optional)', type: 'text', hint: 'Leave blank for default' },
      { key: 'llmApiKey', label: 'LLM API Key (optional)', type: 'text', hint: 'API key for LLM provider' },
    ],
  },
  {
    title: '5/10 — Screening Filters',
    fields: [
      { key: 'minMcap', label: 'Min Market Cap ($)', type: 'number', hint: 'Minimum market cap filter' },
      { key: 'maxMcap', label: 'Max Market Cap ($)', type: 'number', hint: 'Maximum market cap filter' },
      { key: 'minTvl', label: 'Min TVL ($)', type: 'number', hint: 'Minimum total value locked' },
      { key: 'minVolume', label: 'Min Volume ($)', type: 'number', hint: 'Minimum 24h volume' },
      { key: 'minHolders', label: 'Min Holders', type: 'number', hint: 'Minimum holder count' },
      { key: 'minOrganic', label: 'Min Organic %', type: 'number', hint: 'Minimum organic transaction percentage' },
    ],
  },
  {
    title: '6/10 — Position Management',
    fields: [
      { key: 'stopLossPct', label: 'Stop Loss %', type: 'number', hint: 'Auto sell at this loss percentage' },
      { key: 'takeProfitPct', label: 'Take Profit %', type: 'number', hint: 'Auto sell at this profit percentage' },
      { key: 'gasReserve', label: 'Gas Reserve (SOL)', type: 'number', hint: 'SOL kept for transaction fees' },
      { key: 'deployAmountSol', label: 'Deploy Amount (SOL)', type: 'number', hint: 'SOL amount for new position deployment' },
    ],
  },
  {
    title: '7/10 — Daily Guard',
    fields: [
      { key: 'dailyGuardEnabled', label: 'Enable Daily Guard (true/false)', type: 'text' },
      { key: 'dailyMaxSwaps', label: 'Max Swaps Per Day', type: 'number' },
      { key: 'dailyMaxLoss', label: 'Max Loss Per Day (SOL)', type: 'number' },
    ],
  },
  {
    title: '8/10 — Vault / Savings',
    fields: [
      { key: 'vaultSweepEnabled', label: 'Enable Vault Sweep (true/false)', type: 'text' },
      { key: 'vaultSweepThreshold', label: 'Sweep Threshold (SOL)', type: 'number' },
      { key: 'vaultRetainSol', label: 'Retain SOL After Sweep', type: 'number' },
    ],
  },
  {
    title: '9/10 — Features',
    fields: [
      { key: 'confirmMode', label: 'Confirm Mode (true/false)', type: 'text' },
      { key: 'trashFilterEnabled', label: 'Trash Filter (true/false)', type: 'text' },
      { key: 'stagedEntryEnabled', label: 'Staged Entry (true/false)', type: 'text' },
      { key: 'strategyEvolutionEnabled', label: 'Strategy Evolution (true/false)', type: 'text' },
      { key: 'useDiscordSignals', label: 'Discord Signals (true/false)', type: 'text' },
    ],
  },
  {
    title: '10/10 — Review & Save',
    isReview: true,
  },
];

export function createWizardScreen(screen, { onBack }) {
  const rows = screen.rows;
  const cols = screen.cols;

  let stepIdx = 0;
  let fieldIdx = 0;
  let formData = {};
  let inputValue = '';
  let message = '';

  // Load existing config
  try {
    const configPath = resolve(ROOT, 'user-config.json');
    if (existsSync(configPath)) {
      formData = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  // ── Widgets ──
  const header  = blessed.box({ top:0, left:0, width:cols, height:1, tags:true, style:{fg:'white',bg:'black'} });
  const hrLine1 = blessed.box({ top:1, left:0, width:cols, height:1, tags:true,
    content:`{white-fg}${'─'.repeat(cols)}{/white-fg}`, style:{bg:'black'} });
  const progress = blessed.box({ top:2, left:0, width:cols, height:1, tags:true, style:{fg:'white',bg:'black'} });
  const hrLine2 = blessed.box({ top:3, left:0, width:cols, height:1, tags:true,
    content:`{white-fg}${'─'.repeat(cols)}{/white-fg}`, style:{bg:'black'} });
  const main = blessed.box({ top:4, left:0, width:cols, height:rows-7, tags:true, style:{fg:'white',bg:'black'} });
  const hrLine3 = blessed.box({ bottom:2, left:0, width:cols, height:1, tags:true,
    content:`{white-fg}${'─'.repeat(cols)}{/white-fg}`, style:{bg:'black'} });
  const input = blessed.textbox({ bottom:1, left:2, width:cols-4, height:1, tags:false,
    style:{fg:'yellow',bg:'black',focus:{fg:'yellow'}}, inputOnFocus:true, keys:true, vi:false });
  const msgLine = blessed.box({ bottom:0, left:0, width:cols, height:1, tags:true, style:{fg:'white',bg:'black'} });

  [header, hrLine1, progress, hrLine2, main, hrLine3, input, msgLine].forEach(w => screen.append(w));

  function render() {
    const step = STEPS[stepIdx];
    if (!step) return;

    header.setContent(` {yellow-fg}● PONYOU{/yellow-fg}  {white-fg}·  Setup Wizard  ·  Step ${stepIdx+1}/${STEPS.length}{/white-fg}`);
    const pct = Math.round(((stepIdx+1)/STEPS.length)*100);
    const barW = Math.floor(cols*0.6);
    const filled = Math.floor(barW * (stepIdx+1)/STEPS.length);
    progress.setContent(` {yellow-fg}${'█'.repeat(filled)}{/yellow-fg}{gray-fg}${'░'.repeat(barW-filled)}{/gray-fg} {white-fg}${pct}%{/white-fg}`);

    if (step.isReview) {
      const cfgKeys = Object.keys(formData).filter(k => formData[k] !== undefined && formData[k] !== '');
      const lines = ['{yellow-fg}Configuration Review:{/yellow-fg}', ''];
      cfgKeys.forEach(k => {
        let v = formData[k];
        if (typeof v === 'string' && v.length > 40) v = v.slice(0,37)+'...';
        lines.push(`  {cyan-fg}${k}:{/cyan-fg} {white-fg}${v}{/white-fg}`);
      });
      lines.push('');
      lines.push('{green-fg}Press Enter to save, Esc to go back{/green-fg}');
      main.setContent(lines.join('\n'));
      input.hide();
    } else {
      const field = step.fields[fieldIdx];
      const lines = [
        `{cyan-fg}${step.title}{/cyan-fg}`,
        '',
        `{white-fg}${field.label}{/white-fg}`,
        field.hint ? `{gray-fg}${field.hint}{/gray-fg}` : '',
        field.options ? `{gray-fg}Options: ${field.options.join(' | ')}{/gray-fg}` : '',
        '',
        `{yellow-fg}Current: {white-fg}${formData[field.key] ?? '(not set)'}{/white-fg}`,
        fieldIdx > 0 ? '{gray-fg}  (Enter to skip, Backspace to go to previous field){/gray-fg}' : '',
      ];
      main.setContent(lines.join('\n'));
      input.show();
      input.setValue('');
      input.focus();
    }

    msgLine.setContent(message ? `{yellow-fg}${message}{/yellow-fg}` : '{white-fg}↑↓{/white-fg} navigate  {white-fg}Enter{/white-fg} confirm  {white-fg}Esc{/white-fg} back  {white-fg}Tab{/white-fg} next');
    screen.render();
  }

  // ── Input handler ──
  input.on('submit', (val) => {
    const step = STEPS[stepIdx];
    if (!step) return;

    if (step.isReview) {
      // Save config
      try {
        const configPath = resolve(ROOT, 'user-config.json');
        writeFileSync(configPath, JSON.stringify(formData, null, 2));
        message = '{green-fg}Configuration saved successfully!{/green-fg}';
      } catch (e) {
        message = `{red-fg}Error saving: ${e.message}{/red-fg}`;
      }
      render();
      setTimeout(() => onBack(), 1500);
      return;
    }

    const field = step.fields[fieldIdx];
    const v = val?.trim();

    if (v === '' && fieldIdx > 0) {
      // Skip this field
    } else if (v !== '') {
      // Parse value
      if (field.type === 'number') {
        const n = parseFloat(v);
        if (!isNaN(n)) formData[field.key] = n;
      } else if (v === 'true') {
        formData[field.key] = true;
      } else if (v === 'false') {
        formData[field.key] = false;
      } else {
        formData[field.key] = v;
      }
      message = `{green-fg}Set ${field.key} = ${formData[field.key]}{/green-fg}`;
    }

    // Advance
    if (fieldIdx < step.fields.length - 1) {
      fieldIdx++;
    } else {
      // Next step
      fieldIdx = 0;
      stepIdx++;
      if (stepIdx >= STEPS.length) {
        message = '{green-fg}Wizard complete — saving...{/green-fg}';
        render();
        try {
          const configPath = resolve(ROOT, 'user-config.json');
          writeFileSync(configPath, JSON.stringify(formData, null, 2));
        } catch (e) {
          message = `{red-fg}Save error: ${e.message}{/red-fg}`;
        }
        setTimeout(() => onBack(), 1500);
        return;
      }
    }
    render();
  });

  // ── Keyboard ──
  screen.key(['escape'], () => {
    if (stepIdx > 0 || fieldIdx > 0) {
      if (fieldIdx > 0) {
        fieldIdx--;
      } else {
        stepIdx--;
        const prev = STEPS[stepIdx];
        fieldIdx = prev.isReview ? 0 : prev.fields.length - 1;
      }
      message = '';
      render();
    } else {
      [header,hrLine1,progress,hrLine2,main,hrLine3,input,msgLine].forEach(w => screen.remove(w));
      onBack();
    }
  });

  screen.key(['tab'], () => {
    const step = STEPS[stepIdx];
    if (!step || step.isReview) return;
    if (fieldIdx < step.fields.length - 1) {
      fieldIdx++;
    } else {
      fieldIdx = 0;
      if (stepIdx < STEPS.length - 1) stepIdx++;
      else stepIdx = 0;
    }
    message = '';
    render();
  });

  screen.key(['C-c'], () => {
    [header,hrLine1,progress,hrLine2,main,hrLine3,input,msgLine].forEach(w => screen.remove(w));
    onBack();
  });

  render();
  return {};
}
