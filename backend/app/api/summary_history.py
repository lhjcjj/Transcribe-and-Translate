"""Simple on-disk store for summary history. List returns metadata only; get by id returns full text."""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

_lock = threading.RLock()
_HISTORY_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "summaries"
_HISTORY_DIR.mkdir(parents=True, exist_ok=True)
_MAX_ENTRIES = 1000
_UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

_AUDIO_EXT_RE = re.compile(r"\.(mp3|wav|m4a|flac|ogg|webm|mp4|aac|opus|wma)$", re.IGNORECASE)
_TRAILING_SUFFIX_RE = re.compile(r"\((raw|trans|sum|sum-transcript|sum-translation|art)\)$", re.IGNORECASE)


def _validate_id(summary_id: str) -> None:
    if not summary_id or not _UUID_PATTERN.match(summary_id.strip().lower()):
        raise ValueError("Invalid summary id")


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


def save_summary(
    display_name: str,
    text: str,
    meta: Mapping[str, Any] | None = None,
) -> str:
    summary_id = str(uuid.uuid4())
    raw = (display_name or "").strip()

    # Determine desired summary suffix
    suffix: str | None = None
    lower = raw.lower()
    if lower.endswith("(sum-transcript)"):
        suffix = "(sum-transcript)"
        base = raw[: -len("(sum-transcript)")].rstrip()
    elif lower.endswith("(sum-translation)"):
        suffix = "(sum-translation)"
        base = raw[: -len("(sum-translation)")].rstrip()
    elif lower.endswith("(sum)"):
        suffix = "(sum)"
        base = raw[: -len("(sum)")].rstrip()
    else:
        base = raw

    # When frontend has no filename or uses Current/Current(...), fall back to Summary xxxxxxxx
    if not base or base == "Current" or base.startswith("Current("):
        base = f"Summary {summary_id[:8]}"
        # If suffix came from Current(...), keep it; otherwise default to (sum)
        if suffix is None:
            suffix = "(sum)"

    # Strip audio extensions and any existing trailing known suffixes (raw/trans/etc.) from base
    base = _AUDIO_EXT_RE.sub("", base)
    base = _TRAILING_SUFFIX_RE.sub("", base).rstrip()

    if suffix is None:
        suffix = "(sum)"

    dn = f"{base}{suffix}"
    payload: dict[str, Any] = {
        "id": summary_id,
        "created_at": time.time(),
        "display_name": dn,
        "text": text,
    }
    if meta:
        payload["meta"] = dict(meta)
    path = _HISTORY_DIR / f"{summary_id}.json"
    with _lock:
        try:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except OSError:
            return summary_id
        _prune_if_needed()
    return summary_id


def list_summaries(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    if limit <= 0 or limit > 100:
        limit = 50
    offset = max(0, offset)
    try:
        files = [
            p for p in _HISTORY_DIR.iterdir()
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
        sid = data.get("id") or p.stem
        created_at = data.get("created_at")
        display_name = (data.get("display_name") or "").strip()
        # Backward compatibility: older entries may only have display_name in meta.
        if not display_name:
            meta = data.get("meta")
            if isinstance(meta, dict) and meta.get("display_name"):
                display_name = str(meta["display_name"]).strip()
        out.append(
            {
                "id": sid,
                "created_at": created_at,
                "display_name": display_name or f"Summary {sid[:8]}",
            }
        )
    return out


def get_summary(summary_id: str) -> dict[str, Any] | None:
    try:
        _validate_id(summary_id)
    except ValueError:
        return None
    path = _HISTORY_DIR / f"{summary_id.strip().lower()}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or "text" not in data:
        return None
    sid = data.get("id", summary_id)
    display_name = (data.get("display_name") or "").strip()
    if not display_name:
        meta = data.get("meta")
        if isinstance(meta, dict) and meta.get("display_name"):
            display_name = str(meta["display_name"]).strip()
    if not display_name:
        display_name = f"Summary {str(sid)[:8]}"
    return {
        "id": sid,
        "created_at": data.get("created_at"),
        "display_name": display_name,
        "text": data.get("text", ""),
        "meta": data.get("meta"),
    }


def delete_summary(summary_id: str) -> bool:
    try:
        _validate_id(summary_id)
    except ValueError:
        return False
    path = _HISTORY_DIR / f"{summary_id.strip().lower()}.json"
    try:
        if not path.is_file():
            return False
        path.unlink()
        return True
    except OSError:
        return False
