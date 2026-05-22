import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

export function writeAutomationCommand(cmd) {
  const fp = path.join(BASE_PATH, "automation-command.json");
  atomicWriteJson(fp, { cmd, ts: new Date().toISOString() });
}

export function writeDashboardCmd({ id, cmd, args = [] }) {
  const fp = path.join(BASE_PATH, "dashboard-cmd.json");
  atomicWriteJson(fp, { id, cmd, args, ts: new Date().toISOString() });
}

export function readDashboardResponse(id) {
  const fp = path.join(BASE_PATH, "dashboard-response.json");
  try {
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return data.id === id ? data : null;
  } catch { return null; }
}
