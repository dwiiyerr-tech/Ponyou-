// Bridge to Ponyou command system via REST API (primary) or file IPC (fallback)

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const DASHBOARD_URL = process.env.PONYOU_DASHBOARD_URL || 'http://127.0.0.1:3000';

async function apiPost(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${DASHBOARD_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    return { ok: res.ok, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const base = parts[0].toLowerCase();

  // Try REST API first
  const apiResult = await apiPost('/api/cmd', { cmd: base, args: parts.slice(1) });
  if (apiResult.ok) return { ok: true, message: apiResult.message || JSON.stringify(apiResult) };

  // Fallback: write to file
  try {
    const cmdFile = resolve(ROOT, 'dashboard-cmd.json');
    const id = 'term_' + Date.now();
    const payload = { id, cmd: base, args: parts.slice(1).join(' '), timestamp: new Date().toISOString() };
    await fs.writeFile(cmdFile, JSON.stringify(payload, null, 2));
    return { ok: true, message: `Command "${cmd}" sent (file fallback)` };
  } catch (e) {
    return { error: e.message };
  }
}

// Feature toggles via REST API
export async function toggleFeature(key, enabled) {
  return apiPost('/api/toggle', { key, enabled });
}
