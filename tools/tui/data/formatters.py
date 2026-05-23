"""
Pure formatters that convert Ponyou's raw JSON snapshot shapes into the row
tuples each Textual panel renders. Keeping them in one module makes them
trivially unit-testable and keeps the panel widgets free of business logic.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable


def _short(addr: str | None, prefix: int = 6) -> str:
    if not addr:
        return "—"
    return addr[:prefix] + "…" if len(addr) > prefix + 1 else addr


def _ago(iso: str | None) -> str:
    if not iso:
        return "—"
    try:
        ts = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return "—"
    delta = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
    secs = int(delta.total_seconds())
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m"
    if secs < 86_400:
        return f"{secs // 3600}h"
    return f"{secs // 86_400}d"


def positions_rows(state: dict | None) -> list[tuple[str, str, str, str, str, str]]:
    """(name, side, amount_sol, wallet, age, peak_pnl%)"""
    if not state:
        return []
    out = []
    for pos in (state.get("positions") or {}).values():
        if pos.get("closed"):
            continue
        out.append((
            pos.get("pool_name") or pos.get("position_key", "")[:10],
            (pos.get("position") or "?").upper(),
            f"{pos.get('amount_sol', 0):.3f}",
            _short(pos.get("wallet_address"), 4),
            _ago(pos.get("deployed_at")),
            f"{pos.get('peak_pnl_pct', 0):+.1f}%",
        ))
    return out


def recent_event_lines(state: dict | None, limit: int = 8) -> list[tuple[str, str]]:
    """(timestamp_short, line) tuples for the recent-events scroller."""
    if not state:
        return []
    events = (state.get("recentEvents") or [])[-limit:][::-1]
    out = []
    for ev in events:
        ts = ev.get("ts", "")
        try:
            ts_short = datetime.fromisoformat(ts.replace("Z", "+00:00")).strftime("%H:%M:%S")
        except ValueError:
            ts_short = ts[-8:] if ts else "??:??:??"
        action = ev.get("action") or "event"
        pool = ev.get("pool_name") or ev.get("position", "")
        out.append((ts_short, f"{action} · {pool}"))
    return out


def market_summary(market_intel: dict | None) -> dict[str, str]:
    """Latest market-condition snapshot rolled up into headline values."""
    blank = {"condition": "—", "confidence": "—", "fresh": "—", "buy_ratio": "—", "tokens": "—"}
    if not market_intel:
        return blank
    snaps = market_intel.get("snapshots") or []
    if not snaps:
        return blank
    last = snaps[-1]
    metrics = last.get("metrics") or {}
    return {
        "condition": last.get("condition", "—"),
        "confidence": f"{last.get('confidence', 0) * 100:.0f}%",
        "fresh": str(metrics.get("fresh_tokens_1h", "—")),
        "buy_ratio": f"{metrics.get('buy_ratio', 0):.2f}",
        "tokens": str(metrics.get("token_count", "—")),
    }


def observed_rows(observed: dict | None, limit: int = 10) -> list[tuple[str, str, str, str]]:
    """(symbol, mcap, age, filters)"""
    if not observed:
        return []
    rows = (observed.get("observed") or [])[-limit:][::-1]
    out = []
    for tok in rows:
        out.append((
            (tok.get("symbol") or _short(tok.get("mint"), 4))[:10],
            f"${tok.get('initial_mcap', 0):,.0f}",
            _ago(tok.get("observed_at")),
            "PASS" if tok.get("passed_filters") else "FAIL",
        ))
    return out


def lessons_rows(lessons: dict | None, limit: int = 6) -> list[tuple[str, str, str]]:
    """(role, rule_short, wins/losses) — pinned lessons first."""
    if not lessons:
        return []
    bag = lessons.get("lessons") or []
    bag = sorted(bag, key=lambda x: (not x.get("pinned"), -(x.get("times_applied") or 0)))
    out = []
    for lesson in bag[:limit]:
        rule = (lesson.get("rule") or "")[:48]
        wins = lesson.get("success_count", 0)
        losses = lesson.get("failure_count", 0)
        out.append((
            (lesson.get("role") or "—")[:10],
            rule,
            f"{wins}/{losses}",
        ))
    return out


def session_summary(metrics: dict | None) -> dict[str, str]:
    """Header / left-panel session block."""
    blank = {"started": "—", "uptime": "—", "mgmt_p50": "—", "screen_p50": "—"}
    if not metrics:
        return blank
    uptime_ms = metrics.get("session_uptime_ms") or 0
    secs = uptime_ms // 1000
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    series = metrics.get("series") or {}
    mgmt = series.get("management_cycle_ms") or {}
    scan = series.get("screening_cycle_ms") or {}
    return {
        "started": metrics.get("session_started_at", "—")[:19].replace("T", " "),
        "uptime": f"{h:02d}:{m:02d}:{s:02d}",
        "mgmt_p50": f"{mgmt.get('p50', 0):.0f}ms" if mgmt else "—",
        "screen_p50": f"{scan.get('p50', 0):.0f}ms" if scan else "—",
    }


def ticker_segments(snapshot) -> list[str]:
    """Flatten snapshot into ticker chips. Imported lazily by ticker panel."""
    chips: list[str] = []
    mk = market_summary(getattr(snapshot, "market_intel", None))
    chips.append(f"MARKET {mk['condition']} ({mk['confidence']})")
    chips.append(f"FRESH 1h {mk['fresh']}")
    chips.append(f"BUY-RATIO {mk['buy_ratio']}")

    state = getattr(snapshot, "state", None) or {}
    open_positions = sum(
        1 for p in (state.get("positions") or {}).values() if not p.get("closed")
    )
    chips.append(f"OPEN POS {open_positions}")

    sess = session_summary(getattr(snapshot, "metrics", None))
    chips.append(f"UPTIME {sess['uptime']}")
    chips.append(f"MGMT p50 {sess['mgmt_p50']}")
    chips.append(f"SCAN p50 {sess['screen_p50']}")

    lessons = getattr(snapshot, "lessons", None) or {}
    chips.append(f"LESSONS {len(lessons.get('lessons') or [])}")

    return chips
