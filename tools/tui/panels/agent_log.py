"""
Center panel: live agent log fed by ``data.log_tailer``.

The widget keeps the most recent ``LOG_BUFFER_LIMIT`` lines and auto-scrolls
to the bottom unless the user toggles pause with ``l``. Lines are color-
coded by tag (SYS/TOOL/API/OK/WARN/ERR). Lines starting with ``●`` render in
muted italic to match the "thinking" style from the spec.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime

from rich.text import Text
from textual.containers import Vertical
from textual.widgets import RichLog, Static

from ..paths import LOG_BUFFER_LIMIT

_TAG_STYLES = {
    "SYS": "#cccccc",
    "TOOL": "#FFD700",
    "API": "#00FFFF",
    "OK": "#00FF41",
    "WARN": "#FF8C00",
    "ERR": "#FF3333",
}


class AgentLog(Vertical):
    DEFAULT_ID = "center"

    def __init__(self) -> None:
        super().__init__()
        self._paused = False
        self._buffer: deque[dict] = deque(maxlen=LOG_BUFFER_LIMIT)

    def compose(self):
        yield Static("AGENT LOG", classes="panel-title")
        yield RichLog(id="log-panel", highlight=False, markup=False, wrap=True, auto_scroll=True)
        yield Static("", id="log-status", classes="muted")

    def on_mount(self) -> None:
        self._refresh_status()

    def push_event(self, event: dict) -> None:
        """Called by the log-tailer worker for each new line."""
        self._buffer.append(event)
        if self._paused:
            self._refresh_status()
            return
        self._write_event(event)

    def _write_event(self, event: dict) -> None:
        log = self.query_one("#log-panel", RichLog)
        text = Text()
        text.append(f"{event['ts']}  ", style="#888888")
        tag = event.get("tag", "SYS")
        text.append(f"[{tag:<4}] ", style=f"bold {_TAG_STYLES.get(tag, '#cccccc')}")
        body = event.get("text", "")
        if body.startswith("●"):
            text.append(body, style="#888888 italic")
        else:
            text.append(body, style=_TAG_STYLES.get(tag, "#cccccc"))
        log.write(text)

    def toggle_pause(self) -> bool:
        self._paused = not self._paused
        if not self._paused:
            log = self.query_one("#log-panel", RichLog)
            log.clear()
            for event in self._buffer:
                self._write_event(event)
        self._refresh_status()
        return self._paused

    def push_system(self, text: str, tag: str = "SYS") -> None:
        self.push_event({
            "ts": datetime.now().strftime("%H:%M:%S"),
            "tag": tag,
            "role": tag.lower(),
            "text": text,
        })

    def _refresh_status(self) -> None:
        status = self.query_one("#log-status", Static)
        if self._paused:
            status.update(Text("⏸ paused (l to resume)", style="#FF8C00"))
        else:
            status.update(
                Text(
                    f"live · {len(self._buffer)}/{LOG_BUFFER_LIMIT} lines · l=pause",
                    style="#888888",
                )
            )
