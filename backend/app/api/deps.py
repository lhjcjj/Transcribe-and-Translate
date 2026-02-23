"""Shared API dependencies and helpers (e.g. rate limiting, auth, validation)."""
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException, Request, UploadFile

from app import config


def require_api_key(request: Request) -> None:
    """When API_KEY is set, require X-API-Key or Authorization: Bearer to match. Otherwise no-op."""
    if not config.API_KEY:
        return
    key = request.headers.get("X-API-Key") or ""
    if not key and request.headers.get("Authorization"):
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            key = auth[7:].strip()
    if key != config.API_KEY:
        raise HTTPException(401, "Missing or invalid API key")


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
            return  # never returns; reject_413() raises
        chunks_buf.append(chunk)
    return b"".join(chunks_buf)
