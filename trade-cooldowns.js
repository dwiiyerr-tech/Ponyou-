import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "trade-cooldowns.json");

function loadData() {
  if (!fs.existsSync(FILE)) return { tokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { tokens: {} };
  } catch {
    return { tokens: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function setTokenCooldown(mint, hours, reason = "cooldown") {
  if (!mint || !(hours > 0)) return null;
  const data = loadData();
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  data.tokens[mint] = {
    until,
    reason,
    set_at: new Date().toISOString(),
  };
  saveData(data);
  return data.tokens[mint];
}

export function getTokenCooldown(mint) {
  if (!mint) return null;
  const data = loadData();
  const entry = data.tokens[mint];
  if (!entry) return null;
  if (new Date(entry.until).getTime() <= Date.now()) {
    delete data.tokens[mint];
    saveData(data);
    return null;
  }
  return entry;
}

export function isTokenOnCooldown(mint) {
  return !!getTokenCooldown(mint);
}
