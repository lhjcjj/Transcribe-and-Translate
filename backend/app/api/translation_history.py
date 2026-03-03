"""Simple on-disk store for translation history.

Each saved translation is written as a standalone JSON file. List returns
metadata only (no full text) to reduce memory; get by id returns full text.
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

_HISTORY_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "translations"
_HISTORY_DIR.mkdir(parents=True, exist_ok=True)

_MAX_ENTRIES = 1000

_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

_AUDIO_EXT_RE = re.compile(r"\.(mp3|wav|m4a|flac|ogg|webm|mp4|aac|opus|wma)$", re.IGNORECASE)
_TRAILING_SUFFIX_RE = re.compile(r"\((raw|trans|sum|sum-transcript|sum-translation|art)\)$", re.IGNORECASE)


def _normalize_translation_name(display_name: str, translation_id: str) -> str:
    """For translation history: strip audio extensions and any existing (...) suffixes then add exactly one (trans)."""
    dn = (display_name or "").strip()
    if not dn or dn == "Current transcript":
        dn = f"Translation {translation_id[:8]}"
    # Strip audio extension at end, e.g. .mp3
    dn = _AUDIO_EXT_RE.sub("", dn)
    # Strip any existing known suffix in parentheses at end, e.g. (raw) or (trans)
    dn = _TRAILING_SUFFIX_RE.sub("", dn).rstrip()
    return f"{dn}(trans)"


def _validate_id(translation_id: str) -> None:
    if not translation_id or not _UUID_PATTERN.match(translation_id.strip().lower()):
        raise ValueError("Invalid translation id")


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


def save_translation(
    display_name: str,
    text: str,
    meta: Mapping[str, Any] | None = None,
) -> str:
    """Persist one translation. Returns generated id (UUID)."""
    translation_id = str(uuid.uuid4())
    dn = _normalize_translation_name(display_name, translation_id)
    payload: dict[str, Any] = {
        "id": translation_id,
        "created_at": time.time(),
        "display_name": dn,
        "text": text,
    }
    if meta:
        payload["meta"] = dict(meta)
    path = _HISTORY_DIR / f"{translation_id}.json"
    with _lock:
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return translation_id
        _prune_if_needed()
    return translation_id


def list_translations(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    """Return recent translations (metadata only). Sorted by created_at desc."""
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
        display_name = (data.get("display_name") or "").strip()
        # Backward compatibility: older entries may only have display_name in meta.
        if not display_name:
            meta = data.get("meta")
            if isinstance(meta, dict) and meta.get("display_name"):
                display_name = str(meta["display_name"]).strip()
        out.append(
            {
                "id": tid,
                "created_at": created_at,
                "display_name": display_name or f"Translation {tid[:8]}",
            }
        )
    return out


def get_translation(translation_id: str) -> dict[str, Any] | None:
    """Load one translation by id. Returns None if not found or invalid id."""
    try:
        _validate_id(translation_id)
    except ValueError:
        return None
    path = _HISTORY_DIR / f"{translation_id.strip().lower()}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or "text" not in data:
        return None
    tid = data.get("id", translation_id)
    display_name = (data.get("display_name") or "").strip()
    if not display_name:
        meta = data.get("meta")
        if isinstance(meta, dict) and meta.get("display_name"):
            display_name = str(meta["display_name"]).strip()
    if not display_name:
        display_name = f"Translation {str(tid)[:8]}"
    return {
        "id": tid,
        "created_at": data.get("created_at"),
        "display_name": display_name,
        "text": data.get("text", ""),
        "meta": data.get("meta"),
    }


def delete_translation(translation_id: str) -> bool:
    """Remove one translation by id. Returns True if removed, False if not found or invalid id."""
    try:
        _validate_id(translation_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{translation_id.strip().lower()}.json"
    try:
        if not path.is_file():
            return False
        path.unlink()
        return True
    except OSError:
        return False
