import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applyScoreDecay } from "./wallet-score-decay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_FILE = path.join(__dirname, "smart-wallets.json");

function load() {
  if (!fs.existsSync(WALLETS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")); } catch { return {}; }
}

function save(wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

function normalizeWalletRecord(record = {}, address) {
  const selection = record.selection && typeof record.selection === "object"
    ? record.selection
    : null;
  return {
    address,
    label: record.label || "",
    added_at: record.added_at || new Date().toISOString(),
    last_active: record.last_active || record.stats?.last_active || record.stats?.last_trade_at || null,
    source_tokens: Array.isArray(record.source_tokens) ? record.source_tokens : [],
    stats: record.stats && typeof record.stats === "object" ? record.stats : null,
    selection,
    follow_mode: record.follow_mode || selection?.follow_mode || "shadow",
    notes: record.notes || "",
  };
}

export function addSmartWallet({ address, label = "", source_tokens = [], stats = null, selection = null, notes = "" } = {}) {
  if (!address) return { error: "address required" };
  const wallets = load();
  wallets[address] = normalizeWalletRecord({
    ...(wallets[address] || {}),
    address,
    label: label || wallets[address]?.label || "",
    source_tokens: source_tokens.length ? source_tokens : wallets[address]?.source_tokens,
    stats: stats || wallets[address]?.stats || null,
    selection: selection || wallets[address]?.selection || null,
    follow_mode: selection?.follow_mode || wallets[address]?.follow_mode || "shadow",
    notes: notes || wallets[address]?.notes || "",
  }, address);
  save(wallets);
  return { saved: true, address, label: wallets[address].label, selection: wallets[address].selection };
}

export function removeSmartWallet({ address } = {}) {
  const wallets = load();
  const existed = address in wallets;
  if (existed) {
    delete wallets[address];
    save(wallets);
  }
  return { removed: existed, address };
}

export function listSmartWallets({ minDecayMultiplier = 0 } = {}) {
  return Object.entries(load())
    .map(([address, record]) => normalizeWalletRecord(record, address))
    .map(wallet => applyScoreDecay(wallet))
    .filter(w => (w.score_decay_multiplier ?? 1) >= minDecayMultiplier)
    .sort((a, b) => (b.selection?.score || 0) - (a.selection?.score || 0));
}
