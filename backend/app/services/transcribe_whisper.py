"""Local transcription via faster-whisper. Lazy-loads model on first use."""
from __future__ import annotations

import os
import tempfile
import threading

from app.config import FASTER_WHISPER_DEVICE, FASTER_WHISPER_MODEL

_model = None  # WhisperModel | None, set after first import
_lock = threading.Lock()


def _get_model():
    """Return the shared WhisperModel instance; load on first use."""
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel
            _model = WhisperModel(
                FASTER_WHISPER_MODEL,
                device=FASTER_WHISPER_DEVICE,
            )
        return _model


def transcribe_audio_whisper(
    audio_bytes: bytes,
    filename: str | None = None,
    language: str = "auto",
    clean_up: bool = True,
) -> str:
    """
    Transcribe audio using local faster-whisper. clean_up is ignored (no prompt).
    language: "auto" (default), "en", "zh", etc. "auto" -> auto-detect.
    """
    model = _get_model()

    name = filename or "audio"
    ext = (os.path.splitext(name)[1] or ".mp3").lower()
    if ext not in (".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"):
        ext = ".mp3"

    path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            path = f.name
            f.write(audio_bytes)

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
            pass
