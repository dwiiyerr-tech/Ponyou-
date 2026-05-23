"""
Top-of-screen header: gold app title on the left, session metadata on the
right. Rendered as a single Rich ``Table`` so the columns stay aligned
across resizes without us having to fight Textual's flex layout.
"""
from __future__ import annotations

from datetime import datetime

from rich.align import Align
from rich.table import Table
from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static


class PonyouHeader(Static):
    """Custom header (not Textual's built-in) so we can use the brand palette."""

    session_id: reactive[str] = reactive("ponyou")
    version: reactive[str] = reactive("v1.0.0")
    mode: reactive[str] = reactive("demo")
    last_update: reactive[str] = reactive("")

    DEFAULT_CSS = ""

    def on_mount(self) -> None:
        self.set_interval(1.0, self._tick)
        self._tick()

    def _tick(self) -> None:
        self.last_update = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._refresh_meta()

    def _refresh_meta(self) -> None:
        tbl = Table.grid(expand=True)
        tbl.add_column(justify="left", ratio=2)
        tbl.add_column(justify="right", ratio=1)

        title = Text("◆ PONYOU AGENT", style="bold #FFD700")
        title.append("  ·  Solana memecoin scalper", style="#888888")

        meta = Text()
        meta.append(f"{self.version}  ", style="#FFD700")
        meta.append(f"mode:{self.mode}  ", style="#00FF41")
        meta.append(f"session:{self.session_id}  ", style="#00FFFF")
        meta.append(self.last_update, style="#cccccc")

        tbl.add_row(title, meta)
        self.update(tbl)
