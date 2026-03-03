"""Transcription via OpenAI Whisper API or local faster-whisper."""
import io
import threading
import time

from openai import APIConnectionError, OpenAI
from httpx import ReadError

from app.config import (
    OPENAI_API_BASE,
    TRANSCRIBE_API_KEY,
    TRANSCRIBE_ENGINE,
    TRANSCRIBE_MAX_CONCURRENT,
    TRANSCRIBE_MAX_RETRIES,
    TRANSCRIBE_RETRY_BASE_SECONDS,
    TRANSCRIBE_RETRY_MAX_WAIT_SECONDS,
)

# Limit concurrent calls so we don't exceed provider rate/concurrency limits.
_transcribe_semaphore = threading.Semaphore(TRANSCRIBE_MAX_CONCURRENT)

CLEANUP_PROMPT = "Cleans up filler words and basic grammar to improve readability."


def transcribe_audio(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
    engine: str | None = None,
) -> str:
    """
    Transcribe audio bytes to text using Whisper (remote API or local faster-whisper).
    language: "auto" (default), "en", or "zh" (ISO-639-1). When "auto", Whisper auto-detects.
    clean_up: when True (API engine only), pass a prompt to guide cleanup; ignored for faster_whisper.
    engine: optional per-request override ("api" | "faster_whisper"); when None, use TRANSCRIBE_ENGINE from config.
    Raises ValueError if API key is missing (API engine) or request fails.
    At most TRANSCRIBE_MAX_CONCURRENT calls run at once (configurable).
    """
    effective_engine = (engine or TRANSCRIBE_ENGINE).strip().lower() if (engine and engine.strip()) else TRANSCRIBE_ENGINE
    _transcribe_semaphore.acquire()
    try:
        if effective_engine == "api":
            if not TRANSCRIBE_API_KEY:
                raise ValueError(
                    "Transcription API key not configured (set OPENAI_API_KEY or TRANSCRIBE_API_KEY)"
                )
            return _transcribe_audio_openai(audio_bytes, filename, language, clean_up)
        from app.services import transcribe_whisper as whisper_svc
        return whisper_svc.transcribe_audio_whisper(audio_bytes, filename, language, clean_up)
    finally:
        _transcribe_semaphore.release()


def _transcribe_audio_openai(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
) -> str:
    """OpenAI Whisper API implementation (called while holding _transcribe_semaphore)."""
    client_kw: dict = {"api_key": TRANSCRIBE_API_KEY}
    if OPENAI_API_BASE:
        client_kw["base_url"] = OPENAI_API_BASE
    client = OpenAI(**client_kw)

    name = filename or "audio"
    if not name.lower().endswith((".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm")):
        name = name + ".mp3"

    create_kw: dict = {"model": "whisper-1", "file": None}
    if clean_up:
        create_kw["prompt"] = CLEANUP_PROMPT
    if language and language != "auto":
        create_kw["language"] = language

    for attempt in range(TRANSCRIBE_MAX_RETRIES):
        try:
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
                raise ValueError(
                    f"Transcription failed after {TRANSCRIBE_MAX_RETRIES} attempts: {e}"
                ) from e
