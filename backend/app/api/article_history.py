"""Simple on-disk store for restructured articles (Restructure history)."""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

_lock = threading.RLock()
_HISTORY_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "articles"
_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
_MAX_ENTRIES = 1000
_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_id(article_id: str) -> None:
    if not article_id or not _ID_PATTERN.match(article_id.strip()):
        raise ValueError("Invalid article id")


def _prune_if_needed() -> None:
    try:
        items = sorted(
            (p for p in _HISTORY_DIR.iterdir() if p.is_file() and p.suffix == ".json"),
            key=lambda p: p.stat().st_mtime,
        )
    except OSError:
        return
    extra = len(items) - _MAX_ENTRIES
    if extra <= 0:
        return
    for p in items[:extra]:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            continue


def save_article(display_name: str, text: str) -> str:
    """Save a restructured article to disk and return its id."""
    article_id = str(uuid.uuid4())
    dn = (display_name or "").strip() or f"Article {article_id[:8]}"
    if not dn.endswith("(art)"):
        dn = dn + "(art)"
    payload: dict[str, Any] = {
        "id": article_id,
        "created_at": time.time(),
        "display_name": dn,
        "text": text,
    }
    path = _HISTORY_DIR / f"{article_id}.json"
    with _lock:
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return article_id
        _prune_if_needed()
    return article_id


def list_articles(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    """Return recent articles metadata only (id, created_at, display_name)."""
    if limit <= 0 or limit > 100:
        limit = 50
    offset = max(0, offset)
    try:
        files = [p for p in _HISTORY_DIR.iterdir() if p.is_file() and p.suffix == ".json"]
    except OSError:
        return []
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out: list[dict[str, Any]] = []
    for p in files[offset : offset + limit]:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        aid = (data.get("id") or p.stem).strip()
        out.append(
            {
                "id": aid,
                "created_at": data.get("created_at"),
                "display_name": (data.get("display_name") or "").strip() or f"Article {aid[:8]}",
                "notion_url": (data.get("notion_url") or "").strip() or None,
            }
        )
    return out


def get_article(article_id: str) -> dict[str, Any] | None:
    """Return one article by id (full text), or None when not found/invalid."""
    try:
        _validate_id(article_id)
    except ValueError:
        return None
    path = _HISTORY_DIR / f"{article_id.strip()}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or "text" not in data:
        return None
    return {
        "id": data.get("id", article_id),
        "created_at": data.get("created_at"),
        "display_name": (data.get("display_name") or "").strip() or f"Article {article_id[:8]}",
        "text": data.get("text", ""),
        "notion_url": (data.get("notion_url") or "").strip() or None,
    }


def update_article_notion(article_id: str, notion_url: str | None, notion_page_id: str | None = None) -> bool:
    """Update an article's last-pushed Notion URL (and optional page id). Returns True if updated."""
    try:
        _validate_id(article_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{article_id.strip()}.json"
    if not path.is_file():
        return False
    with _lock:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not isinstance(data, dict) or "text" not in data:
            return False
        data["notion_url"] = (notion_url or "").strip() or None
        data["notion_page_id"] = (notion_page_id or "").strip() or None
        try:
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return False
    return True


def delete_article(article_id: str) -> bool:
    """Delete one article by id. Returns True on success, False otherwise."""
    try:
        _validate_id(article_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{article_id.strip()}.json"
    try:
        if not path.is_file():
            return False
        path.unlink()
        return True
    except OSError:
        return False

