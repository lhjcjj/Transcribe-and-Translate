"""Shared API dependencies and helpers (e.g. rate limiting, auth, validation)."""
from collections.abc import Callable
from typing import Any

from fastapi import UploadFile

from app import config


# Chunk size for streaming read when capping upload size
READ_CHUNK_BYTES = 64 * 1024  # 64KB


def allowed_audio_content_type(content_type: str | None) -> bool:
    """Return True if content_type is allowed for audio upload (or missing)."""
    if not content_type:
        return True
    return any(content_type.lower().startswith(p) for p in config.ALLOWED_AUDIO_PREFIXES)


async def read_file_with_size_cap(
    audio: UploadFile,
    max_bytes: int,
    reject_413: Callable[[], Any],
    chunk_bytes: int = READ_CHUNK_BYTES,
) -> bytes:
    """Read uploaded file in chunks; call reject_413() and never return if total > max_bytes."""
    chunks_buf: list[bytes] = []
    total = 0
    while True:
        chunk = await audio.read(chunk_bytes)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            del chunks_buf
            reject_413()
        chunks_buf.append(chunk)
    return b"".join(chunks_buf)
