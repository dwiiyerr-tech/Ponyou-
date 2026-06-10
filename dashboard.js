#!/usr/bin/env node
import "dotenv/config";
import "./config.js";
import { createDashboardServer } from "./dashboard/server.js";

const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 3000;

const dashboard = createDashboardServer({ port });

try {
  await dashboard.start();
  console.log(`\n🟢 Ponyou Dashboard running at http://localhost:${port}\n`);
  console.log("  Ctrl+C to stop\n");
} catch (e) {
  console.error(`[dashboard] Failed to start on port ${port}: ${e.message}`);
  process.exit(1);
}

let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[dashboard] ${signal} received — shutting down…`);
  try { await dashboard.shutdown(); } catch (e) { console.error(`[dashboard] shutdown error: ${e.message}`); }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  console.error(`[dashboard] uncaughtException: ${e.message}`);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (e) => {
  console.error(`[dashboard] unhandledRejection: ${e?.message || e}`);
});
