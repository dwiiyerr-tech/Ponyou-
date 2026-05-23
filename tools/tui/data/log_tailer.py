"""
Tail Ponyou's daily ``logs/actions-YYYY-MM-DD.jsonl`` file and yield parsed
events. Rotates automatically when the date rolls over.

Each agent action looks like::

    {"timestamp": "...", "tool": "...", "args": {...}, "result": {...},
     "duration_ms": 123, "success": true}

We yield a small dict the log panel can render directly so the panel stays
free of file-system concerns.
"""
from __future__ import annotations

import asyncio
import json
from datetime import date, datetime
from pathlib import Path
from typing import AsyncIterator

from ..paths import LOG_TAIL_INTERVAL_SEC, LOGS_DIR


def _today_log() -> Path:
    return LOGS_DIR / f"actions-{date.today().isoformat()}.jsonl"


def _latest_log() -> Path | None:
    if not LOGS_DIR.exists():
        return None
    candidates = sorted(LOGS_DIR.glob("actions-*.jsonl"))
    return candidates[-1] if candidates else None


def _classify(event: dict) -> tuple[str, str]:
    """Return (tag, color_role) so the panel can style the line."""
    if event.get("success") is False:
        return "ERR", "err"
    tool = (event.get("tool") or "").lower()
    if "rpc" in tool or "fetch" in tool or "helius" in tool:
        return "API", "api"
    if event.get("tool"):
        return "TOOL", "tool"
    return "SYS", "sys"


def _format(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return {"ts": "??:??:??", "tag": "ERR", "role": "err", "text": line[:200]}
    ts_raw = event.get("timestamp") or event.get("ts")
    try:
        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).strftime("%H:%M:%S")
    except (AttributeError, ValueError):
        ts = datetime.now().strftime("%H:%M:%S")
    tag, role = _classify(event)
    tool = event.get("tool", "event")
    duration = event.get("duration_ms")
    suffix = f" ({duration}ms)" if duration is not None else ""
    return {"ts": ts, "tag": tag, "role": role, "text": f"{tool}{suffix}"}


async def tail_actions() -> AsyncIterator[dict]:
    """
    Async generator yielding formatted log events.

    Strategy: open the current day's file, seek to EOF, poll for new bytes.
    When the date rolls over, switch to the new file. If no log file exists
    yet, yield a placeholder once and keep polling until one appears.
    """
    current_path: Path | None = None
    fh = None
    try:
        while True:
            target = _today_log()
            if not target.exists():
                target = _latest_log() or target
            if target != current_path:
                if fh is not None:
                    fh.close()
                if target.exists():
                    fh = target.open("r", encoding="utf-8", errors="replace")
                    fh.seek(0, 2)  # tail mode: skip historical events
                    current_path = target
                    yield {
                        "ts": datetime.now().strftime("%H:%M:%S"),
                        "tag": "SYS",
                        "role": "sys",
                        "text": f"tail attached: {target.name}",
                    }
                else:
                    yield {
                        "ts": datetime.now().strftime("%H:%M:%S"),
                        "tag": "WARN",
                        "role": "warn",
                        "text": f"waiting for {target.name}",
                    }
                    await asyncio.sleep(LOG_TAIL_INTERVAL_SEC * 4)
                    continue

            line = fh.readline()
            if line:
                event = _format(line)
                if event is not None:
                    yield event
                continue
            await asyncio.sleep(LOG_TAIL_INTERVAL_SEC)
    finally:
        if fh is not None:
            fh.close()
