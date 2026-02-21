"""In-memory store for uploaded files before split. upload_id -> (temp_file_path, original_filename).
Orphan entries (never split/transcribed) are not auto-cleaned; temp files and dict can grow without bound."""
import os
import tempfile
import uuid
from typing import Optional

_uploads: dict[str, tuple[str, str]] = {}


def put_upload(temp_path: str, filename: str) -> str:
    """Store an uploaded file. Returns upload_id."""
    upload_id = str(uuid.uuid4())
    _uploads[upload_id] = (temp_path, filename)
    return upload_id


def get_upload(upload_id: str) -> Optional[tuple[str, str]]:
    """Return (temp_path, filename) or None if not found."""
    return _uploads.get(upload_id)


def pop_upload(upload_id: str) -> Optional[tuple[str, str]]:
    """Remove and return (temp_path, filename), or None. Caller should delete temp_path if desired."""
    return _uploads.pop(upload_id, None)


def save_upload_bytes(body: bytes, filename: str) -> str:
    """Write body to a temp file, store it, return upload_id. On failure unlinks the temp file."""
    fd, path = tempfile.mkstemp(suffix="", prefix="upload_")
    try:
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
        return put_upload(path, filename)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
