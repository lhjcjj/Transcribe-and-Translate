"""Simple on-disk store for saved podcasts (Get Information).

Each podcast is one JSON file in a history directory. List/get/update/delete
use strict UUID validation. RSS is updated via PATCH after user clicks RSS.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path

_lock = threading.RLock()

_HISTORY_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "podcasts"
_HISTORY_DIR.mkdir(parents=True, exist_ok=True)

_MAX_ENTRIES = 500
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _validate_id(podcast_id: str) -> None:
    if not podcast_id or not _UUID_PATTERN.match(podcast_id.strip().lower()):
        raise ValueError("Invalid podcast id")


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


def save_podcast(name: str, link: str) -> str:
    """Create a new podcast. Returns id."""
    podcast_id = str(uuid.uuid4())
    payload = {
        "id": podcast_id,
        "created_at": time.time(),
        "name": (name or "").strip(),
        "link": (link or "").strip(),
        "rss": None,
    }
    path = _HISTORY_DIR / f"{podcast_id}.json"
    with _lock:
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return podcast_id
        _prune_if_needed()
    return podcast_id


def update_podcast(podcast_id: str, name: str, link: str) -> bool:
    """Update name and link. Returns True if updated."""
    try:
        _validate_id(podcast_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{podcast_id.strip().lower()}.json"
    if not path.is_file():
        return False
    with _lock:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not isinstance(data, dict):
            return False
        data["name"] = (name or "").strip()
        data["link"] = (link or "").strip()
        try:
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return False
    return True


def update_podcast_rss(podcast_id: str, rss: str) -> bool:
    """Set rss for a podcast. Returns True if updated."""
    try:
        _validate_id(podcast_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{podcast_id.strip().lower()}.json"
    if not path.is_file():
        return False
    with _lock:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not isinstance(data, dict):
            return False
        data["rss"] = (rss or "").strip() or None
        try:
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return False
    return True


def list_podcasts(limit: int = 100, offset: int = 0) -> list[dict]:
    """Return podcasts sorted by created_at desc. Each item: id, created_at, name, link, rss."""
    limit = min(max(1, limit), 100)
    offset = max(0, offset)
    try:
        files = [
            p
            for p in _HISTORY_DIR.iterdir()
            if p.is_file() and p.suffix == ".json" and _UUID_PATTERN.match(p.stem.lower())
        ]
    except OSError:
        return []
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for p in files[offset : offset + limit]:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        out.append({
            "id": data.get("id", p.stem),
            "created_at": data.get("created_at"),
            "name": (data.get("name") or "").strip(),
            "link": (data.get("link") or "").strip(),
            "rss": (data.get("rss") or "").strip() or None,
        })
    return out


def get_podcast(podcast_id: str) -> dict | None:
    """Load one podcast by id. Returns None if not found."""
    try:
        _validate_id(podcast_id)
    except ValueError:
        return None
    path = _HISTORY_DIR / f"{podcast_id.strip().lower()}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return {
        "id": data.get("id", podcast_id),
        "created_at": data.get("created_at"),
        "name": (data.get("name") or "").strip(),
        "link": (data.get("link") or "").strip(),
        "rss": (data.get("rss") or "").strip() or None,
    }


def delete_podcast(podcast_id: str) -> bool:
    """Remove one podcast. Returns True if removed."""
    try:
        _validate_id(podcast_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{podcast_id.strip().lower()}.json"
    try:
        if not path.is_file():
            return False
        path.unlink()
        return True
    except OSError:
        return False
