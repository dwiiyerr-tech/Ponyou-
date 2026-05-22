#!/usr/bin/env node
import { createDashboardServer } from "./dashboard/server.js";

const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 3000;

const { start } = createDashboardServer({ port });
await start();
console.log(`\n🟢 Ponyou Dashboard running at http://localhost:${port}\n`);
console.log("  Ctrl+C to stop\n");
