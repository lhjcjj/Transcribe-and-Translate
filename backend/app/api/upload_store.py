"""In-memory store for uploaded files before split. upload_id -> (temp_path, filename, created_at).
Entries expire after UPLOAD_TTL_SECONDS; expired entries are removed on get or by periodic cleanup.
Duplicate detection: (filename, size) -> upload_id; if same filename and size already stored, return existing upload_id.
Thread-safe for concurrent request handlers."""
import asyncio
import logging
import os
import shutil
import tempfile
import threading
import time
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

from app.config import (
    UPLOAD_MAX_CONCURRENT,
    UPLOAD_TTL_SECONDS,
    AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS,
    STORE_MAX_ENTRIES,
)


class StoreFullError(Exception):
    """Raised when upload store has reached STORE_MAX_ENTRIES."""
    pass

# Starlette UploadFile spool (SpooledTemporaryFile) uses Python's default prefix "tmp" when rolled to disk.
# Pattern: "tmp" + alphanumeric/underscore (e.g. tmpz5_7wlpa). Only match likely single-file temp names.
_SPOOL_TEMP_PREFIX = "tmp"
_SPOOL_TEMP_MIN_SUFFIX_LEN = 5

_store_lock = threading.RLock()
_uploads: dict[str, tuple[str, str, float]] = {}  # upload_id -> (temp_path, filename, created_at)
_by_name_size: dict[tuple[str, int], str] = {}  # (filename, size) -> upload_id

# Limit concurrent uploads (read body + save) to control peak memory. Use in route: async with upload_semaphore: ...
upload_semaphore = asyncio.Semaphore(UPLOAD_MAX_CONCURRENT)


def _remove_entry(upload_id: str, path: str, filename: str) -> None:
    """Remove one entry from store and delete temp file. Idempotent for missing key/file."""
    _uploads.pop(upload_id, None)
    try:
        size = os.path.getsize(path)
        _by_name_size.pop((filename, size), None)
    except OSError:
        logger.debug("Cleanup failed (getsize/pop)")
    try:
        os.unlink(path)
    except OSError:
        logger.debug("Cleanup failed (unlink)")


def put_upload(temp_path: str, filename: str, size: int) -> str:
    """Store an uploaded file. Returns upload_id. size is used for duplicate index. Raises StoreFullError when at capacity."""
    with _store_lock:
        if len(_uploads) >= STORE_MAX_ENTRIES:
            raise StoreFullError("Upload store full (max entries). Try again later.")
        upload_id = str(uuid.uuid4())
        _uploads[upload_id] = (temp_path, filename, time.time())
        _by_name_size[(filename, size)] = upload_id
        return upload_id


def get_upload(upload_id: str) -> Optional[tuple[str, str]]:
    """Return (temp_path, filename) or None if not found or expired. Expired entries are removed."""
    with _store_lock:
        entry = _uploads.get(upload_id)
        if not entry:
            return None
        path, filename, created_at = entry
        if time.time() - created_at > UPLOAD_TTL_SECONDS:
            _remove_entry(upload_id, path, filename)
            return None
        return (path, filename)


def pop_upload(upload_id: str) -> Optional[tuple[str, str]]:
    """Remove and return (temp_path, filename), or None. Caller should delete temp_path if desired."""
    with _store_lock:
        entry = _uploads.pop(upload_id, None)
        if not entry:
            return None
        path, filename, created_at = entry
        try:
            size = os.path.getsize(path)
            _by_name_size.pop((filename, size), None)
        except OSError:
            logger.debug("Cleanup failed")
        return (path, filename)


def list_upload_entries() -> list[tuple[str, str, str]]:
    """Return snapshot of entries (upload_id, temp_path, filename) for tooling (e.g. scan script)."""
    with _store_lock:
        return [(uid, path, fn) for uid, (path, fn, _) in _uploads.items()]


def remove_upload_entry(upload_id: str) -> bool:
    """Remove one entry from store and delete its temp file. Returns True if entry existed. For tooling (e.g. scan script)."""
    with _store_lock:
        entry = _uploads.pop(upload_id, None)
        if not entry:
            return False
        path, filename, _ = entry
        try:
            size = os.path.getsize(path)
            _by_name_size.pop((filename, size), None)
        except OSError:
            logger.debug("Cleanup failed")
        try:
            os.unlink(path)
        except OSError:
            logger.debug("Cleanup failed")
        return True


