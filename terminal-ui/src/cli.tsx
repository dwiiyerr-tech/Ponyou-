#!/usr/bin/env node
/**
 * cli.tsx — entry point for the Ponyou terminal UI.
 *
 *   ponyou-tui            launch the full dashboard
 *   ponyou-tui doctor     jump straight to health checks
 *   ponyou-tui --help     usage
 *
 * Runs anywhere Node 18+ runs: VPS, and Termux on Android.
 */
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "ponyou-tui — terminal UI for the Ponyou memecoin agent",
      "",
      "Usage:",
      "  ponyou-tui            launch the dashboard",
      "  ponyou-tui --help     show this help",
      "",
      "Keys:  1-6 screens · / command palette · q quit",
      "Env:   PONYOU_ROOT (project dir) · PONYOU_DASHBOARD_PORT (default 3000)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// Ink owns the alternate screen + raw mode; exitOnCtrlC keeps Ctrl-C working.
const { waitUntilExit } = render(<App />, { exitOnCtrlC: true });
waitUntilExit().then(() => {
  // Clear scrollback so the terminal returns clean (Emil: leave no mess behind).
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
});
