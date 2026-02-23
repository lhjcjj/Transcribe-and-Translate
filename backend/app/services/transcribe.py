"""Transcription via OpenAI Whisper API."""
import io
import threading
import time
from openai import APIConnectionError, OpenAI
from httpx import ReadError

from app.config import (
    OPENAI_API_BASE,
    TRANSCRIBE_API_KEY,
    TRANSCRIBE_MAX_CONCURRENT,
    TRANSCRIBE_MAX_RETRIES,
    TRANSCRIBE_RETRY_BASE_SECONDS,
    TRANSCRIBE_RETRY_MAX_WAIT_SECONDS,
)

# Limit concurrent calls to Whisper so we don't exceed provider rate/concurrency limits.
_transcribe_semaphore = threading.Semaphore(TRANSCRIBE_MAX_CONCURRENT)

CLEANUP_PROMPT = "Cleans up filler words and basic grammar to improve readability."


def transcribe_audio(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
) -> str:
    """
    Transcribe audio bytes to text using Whisper.
    language: "auto" (default), "en", or "zh" (ISO-639-1). When "auto", Whisper auto-detects.
    clean_up: when True, pass a prompt to guide cleanup of filler words and grammar; when False, no prompt.
    Raises ValueError if API key is missing or request fails.
    At most TRANSCRIBE_MAX_CONCURRENT calls run at once (configurable).
    """
    if not TRANSCRIBE_API_KEY:
        raise ValueError("Transcription API key not configured (set OPENAI_API_KEY or TRANSCRIBE_API_KEY)")

    _transcribe_semaphore.acquire()
    try:
        return _transcribe_audio_impl(audio_bytes, filename, language, clean_up)
    finally:
        _transcribe_semaphore.release()


def _transcribe_audio_impl(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
) -> str:
    """Implementation (called while holding _transcribe_semaphore)."""
    client_kw: dict = {"api_key": TRANSCRIBE_API_KEY}
    if OPENAI_API_BASE:
        client_kw["base_url"] = OPENAI_API_BASE
    client = OpenAI(**client_kw)

    # OpenAI expects a file-like with name hint for format
    name = filename or "audio"
    if not name.lower().endswith((".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm")):
        name = name + ".mp3"

    create_kw: dict = {"model": "whisper-1", "file": None}
    if clean_up:
        create_kw["prompt"] = CLEANUP_PROMPT
    if language and language != "auto":
        create_kw["language"] = language

    # Retry on connection errors (network instability, proxy issues)
    for attempt in range(TRANSCRIBE_MAX_RETRIES):
        try:
            # Recreate file_like for each attempt (BytesIO may be consumed)
            file_like = io.BytesIO(audio_bytes)
            file_like.name = name
            create_kw["file"] = file_like
            response = client.audio.transcriptions.create(**create_kw)
            return (response.text or "").strip()
        except (APIConnectionError, ReadError) as e:
            if attempt < TRANSCRIBE_MAX_RETRIES - 1:
                wait_time = min(
                    TRANSCRIBE_RETRY_BASE_SECONDS * (2 ** attempt),
                    TRANSCRIBE_RETRY_MAX_WAIT_SECONDS,
                )
                time.sleep(wait_time)
            else:
                # All retries exhausted
                raise ValueError(
                    f"Transcription failed after {TRANSCRIBE_MAX_RETRIES} attempts: {e}"
                ) from e
