"""Simple on-disk store for completed transcriptions.

Each saved transcription is written as a standalone JSON file in a history
directory. List/get/delete APIs use strict UUID validation to prevent path
traversal. List returns metadata only (no full text) for performance.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

_lock = threading.RLock()

# History directory lives alongside the backend code by default. Fixed path so
# history survives process restarts.
_HISTORY_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "transcriptions"
_HISTORY_DIR.mkdir(parents=True, exist_ok=True)

# Soft cap to avoid unbounded growth. When exceeded, oldest entries are removed.
_MAX_ENTRIES = 1000

# Only allow canonical UUID v4 hex (lowercase) to avoid path traversal.
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def _validate_id(transcription_id: str) -> None:
    """Raise ValueError if id is not a safe UUID (no path traversal)."""
    if not transcription_id or not _UUID_PATTERN.match(transcription_id.strip().lower()):
        raise ValueError("Invalid transcription id")


def _prune_if_needed() -> None:
    """Best-effort pruning when history exceeds _MAX_ENTRIES.

    Deletes the oldest files first based on modification time. Runs under the
    same lock as save_transcription to avoid races.
    """

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
            # Best effort; ignore failures.
            continue


def save_transcription(text: str, meta: Mapping[str, Any] | None = None) -> str:
    """Persist one completed transcription to disk.

    Args:
        text: Full transcription text (possibly partial if some chunks failed).
        meta: Optional metadata for future history features
              (e.g. {'source': 'upload_ids', 'upload_ids': [...]}).

    Returns:
        A generated transcription_id (string UUID).
    """

    transcription_id = str(uuid.uuid4())
    payload: dict[str, Any] = {
        "id": transcription_id,
        "created_at": time.time(),
        "text": text,
    }
    if meta:
        payload["meta"] = dict(meta)

    path = _HISTORY_DIR / f"{transcription_id}.json"

    with _lock:
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError:
            # If saving fails we don't propagate to the request; transcription
            # should still succeed. This is strictly a best-effort log.
            return transcription_id
        _prune_if_needed()

    return transcription_id


def list_transcriptions(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    """Return recent transcriptions (metadata only, no full text). Sorted by created_at desc.

    Each item: { "id", "created_at", "display_name" }. display_name from meta or fallback.
    Invalid/corrupt files are skipped. Pagination: limit (max 100 per page), offset (skip N).
    """
    if limit <= 0 or limit > 100:
        limit = 50
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
    out: list[dict[str, Any]] = []
    for p in files[offset : offset + limit]:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        tid = data.get("id") or p.stem
        created_at = data.get("created_at")
        meta = data.get("meta")
        display_name = ""
        if isinstance(meta, dict) and meta.get("display_name"):
            display_name = str(meta["display_name"]).strip()
        out.append({
            "id": tid,
            "created_at": created_at,
            "display_name": display_name or f"Transcription {tid[:8]}",
        })
    return out


def get_transcription(transcription_id: str) -> dict[str, Any] | None:
    """Load one transcription by id. Returns None if not found or invalid id.

    Returned dict has id, created_at, text, meta. Do not expose internal paths in errors.
    """
    try:
        _validate_id(transcription_id)
    except ValueError:
        return None
    path = _HISTORY_DIR / f"{transcription_id.strip().lower()}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or "text" not in data:
        return None
    return {
        "id": data.get("id", transcription_id),
        "created_at": data.get("created_at"),
        "text": data.get("text", ""),
        "meta": data.get("meta"),
    }


def delete_transcription(transcription_id: str) -> bool:
    """Remove one transcription by id. Returns True if removed, False if not found or invalid id."""
    try:
        _validate_id(transcription_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{transcription_id.strip().lower()}.json"
    try:
        if not path.is_file():
            return False
        path.unlink()
        return True
    except OSError:
        return False

