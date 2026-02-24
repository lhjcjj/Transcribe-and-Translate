"""Load configuration from environment variables. No secret defaults."""
import os
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env so project-only vars (e.g. TRANSCRIBE_ENGINE) can be set without system env
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _str_list(value: str | None) -> list[str]:
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

# Max concurrent split operations (1 = serial; >1 allows N splits in parallel). Limits peak memory.
SPLIT_MAX_CONCURRENT = max(1, int(os.environ.get("SPLIT_MAX_CONCURRENT", "4")))

# Max concurrent uploads (1 = serial; >1 allows N uploads in parallel). Limits peak memory when reading body.
UPLOAD_MAX_CONCURRENT = max(1, int(os.environ.get("UPLOAD_MAX_CONCURRENT", "4")))

# Max concurrent calls to transcription API (Whisper). Respects provider rate/concurrency limits.
TRANSCRIBE_MAX_CONCURRENT = max(1, int(os.environ.get("TRANSCRIBE_MAX_CONCURRENT", "4")))

# Retry backoff (seconds): base * 2^attempt, capped by max. Reduces thread hold time in executor.
TRANSCRIBE_RETRY_BASE_SECONDS = float(os.environ.get("TRANSCRIBE_RETRY_BASE_SECONDS", "0.5"))
TRANSCRIBE_RETRY_MAX_WAIT_SECONDS = float(os.environ.get("TRANSCRIBE_RETRY_MAX_WAIT_SECONDS", "2.0"))

# Max number of chunk upload_ids per transcribe request; rejects with 400 when exceeded to avoid long-running single request.
TRANSCRIBE_MAX_BATCH_SIZE = max(1, int(os.environ.get("TRANSCRIBE_MAX_BATCH_SIZE", "300")))

# Max retries for transcription API on connection errors.
TRANSCRIBE_MAX_RETRIES = max(1, int(os.environ.get("TRANSCRIBE_MAX_RETRIES", "3")))

# Transcription engine: "openai" (Whisper API) or "faster_whisper" (local).
TRANSCRIBE_ENGINE = (os.environ.get("TRANSCRIBE_ENGINE") or "faster_whisper").strip().lower()
# faster_whisper only: model name (e.g. base, small, medium) and device (cpu, cuda, etc.).
FASTER_WHISPER_MODEL = (os.environ.get("FASTER_WHISPER_MODEL") or "base").strip().lower()
FASTER_WHISPER_DEVICE = (os.environ.get("FASTER_WHISPER_DEVICE") or "cpu").strip().lower()

# Optional API key for /api: when set, every request must send X-API-Key or Authorization: Bearer <key>. Leave empty for no auth (e.g. local only).
API_KEY = (os.environ.get("API_KEY") or os.environ.get("BACKEND_API_KEY") or "").strip()

# CORS: comma-separated origins; default for local dev
ALLOWED_ORIGINS: list[str] = _str_list(
    os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000")
)

# Transcription (e.g. OpenAI Whisper). Key not defaulted.
TRANSCRIBE_API_KEY = os.environ.get("GPTS_API_KEY") or os.environ.get("OPENAI_API_KEY")
OPENAI_API_BASE = os.environ.get("GPTS_API_BASE") or os.environ.get("OPENAI_API_BASE")

# Translation: optional separate key; can use same OPENAI_API_KEY
TRANSLATE_API_KEY = os.environ.get("GPTS_API_KEY") or os.environ.get("OPENAI_API_KEY")
TRANSLATE_PROVIDER = (os.environ.get("TRANSLATE_PROVIDER") or "openai").strip().lower()
