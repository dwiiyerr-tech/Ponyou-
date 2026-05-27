#!/usr/bin/env node
// PONYOU — Claude Code-style Terminal Agent
//
//   ponyou          → Claude Code-like chat interface
//   ponyou wizard   → Setup wizard (10-step config)
//   ponyou monitor  → Live dashboard (same as /monitor in chat)

import { render } from 'ink';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import React from 'react';
import App from './claude-app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const directMode = args[0]?.toLowerCase();

function spawnScript(relPath) {
  return spawn('node', [resolve(__dirname, relPath)], { stdio: 'inherit', env: process.env });
}

// ── Direct modes ──
if (directMode === 'wizard' || directMode === '--wizard' || directMode === 'setup') {
  const child = spawnScript('modes/wizard-standalone.js');
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.kill(); process.exit(0); });
} else if (directMode === 'monitor' || directMode === '--monitor' || directMode === 'logs' || directMode === 'dashboard') {
  const child = spawnScript('modes/monitor-standalone.js');
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.kill(); process.exit(0); });
} else {
  await runChatLoop();
}

// ── Chat loop (Ink ↔ blessed lifecycle) ──
async function runChatLoop() {
  let action = null;

  while (action !== 'quit') {
    action = await runInkApp(
      action === 'monitor' ? 'monitor-returned' :
      action === 'wizard'  ? 'wizard-returned'  : null
    );

    if (action === 'monitor') {
      await runBlessed('modes/monitor-standalone.js');
    } else if (action === 'wizard') {
      await runBlessed('modes/wizard-standalone.js');
    }
  }

  process.exit(0);
}

async function runInkApp(initialMessage) {
  return new Promise((done) => {
    const app = React.createElement(App, {
      initialMessage,
      onAction: (action) => { unmount(); done(action); },
    });
    const { unmount, waitUntilExit } = render(app);
    waitUntilExit().then(() => done('quit'));
  });
}

async function runBlessed(relPath) {
  return new Promise((done) => {
    const child = spawn('node', [resolve(__dirname, relPath)], {
      stdio: 'inherit', env: process.env,
    });
    child.on('exit', () => setTimeout(() => done(), 200));
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
