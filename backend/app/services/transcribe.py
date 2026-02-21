"""Transcription via OpenAI Whisper API."""
import io
import time
from openai import APIConnectionError, OpenAI
from httpx import ReadError

from app.config import TRANSCRIBE_API_KEY, OPENAI_API_BASE


def transcribe_audio(audio_bytes: bytes, filename: str | None = None) -> str:
    """
    Transcribe audio bytes to text using Whisper.
    Raises ValueError if API key is missing or request fails.
    """
    if not TRANSCRIBE_API_KEY:
        raise ValueError("Transcription API key not configured (set OPENAI_API_KEY or TRANSCRIBE_API_KEY)")

    client_kw: dict = {"api_key": TRANSCRIBE_API_KEY}
    if OPENAI_API_BASE:
        client_kw["base_url"] = OPENAI_API_BASE
    client = OpenAI(**client_kw)

    # OpenAI expects a file-like with name hint for format
    name = filename or "audio"
    if not name.lower().endswith((".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm")):
        name = name + ".mp3"

    # Retry on connection errors (network instability, proxy issues)
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Recreate file_like for each attempt (BytesIO may be consumed)
            file_like = io.BytesIO(audio_bytes)
            file_like.name = name
            response = client.audio.transcriptions.create(
                model="whisper-1",
                file=file_like,
            )
            return (response.text or "").strip()
        except (APIConnectionError, ReadError) as e:
            if attempt < max_retries - 1:
                # Exponential backoff: 1s, 2s, 4s
                wait_time = 2 ** attempt
                time.sleep(wait_time)
            else:
                # All retries exhausted
                raise ValueError(f"Transcription failed after {max_retries} attempts: {e}") from e
