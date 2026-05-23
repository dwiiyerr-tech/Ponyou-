"""
Ponyou TUI entry point.

Run with::

    cd tools/tui && python -m tools.tui.app

or via the helper script ``python run.py``. The Textual app composes the
four panels described in the project spec, owns the polling + log-tailing
workers, and dispatches snapshots/log events into the widgets.

Design notes:
 - All file I/O lives in ``data/`` modules so panels stay declarative.
 - Workers are Textual ``@work`` coroutines so they shut down with the app.
 - We never block the UI: snapshots take ~ms to read but go through the
   default thread executor anyway via ``run_in_executor``.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import Static

from .data.log_tailer import tail_actions
from .data.state_reader import read_snapshot
from .panels.agent_log import AgentLog
from .panels.header import PonyouHeader
from .panels.left_panel import LeftPanel
from .panels.right_panel import RightPanel
from .panels.ticker import Ticker
from .paths import POLL_INTERVAL_SEC


class PonyouTUI(App):
    """4-panel ponyou dashboard."""

    CSS_PATH = "app.tcss"
    TITLE = "ponyou"

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh", "Refresh"),
        Binding("l", "toggle_log", "Pause log"),
        Binding("h", "help", "Help"),
        Binding("f", "fullscreen_log", "Fullscreen log"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._log_fullscreen = False

    def compose(self) -> ComposeResult:
        yield PonyouHeader(id="ponyou-header")
        with Horizontal(id="main"):
            yield LeftPanel()
            yield AgentLog()
            yield RightPanel()
        yield Ticker()
        yield Static(
            "q quit · r refresh · l pause-log · h help · f fullscreen-log",
            id="status-bar",
        )

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.run_worker(self._poll_loop(), exclusive=True, group="poll")
        self.run_worker(self._log_loop(), exclusive=True, group="log")

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(POLL_INTERVAL_SEC)
            await self._refresh_snapshot()

    async def _log_loop(self) -> None:
        log_panel = self.query_one(AgentLog)
        async for event in tail_actions():
            log_panel.push_event(event)

    async def _refresh_snapshot(self) -> None:
        snap = await read_snapshot()
        self.query_one(LeftPanel).update_from(snap)
        self.query_one(RightPanel).update_from(snap)
        self.query_one(Ticker).update_from(snap)
        if snap.errors:
            self.query_one(AgentLog).push_system(
                f"offline files: {','.join(snap.errors)}", tag="WARN"
            )

    async def action_refresh(self) -> None:
        await self._refresh_snapshot()
        self.query_one(AgentLog).push_system("manual refresh", tag="SYS")

    def action_toggle_log(self) -> None:
        paused = self.query_one(AgentLog).toggle_pause()
        msg = "log paused" if paused else "log resumed"
        self.notify(msg, severity="warning" if paused else "information")

    def action_help(self) -> None:
        self.notify(
            "q quit · r refresh · l pause log · f fullscreen log · h help",
            timeout=6,
        )

    def action_fullscreen_log(self) -> None:
        self._log_fullscreen = not self._log_fullscreen
        left = self.query_one(LeftPanel)
        right = self.query_one(RightPanel)
        left.display = not self._log_fullscreen
        right.display = not self._log_fullscreen


def main() -> None:
    PonyouTUI().run()


if __name__ == "__main__":
    main()
