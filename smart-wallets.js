import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_FILE = path.join(__dirname, "smart-wallets.json");

function load() {
  if (!fs.existsSync(WALLETS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")); } catch { return {}; }
}

function save(wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

export function addSmartWallet({ address, label = "" } = {}) {
  if (!address) return { error: "address required" };
  const wallets = load();
  wallets[address] = { address, label, added_at: new Date().toISOString() };
  save(wallets);
  return { saved: true, address, label };
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

export function listSmartWallets() {
  return Object.values(load());
}
