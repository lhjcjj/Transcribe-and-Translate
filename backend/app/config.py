"""Load configuration from environment variables. No secret defaults."""
import os
from typing import List


def _str_list(value: str | None) -> List[str]:
    if not value or not value.strip():
        return []
    return [s.strip() for s in value.split(",") if s.strip()]


# Allowed audio MIME type prefixes for upload validation
ALLOWED_AUDIO_PREFIXES = ("audio/", "application/octet-stream")

# Max audio size in bytes for transcribe endpoint (e.g. 25MB for Whisper)
MAX_TRANSCRIBE_BYTES = int(os.environ.get("MAX_TRANSCRIBE_BYTES", str(25 * 1024 * 1024)))

# Max file upload size in bytes (server-wide cap for user uploads; e.g. 100MB)
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))

# Upload TTL: unconsumed uploads expire after this many seconds (default 1 hour)
UPLOAD_TTL_SECONDS = int(os.environ.get("UPLOAD_TTL_SECONDS", "3600"))

# Max number of entries in upload store (metadata only; ~10 users × 100 chunks). Reject new uploads/chunks when full.
STORE_MAX_ENTRIES = int(os.environ.get("STORE_MAX_ENTRIES", "1000"))

# How often to run cleanup of expired uploads, in seconds (default 15 minutes)
CLEANUP_INTERVAL_SECONDS = int(os.environ.get("CLEANUP_INTERVAL_SECONDS", "900"))

# Orphan audio_split_* dirs older than this (seconds) are deleted by periodic cleanup (default 1 hour)
AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS = int(os.environ.get("AUDIO_SPLIT_ORPHAN_MAX_AGE_SECONDS", "3600"))

# CORS: comma-separated origins; default for local dev
ALLOWED_ORIGINS: List[str] = _str_list(
    os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000")
)

# Transcription (e.g. OpenAI Whisper). Key not defaulted.
TRANSCRIBE_API_KEY = os.environ.get("GPTS_API_KEY") or os.environ.get("OPENAI_API_KEY")
OPENAI_API_BASE = os.environ.get("GPTS_API_BASE") or os.environ.get("OPENAI_API_BASE")

# Translation: optional separate key; can use same OPENAI_API_KEY
TRANSLATE_API_KEY = os.environ.get("GPTS_API_KEY") or os.environ.get("OPENAI_API_KEY")
TRANSLATE_PROVIDER = (os.environ.get("TRANSLATE_PROVIDER") or "openai").strip().lower()
