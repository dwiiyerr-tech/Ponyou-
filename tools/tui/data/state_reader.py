"""
Async pollers for the JSON state files Ponyou writes at runtime.

Every reader returns ``None`` if the file is missing or malformed so widgets
can render an "OFFLINE" cell instead of crashing the dashboard. State files
are written atomically by the agent (tmp + rename), but we still guard with
try/except in case a poll lands mid-write on filesystems without atomic
rename semantics.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..paths import (
    LESSONS_FILE,
    MARKET_INTEL_FILE,
    METRICS_FILE,
    OBSERVED_TOKENS_FILE,
    SMART_WALLETS_FILE,
    STATE_FILE,
)


@dataclass
class PonyouSnapshot:
    state: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    market_intel: dict[str, Any] | None = None
    observed_tokens: dict[str, Any] | None = None
    lessons: dict[str, Any] | None = None
    smart_wallets: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


async def read_snapshot() -> PonyouSnapshot:
    """Run blocking JSON reads off the event loop."""
    loop = asyncio.get_running_loop()
    paths = {
        "state": STATE_FILE,
        "metrics": METRICS_FILE,
        "market_intel": MARKET_INTEL_FILE,
        "observed_tokens": OBSERVED_TOKENS_FILE,
        "lessons": LESSONS_FILE,
        "smart_wallets": SMART_WALLETS_FILE,
    }
    results = await asyncio.gather(
        *(loop.run_in_executor(None, _read_json, p) for p in paths.values())
    )
    snap = PonyouSnapshot()
    for (key, _), value in zip(paths.items(), results):
        setattr(snap, key, value)
        if value is None:
            snap.errors.append(key)
    return snap
