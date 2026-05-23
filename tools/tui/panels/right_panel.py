"""
Right column: live market data block on top + observed-tokens scannable +
lessons summary. The market block uses a Rich grid of label/value cells
because Textual's DataTable is overkill for 5 stat lines.
"""
from __future__ import annotations

from rich.table import Table
from rich.text import Text
from textual.containers import Vertical
from textual.widgets import DataTable, Static

from ..data.formatters import lessons_rows, market_summary, observed_rows
from ..data.state_reader import PonyouSnapshot

_CONDITION_STYLES = {
    "HOT": "#00FF41",
    "WARM": "#00FF41",
    "NEUTRAL": "#FFD700",
    "COLD": "#FF8C00",
    "ICE": "#FF3333",
    "DEAD": "#FF3333",
}


class MarketBlock(Static):
    def update_from(self, snap: PonyouSnapshot) -> None:
        m = market_summary(snap.market_intel)
        tbl = Table.grid(padding=(0, 2), expand=True)
        tbl.add_column(style="#888888")
        tbl.add_column(style="#FFD700", justify="right")

        cond_style = _CONDITION_STYLES.get(m["condition"].upper(), "#FFD700")
        tbl.add_row("Condition", Text(m["condition"], style=f"bold {cond_style}"))
        tbl.add_row("Confidence", m["confidence"])
        tbl.add_row("Fresh 1h", m["fresh"])
        tbl.add_row("Buy ratio", m["buy_ratio"])
        tbl.add_row("Tokens seen", m["tokens"])
        self.update(tbl)


class ObservedTable(DataTable):
    def on_mount(self) -> None:
        self.cursor_type = "row"
        self.zebra_stripes = True
        self.add_columns("Symbol", "MCap", "Age", "Filter")

    def update_from(self, snap: PonyouSnapshot) -> None:
        self.clear()
        for sym, mcap, age, status in observed_rows(snap.observed_tokens):
            self.add_row(
                Text(sym, style="#FFD700"),
                Text(mcap, style="#00FFFF"),
                Text(age, style="#888888"),
                Text(status, style="#00FF41" if status == "PASS" else "#FF3333"),
            )


class LessonsBlock(Static):
    def update_from(self, snap: PonyouSnapshot) -> None:
        rows = lessons_rows(snap.lessons)
        if not rows:
            self.update(Text("no lessons yet", style="#888888 italic"))
            return
        tbl = Table.grid(padding=(0, 1))
        tbl.add_column(style="#00FFFF")
        tbl.add_column(style="#cccccc")
        tbl.add_column(style="#888888", justify="right")
        for role, rule, score in rows:
            tbl.add_row(role, rule, score)
        self.update(tbl)


class RightPanel(Vertical):
    DEFAULT_ID = "right"

    def compose(self):
        yield Static("MARKET", classes="panel-title")
        yield MarketBlock(id="market-block")
        yield Static("OBSERVED TOKENS", classes="section-title")
        yield ObservedTable(id="observed-table")
        yield Static("LESSONS", classes="section-title")
        yield LessonsBlock(id="lessons-block")

    def update_from(self, snap: PonyouSnapshot) -> None:
        self.query_one(MarketBlock).update_from(snap)
        self.query_one(ObservedTable).update_from(snap)
        self.query_one(LessonsBlock).update_from(snap)
