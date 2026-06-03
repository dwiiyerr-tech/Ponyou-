#!/usr/bin/env python3
"""
notebooklm_client.py — JSON CLI wrapper around notebooklm-py

Usage:
  python3 scripts/notebooklm_client.py <command> [--args json_string]

Commands:
  status                                    → auth status check
  list_notebooks                            → list all notebooks
  create_notebook <title>                   → create a new notebook
  find_or_create <title>                    → find by title or create
  upload_text <notebook_id> <title> <content> → upload text source
  ask <notebook_id> <question>              → ask a question
  delete_source <notebook_id> <source_id>  → delete a source

All output is a single JSON line to stdout.
Errors are reported as {"ok": false, "error": "<type>", "detail": "<msg>"}
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


def _out(payload: dict) -> None:
    """Print a single JSON line and flush."""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _err(error: str, detail: str) -> None:
    _out({"ok": False, "error": error, "detail": detail})


async def _get_client(storage_path: Path):
    """
    Return an initialised NotebookLMClient context manager.
    Raises ImportError if library unavailable, FileNotFoundError if storage
    missing, and re-raises any auth/network error for callers to classify.
    """
    from notebooklm import NotebookLMClient  # type: ignore
    return NotebookLMClient.from_storage(storage_path=storage_path)


# ── Command handlers ─────────────────────────────────────────────────────────

async def cmd_status(storage_path: Path) -> None:
    if not storage_path.exists():
        _out({"ok": True, "authenticated": False, "email": None})
        return
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        cm = NotebookLMClient.from_storage(storage_path=storage_path)
        async with cm as client:
            # A lightweight call to verify the session is live.
            notebooks = await client.notebooks.list()
            email = None
            try:
                email = str(client.auth.email) if hasattr(client.auth, "email") else None
            except Exception:
                pass
            _out({"ok": True, "authenticated": True, "email": email})
    except FileNotFoundError:
        _out({"ok": True, "authenticated": False, "email": None})
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


async def cmd_list_notebooks(storage_path: Path) -> None:
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with NotebookLMClient.from_storage(storage_path=storage_path) as client:
            notebooks = await client.notebooks.list()
            result = []
            for nb in notebooks:
                nb_id = getattr(nb, "id", None) or getattr(nb, "notebook_id", None)
                title = getattr(nb, "title", None) or getattr(nb, "name", None) or ""
                result.append({"id": str(nb_id), "title": str(title)})
            _out({"ok": True, "notebooks": result})
    except FileNotFoundError:
        _err("not_authenticated", "Storage state file not found — run auth setup first")
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


async def cmd_create_notebook(storage_path: Path, title: str) -> None:
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with NotebookLMClient.from_storage(storage_path=storage_path) as client:
            nb = await client.notebooks.create(title=title)
            nb_id = getattr(nb, "id", None) or getattr(nb, "notebook_id", None)
            nb_title = getattr(nb, "title", None) or title
            _out({"ok": True, "notebook_id": str(nb_id), "title": str(nb_title)})
    except FileNotFoundError:
        _err("not_authenticated", "Storage state file not found — run auth setup first")
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


async def cmd_find_or_create(storage_path: Path, title: str) -> None:
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with NotebookLMClient.from_storage(storage_path=storage_path) as client:
            notebooks = await client.notebooks.list()
            for nb in notebooks:
                nb_title = getattr(nb, "title", None) or getattr(nb, "name", None) or ""
                if nb_title.strip().lower() == title.strip().lower():
                    nb_id = getattr(nb, "id", None) or getattr(nb, "notebook_id", None)
                    _out({"ok": True, "notebook_id": str(nb_id), "created": False})
                    return
            # Not found — create
            nb = await client.notebooks.create(title=title)
            nb_id = getattr(nb, "id", None) or getattr(nb, "notebook_id", None)
            _out({"ok": True, "notebook_id": str(nb_id), "created": True})
    except FileNotFoundError:
        _err("not_authenticated", "Storage state file not found — run auth setup first")
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


async def cmd_upload_text(
    storage_path: Path, notebook_id: str, title: str, content: str
) -> None:
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with NotebookLMClient.from_storage(storage_path=storage_path) as client:
            source = await client.sources.add_text(
                notebook_id=notebook_id,
                title=title,
                text=content,
            )
            source_id = (
                getattr(source, "id", None)
                or getattr(source, "source_id", None)
            )
            _out({"ok": True, "source_id": str(source_id)})
    except FileNotFoundError:
        _err("not_authenticated", "Storage state file not found — run auth setup first")
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


async def cmd_ask(storage_path: Path, notebook_id: str, question: str) -> None:
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with NotebookLMClient.from_storage(storage_path=storage_path) as client:
            response = await client.chat.ask(
                notebook_id=notebook_id,
                question=question,
            )
            answer = (
                getattr(response, "answer", None)
                or getattr(response, "text", None)
                or getattr(response, "content", None)
                or str(response)
            )
            # Sources may be a list of objects or plain strings
            raw_sources = (
                getattr(response, "sources", None)
                or getattr(response, "citations", None)
                or []
            )
            sources = []
            for s in raw_sources:
                if isinstance(s, str):
                    sources.append(s)
                elif isinstance(s, dict):
                    sources.append(s)
                else:
                    sources.append(str(s))
            _out({"ok": True, "answer": str(answer), "sources": sources})
    except FileNotFoundError:
        _err("not_authenticated", "Storage state file not found — run auth setup first")
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


async def cmd_delete_source(
    storage_path: Path, notebook_id: str, source_id: str
) -> None:
    try:
        from notebooklm import NotebookLMClient  # type: ignore
        async with NotebookLMClient.from_storage(storage_path=storage_path) as client:
            await client.sources.delete(
                notebook_id=notebook_id,
                source_id=source_id,
            )
            _out({"ok": True})
    except FileNotFoundError:
        _err("not_authenticated", "Storage state file not found — run auth setup first")
    except Exception as exc:
        cls = type(exc).__name__.lower()
        if "auth" in cls or "credential" in cls or "login" in cls or "cookie" in cls:
            _err("not_authenticated", str(exc))
        else:
            _err("network_error", str(exc))


# ── CLI entry point ───────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="NotebookLM JSON CLI — all output is a single JSON line on stdout",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "command",
        choices=[
            "status",
            "list_notebooks",
            "create_notebook",
            "find_or_create",
            "upload_text",
            "ask",
            "delete_source",
        ],
        help="Command to run",
    )
    p.add_argument(
        "positional",
        nargs="*",
        help="Positional arguments for the command (title, notebook_id, etc.)",
    )
    p.add_argument(
        "--storage",
        default=os.environ.get(
            "PONYOU_NLM_STORAGE",
            str(Path.home() / ".notebooklm" / "profiles" / "default" / "storage_state.json"),
        ),
        help="Path to Playwright storage state JSON (auth cookies)",
    )
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    storage_path = Path(args.storage)
    cmd = args.command
    pos = args.positional  # list of remaining positional strings

    try:
        if cmd == "status":
            asyncio.run(cmd_status(storage_path))

        elif cmd == "list_notebooks":
            asyncio.run(cmd_list_notebooks(storage_path))

        elif cmd == "create_notebook":
            if not pos:
                _err("bad_args", "create_notebook requires <title>")
                return
            asyncio.run(cmd_create_notebook(storage_path, pos[0]))

        elif cmd == "find_or_create":
            if not pos:
                _err("bad_args", "find_or_create requires <title>")
                return
            asyncio.run(cmd_find_or_create(storage_path, pos[0]))

        elif cmd == "upload_text":
            if len(pos) < 3:
                _err("bad_args", "upload_text requires <notebook_id> <title> <content>")
                return
            notebook_id, title, content = pos[0], pos[1], pos[2]
            asyncio.run(cmd_upload_text(storage_path, notebook_id, title, content))

        elif cmd == "ask":
            if len(pos) < 2:
                _err("bad_args", "ask requires <notebook_id> <question>")
                return
            asyncio.run(cmd_ask(storage_path, pos[0], pos[1]))

        elif cmd == "delete_source":
            if len(pos) < 2:
                _err("bad_args", "delete_source requires <notebook_id> <source_id>")
                return
            asyncio.run(cmd_delete_source(storage_path, pos[0], pos[1]))

        else:
            _err("unknown_command", f"Unrecognised command: {cmd}")

    except KeyboardInterrupt:
        _err("interrupted", "Process interrupted")
    except Exception as exc:
        _err("unexpected_error", str(exc))


if __name__ == "__main__":
    main()
