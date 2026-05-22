import { writeDashboardCmd, readDashboardResponse } from "./command-writer.js";

export async function sendBotCommand({ cmd, args = [], timeoutMs = 5000 }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  writeDashboardCmd({ id, cmd, args });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const resp = readDashboardResponse(id);
    if (resp) return { ok: true, response: resp.response ?? "" };
  }
  return { ok: false, response: "timeout — bot did not respond in 5s" };
}
