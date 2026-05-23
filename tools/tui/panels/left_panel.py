"""
Left column: agent identity + session metrics + open-positions table +
recent-events scroller. One container so the parent layout treats it as a
single flex child.
"""
from __future__ import annotations

from rich.table import Table
from rich.text import Text
from textual.containers import Vertical
from textual.widgets import DataTable, Static

from ..data.formatters import (
    positions_rows,
    recent_event_lines,
    session_summary,
)
from ..data.state_reader import PonyouSnapshot


class AgentInfo(Static):
    """Top-left card: who am I + session metrics."""

    def update_from(self, snap: PonyouSnapshot) -> None:
        sess = session_summary(snap.metrics)
        state = snap.state or {}
        open_positions = sum(
            1 for p in (state.get("positions") or {}).values() if not p.get("closed")
        )

        tbl = Table.grid(padding=(0, 1))
        tbl.add_column(style="#888888")
        tbl.add_column(style="#FFD700", justify="right")

        tbl.add_row("Identity", "ponyou-agent")
        tbl.add_row("Started", sess["started"])
        tbl.add_row("Uptime", sess["uptime"])
        tbl.add_row("Open pos.", str(open_positions))
        tbl.add_row("Mgmt p50", sess["mgmt_p50"])
        tbl.add_row("Scan p50", sess["screen_p50"])
        self.update(tbl)


class PositionsTable(DataTable):
    """Open positions — refreshed each poll without clearing focus."""

    def on_mount(self) -> None:
        self.cursor_type = "row"
        self.zebra_stripes = True
        self.add_columns("Pool", "Side", "SOL", "Wallet", "Age", "Peak")

    def update_from(self, snap: PonyouSnapshot) -> None:
        self.clear()
        for row in positions_rows(snap.state):
            styled = (
                Text(row[0], style="#FFD700"),
                Text(row[1], style="#00FF41" if row[1] == "LONG" else "#FF8C00"),
                Text(row[2], style="#cccccc"),
                Text(row[3], style="#00FFFF"),
                Text(row[4], style="#888888"),
                Text(
                    row[5],
                    style="#00FF41" if row[5].startswith("+") else "#FF3333",
                ),
            )
            self.add_row(*styled)


class RecentEvents(Static):
    """Below positions: condensed event log from state.recentEvents."""

    def update_from(self, snap: PonyouSnapshot) -> None:
        rows = recent_event_lines(snap.state)
        if not rows:
            self.update(Text("no recent events", style="#888888 italic"))
            return
        tbl = Table.grid(padding=(0, 1))
        tbl.add_column(style="#888888")
        tbl.add_column(style="#cccccc")
        for ts, line in rows:
            tbl.add_row(ts, line)
        self.update(tbl)


class LeftPanel(Vertical):
    DEFAULT_ID = "left"

    def compose(self):
        yield Static("AGENT", classes="panel-title")
        yield AgentInfo(id="agent-info")
        yield Static("ACTIVE POSITIONS", classes="section-title")
        yield PositionsTable(id="positions-table")
        yield Static("RECENT EVENTS", classes="section-title")
        yield RecentEvents(id="recent-events")

    def update_from(self, snap: PonyouSnapshot) -> None:
        self.query_one(AgentInfo).update_from(snap)
        self.query_one(PositionsTable).update_from(snap)
        self.query_one(RecentEvents).update_from(snap)