def save_upload_bytes(body: bytes, filename: str) -> str:
    """Write body to a temp file, store it, return upload_id. If same filename and size already exists, return existing upload_id (no new file). On failure unlinks the temp file. Raises StoreFullError when at capacity."""
    size = len(body)
    key = (filename, size)
    with _store_lock:
        if len(_uploads) >= STORE_MAX_ENTRIES:
            raise StoreFullError("Upload store full (max entries). Try again later.")
        if key in _by_name_size:
            existing_id = _by_name_size[key]
            result = get_upload(existing_id)  # get_upload acquires lock; use same lock so we need to avoid re-entrancy. get_upload takes _store_lock.
            if result is not None:
                path, _fn = result
                _uploads[existing_id] = (path, filename, time.time())
                return existing_id
            _by_name_size.pop(key, None)  # stale ref after expiry
    fd, path = tempfile.mkstemp(suffix="", prefix="upload_")
    try:
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
        return put_upload(path, filename, size)
    except Exception:
        logger.debug("save_upload_bytes failed", exc_info=True)
        try:
            os.unlink(path)
        except OSError:
            logger.debug("Cleanup failed")
        raise


def cleanup_expired_uploads() -> None:
    """Remove all upload entries older than UPLOAD_TTL_SECONDS and delete their temp files."""
    now = time.time()
    with _store_lock:
        to_remove = [
            (upload_id, entry)
            for upload_id, entry in _uploads.items()
            if now - entry[2] > UPLOAD_TTL_SECONDS
        ]
        for upload_id, (path, filename, _) in to_remove:
            _remove_entry(upload_id, path, filename)


def _is_spool_temp_filename(name: str) -> bool:
    """True if name looks like Starlette/Python default spool temp file (e.g. tmpz5_7wlpa)."""
    if not name.startswith(_SPOOL_TEMP_PREFIX):
        return False
    suffix = name[len(_SPOOL_TEMP_PREFIX) :]
    if len(suffix) < _SPOOL_TEMP_MIN_SUFFIX_LEN:
        return False
    return all(c.isalnum() or c == "_" for c in suffix)


def _delete_orphaned_spool_temp_files(
    temp_dir: str,
    max_age_seconds: float,
    names: Optional[list[str]] = None,
) -> None:
    """Delete tmp* spool files in temp_dir older than max_age_seconds. If names is None, listdir(temp_dir); else use provided names (single listdir pass)."""
    if names is None:
        try:
            names = os.listdir(temp_dir)
        except OSError:
            return
    now = time.time()
    for name in names:
        if not _is_spool_temp_filename(name):
            continue
        full = os.path.join(temp_dir, name)
        try:
            if os.path.isfile(full) and now - os.path.getmtime(full) > max_age_seconds:
                os.unlink(full)
        except OSError:
            logger.debug("Cleanup failed")


def cleanup_orphaned_temp_files() -> None:
    """Delete orphan temp files from system temp dir: upload_* files, audio_split_* dirs, and old tmp* spool files (single listdir pass)."""
    temp_dir = tempfile.gettempdir()
    try:
        names = os.listdir(temp_dir)
    except OSError:
        logger.debug("listdir temp_dir failed")
        return
    for name in names:
        full = os.path.join(temp_dir, name)
        try:
            if name.startswith("upload_") and os.path.isfile(full):
                os.unlink(full)
            elif name.startswith("audio_split_") and os.path.isdir(full):
                shutil.rmtree(full, ignore_errors=True)
        except OSError:
            logger.debug("Cleanup failed")
    _delete_orphaned_spool_temp_files(temp_dir, AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS, names=names)


def cleanup_orphaned_spool_temp_files() -> None:
    """Delete Starlette spool temp files (tmp*) older than AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS. Uses shared _delete_orphaned_spool_temp_files."""
    _delete_orphaned_spool_temp_files(tempfile.gettempdir(), AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS)


def cleanup_orphaned_audio_split_dirs() -> None:
    """Delete audio_split_* dirs older than AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS only if no chunk inside is still in upload_store (e.g. in use by transcribe)."""
    with _store_lock:
        in_use_dirs = {
            os.path.dirname(entry[0])
            for entry in _uploads.values()
            if entry and len(entry) >= 2
        }
    temp_dir = tempfile.gettempdir()
    try:
        names = os.listdir(temp_dir)
    except OSError:
        logger.debug("listdir temp_dir failed")
        return
    now = time.time()
    for name in names:
        if not name.startswith("audio_split_"):
            continue
        full = os.path.join(temp_dir, name)
        try:
            if not os.path.isdir(full):
                continue
            if full in in_use_dirs:
                continue
            mtime = os.path.getmtime(full)
            if now - mtime > AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS:
                shutil.rmtree(full, ignore_errors=True)
        except OSError:
            logger.debug("Cleanup failed")
