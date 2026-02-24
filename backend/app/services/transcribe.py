"""Transcription via OpenAI Whisper API or local faster-whisper."""
import io
import os
import tempfile
import threading
import time
from openai import APIConnectionError, OpenAI
from httpx import ReadError
from faster_whisper import WhisperModel

from app.config import (
    OPENAI_API_BASE,
    TRANSCRIBE_API_KEY,
    TRANSCRIBE_ENGINE,
    TRANSCRIBE_MAX_CONCURRENT,
    TRANSCRIBE_MAX_RETRIES,
    TRANSCRIBE_RETRY_BASE_SECONDS,
    TRANSCRIBE_RETRY_MAX_WAIT_SECONDS,
    FASTER_WHISPER_MODEL,
    FASTER_WHISPER_DEVICE,
)

# Limit concurrent calls to Whisper so we don't exceed provider rate/concurrency limits.
_transcribe_semaphore = threading.Semaphore(TRANSCRIBE_MAX_CONCURRENT)

# faster_whisper: lazy-loaded singleton (first use loads model, then reused).
_faster_whisper_model: WhisperModel | None = None
_faster_whisper_lock = threading.Lock()


def _get_faster_whisper_model() -> WhisperModel:
    """Return the shared WhisperModel instance; load on first use."""
    global _faster_whisper_model
    with _faster_whisper_lock:
        if _faster_whisper_model is None:
            _faster_whisper_model = WhisperModel(
                FASTER_WHISPER_MODEL,
                device=FASTER_WHISPER_DEVICE,
            )
        return _faster_whisper_model


CLEANUP_PROMPT = "Cleans up filler words and basic grammar to improve readability."


def transcribe_audio(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
    engine: str | None = None,
) -> str:
    """
    Transcribe audio bytes to text using Whisper (OpenAI API or local faster-whisper).
    language: "auto" (default), "en", or "zh" (ISO-639-1). When "auto", Whisper auto-detects.
    clean_up: when True (OpenAI only), pass a prompt to guide cleanup; ignored for faster_whisper.
    engine: optional per-request override ("openai" | "faster_whisper"); when None, use TRANSCRIBE_ENGINE from config.
    Raises ValueError if API key is missing (openai) or request fails.
    At most TRANSCRIBE_MAX_CONCURRENT calls run at once (configurable).
    """
    effective_engine = (engine or TRANSCRIBE_ENGINE).strip().lower() if (engine and engine.strip()) else TRANSCRIBE_ENGINE
    _transcribe_semaphore.acquire()
    try:
        if effective_engine == "openai":
            if not TRANSCRIBE_API_KEY:
                raise ValueError(
                    "Transcription API key not configured (set OPENAI_API_KEY or TRANSCRIBE_API_KEY)"
                )
            return _transcribe_audio_impl(audio_bytes, filename, language, clean_up)
        # faster_whisper (default when not openai)
        return _transcribe_faster_whisper(audio_bytes, filename, language, clean_up)
    finally:
        _transcribe_semaphore.release()


def _transcribe_audio_impl(
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


def _transcribe_faster_whisper(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
) -> str:
    """Local faster-whisper implementation (called while holding _transcribe_semaphore). clean_up is ignored."""
    model = _get_faster_whisper_model()

    # Suffix from filename or default .mp3
    name = filename or "audio"
    ext = (os.path.splitext(name)[1] or ".mp3").lower()
    if ext not in (".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"):
        ext = ".mp3"

    path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            path = f.name  # set before write so finally can delete even if write raises
            f.write(audio_bytes)

        # "auto" -> None (auto-detect); "en"/"zh" etc. pass through
        lang_param: str | None = None if language == "auto" else language

        segments, _ = model.transcribe(path, language=lang_param)
        text = " ".join(s.text for s in segments).strip()
        return text
    except Exception as e:
        raise ValueError(f"Transcription failed: {e}") from e
    finally:
        try:
            if path and os.path.exists(path):
                os.unlink(path)
        except OSError:
            pass  # 忽略删除失败（文件已被删、权限等）
