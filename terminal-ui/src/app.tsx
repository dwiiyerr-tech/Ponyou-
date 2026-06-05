import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Header } from "./components/Header.js";
import { TabBar, TABS } from "./components/TabBar.js";
import { StatusBar } from "./components/StatusBar.js";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Monitor } from "./screens/Monitor.js";
import { Watchlist } from "./screens/Watchlist.js";
import { Logs } from "./screens/Logs.js";
import { Pnl } from "./screens/Pnl.js";
import { Wizard } from "./screens/Wizard.js";
import { Doctor } from "./screens/Doctor.js";
import { usePonyouState } from "./hooks/usePonyouState.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { sendCommand } from "./data/sendCommand.js";
import { color } from "./theme.js";
import type { ScreenId } from "./types.js";

type Toast = { kind: "success" | "error" | "info"; message: string };

export function App() {
  const { exit } = useApp();
  const size = useTerminalSize();
  const { state } = usePonyouState(1500);

  // Initial screen can be set via env (handy for deep-links / screenshots).
  const initialScreen = TABS.find((t) => t.id === process.env.PONYOU_TUI_SCREEN)?.id ?? "dashboard";
  const [screen, setScreen] = useState<ScreenId>(initialScreen);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((t: Toast, ms = 2400) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const goto = useCallback((s: ScreenId) => { setScreen(s); setPaletteOpen(false); }, []);

  const runBotCommand = useCallback(async (cmd: string, label: string) => {
    setPaletteOpen(false);
    showToast({ kind: "info", message: `sending ${label}…` }, 1500);
    const res = await sendCommand(cmd);
    showToast({ kind: res.ok ? "success" : "error", message: res.message });
  }, [showToast]);

  const commands: PaletteCommand[] = [
    { cmd: "/scan", desc: "trigger a screening scan", run: () => runBotCommand("scan", "/scan") },
    { cmd: "/monitor", desc: "open the live monitor", run: () => goto("monitor") },
    { cmd: "/watch", desc: "open the watchlist", run: () => goto("watchlist") },
    { cmd: "/pnl", desc: "open the P&L panel", run: () => goto("pnl") },
    { cmd: "/logs", desc: "open live logs", run: () => goto("logs") },
    { cmd: "/strategy", desc: "view active strategy", run: () => goto("dashboard") },
    { cmd: "/doctor", desc: "run health checks", run: () => goto("doctor") },
    { cmd: "/setup", desc: "open the setup wizard", run: () => goto("wizard") },
    { cmd: "/quit", desc: "exit the app", run: () => exit() },
  ];

  // Global keys are suspended while the palette is open (it owns input) or
  // while the wizard text input is focused (number keys must type, not switch
  // screens). The wizard provides its own Esc-to-exit hatch.
  const globalKeysActive = !paletteOpen && screen !== "wizard";
  useInput((input, key) => {
    if (input === "/" || (input === "p" && key.ctrl)) { setPaletteOpen(true); return; }
    if (input === "q") { exit(); return; }
    // Number keys switch screens (instant — keyboard action, no animation).
    const tab = TABS.find((t) => t.key === input);
    if (tab) { setScreen(tab.id); return; }
  }, { isActive: globalKeysActive });

  const screenActive = !paletteOpen;

  const hints =
    screen === "wizard"
      ? [{ key: "enter", label: "next" }, { key: "↑↓", label: "step" }, { key: "esc", label: "back" }]
      : screen === "doctor"
        ? [{ key: "r", label: "re-run" }, { key: "c", label: "copy" }, { key: "/", label: "palette" }, { key: "q", label: "quit" }]
        : screen === "monitor"
          ? [{ key: "↑↓", label: "position" }, { key: "p", label: "pause" }, { key: "/", label: "palette" }, { key: "q", label: "quit" }]
          : [{ key: "1-7", label: "screens" }, { key: "↑↓", label: "navigate" }, { key: "/", label: "palette" }, { key: "q", label: "quit" }];

  return (
    <Box flexDirection="column" paddingY={0}>
      <Header agentName={state?.agentName || "ponyou"} mode={state?.mode || "demo"} connected={!!state?.connected} compact={size.compact} />
      <Box marginTop={1}><TabBar active={screen} compact={size.compact} /></Box>

      <Box flexDirection="column" marginTop={1} paddingX={1} minHeight={size.height - 7}>
        {screen === "dashboard" && <Dashboard state={state} size={size} />}
        {screen === "monitor" && <Monitor state={state} size={size} active={screenActive} />}
        {screen === "watchlist" && <Watchlist state={state} size={size} active={screenActive} />}
        {screen === "logs" && <Logs size={size} active={screenActive} />}
        {screen === "pnl" && <Pnl state={state} size={size} active={screenActive} />}
        {screen === "wizard" && (
          <Wizard
            active={screenActive}
            onExit={() => goto("dashboard")}
            onDone={(saved) => showToast({ kind: "success", message: saved.length ? `saved ${saved.length} setting(s)` : "no changes" })}
          />
        )}
        {screen === "doctor" && <Doctor active={screenActive} size={size} />}
      </Box>

      {paletteOpen ? (
        <Box paddingX={1}><CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /></Box>
      ) : (
        <StatusBar hints={hints} toast={toast} />
      )}
    </Box>
  );
}
