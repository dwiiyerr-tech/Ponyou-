"""
Ponyou repo-root resolution.

The TUI lives at ``tools/tui/`` so the repo root is two levels up. We expose
the JSON state files and the daily action log directory as constants so the
data layer never has to recompute paths.
"""
from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

STATE_FILE = REPO_ROOT / "state.json"
METRICS_FILE = REPO_ROOT / "metrics.json"
MARKET_INTEL_FILE = REPO_ROOT / "market-intel.json"
OBSERVED_TOKENS_FILE = REPO_ROOT / "observed-tokens.json"
LESSONS_FILE = REPO_ROOT / "lessons.json"
SMART_WALLETS_FILE = REPO_ROOT / "smart-wallets.json"

LOGS_DIR = REPO_ROOT / "logs"

POLL_INTERVAL_SEC = 2.0
LOG_TAIL_INTERVAL_SEC = 0.5
TICKER_INTERVAL_SEC = 0.18
LOG_BUFFER_LIMIT = 500
