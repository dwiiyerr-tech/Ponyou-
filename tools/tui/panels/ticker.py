"""
Bottom marquee. We build the chip list from the latest snapshot, join with
" · ", duplicate the string so the scroll wraps seamlessly, and shift one
character per tick. Pure text widget — no animation backend needed.
"""
from __future__ import annotations

from rich.text import Text
from textual.widgets import Static

from ..data.formatters import ticker_segments
from ..data.state_reader import PonyouSnapshot
from ..paths import TICKER_INTERVAL_SEC


class Ticker(Static):
    DEFAULT_ID = "ticker"

    def __init__(self) -> None:
        super().__init__()
        self._text = "  ponyou booting…  "
        self._offset = 0

    def on_mount(self) -> None:
        self.set_interval(TICKER_INTERVAL_SEC, self._tick)

    def update_from(self, snap: PonyouSnapshot) -> None:
        chips = ticker_segments(snap)
        self._text = "  ●  ".join(chips) + "  ●  "

    def _tick(self) -> None:
        if not self._text:
            return
        width = max(self.size.width, 80)
        loop = self._text + self._text  # double to allow wrap window
        self._offset = (self._offset + 1) % len(self._text)
        view = loop[self._offset : self._offset + width]
        self.update(Text(view, style="bold #FFD700"))
