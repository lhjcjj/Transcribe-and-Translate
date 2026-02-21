"""Split audio into chunks by fixed duration (5 min per segment, or 1 min for WAV)."""
import io
import shutil
import tempfile
import threading
from pathlib import Path

from pydub import AudioSegment


# Only one split at a time to limit peak memory (one decoded file + one chunk).
_split_lock = threading.Lock()

# Format suffixes Whisper supports; pydub uses same names for import/export
SUPPORTED_SUFFIXES = (".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm")


def _format_from_filename(filename: str) -> str:
    """Infer pydub format from filename extension. Default 'mp3'."""
    p = Path(filename)
    ext = (p.suffix or "").lower()
    if ext in (".mpeg", ".mpga"):
        return "mp3"
    if ext == ".mp4":
        return "mp4"
    if ext in (".mp3", ".m4a", ".wav", ".webm"):
        return ext.lstrip(".")
    return "mp3"


def split_audio_into_chunks(audio_bytes: bytes, filename: str) -> tuple[str, list[tuple[str, str]]]:
    """
    Split audio by fixed duration: Non-WAV 5 minutes per segment, WAV 1 minute per segment.
    Writes each chunk to disk immediately so memory holds at most: decoded segment + one chunk.

    Uses time boundaries (via pydub) so each chunk is valid audio. Requires ffmpeg for m4a/mp3 etc.

    Returns:
        (temp_dir, [(chunk_path, chunk_filename), ...]) in time order.
        Caller must delete temp_dir (e.g. shutil.rmtree(temp_dir)) when done.
    Raises:
        ValueError: Unsupported format, empty audio, or ffmpeg/pydub error.

    Only one split runs at a time (global lock) to avoid OOM from concurrent large files.
    """
    _split_lock.acquire()
    try:
        return _split_audio_into_chunks_impl(audio_bytes, filename)
    finally:
        _split_lock.release()


def _split_audio_into_chunks_impl(audio_bytes: bytes, filename: str) -> tuple[str, list[tuple[str, str]]]:
    """Implementation of split_audio_into_chunks (called while holding _split_lock)."""
    if not audio_bytes:
        raise ValueError("Empty audio bytes")

    fmt = _format_from_filename(filename)
    base_name = Path(filename).stem or "audio"

    try:
        segment = AudioSegment.from_file(io.BytesIO(audio_bytes), format=fmt)
    except Exception as e:
        raise ValueError(f"Failed to load audio (install ffmpeg for {fmt}): {e}") from e
    del audio_bytes  # (1) drop original file as soon as decoded; keep only decoded segment

    duration_ms = len(segment)
    if duration_ms <= 0:
        raise ValueError("Audio has no duration")

    # WAV is uncompressed and large: 1 minute per chunk. Other formats: 5 minutes per chunk.
    if fmt == "wav":
        nominal_segment_duration_ms = 60 * 1000  # 1 minute
    else:
        nominal_segment_duration_ms = 5 * 60 * 1000  # 5 minutes

    temp_dir = tempfile.mkdtemp(prefix="audio_split_")
    try:
        out_list = _write_chunks(segment, fmt, base_name, temp_dir)
        return (temp_dir, out_list)
    except Exception:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except OSError:
            pass
        raise


def _write_chunks(segment, fmt: str, base_name: str, temp_dir: str) -> list[tuple[str, str]]:
    out_list: list[tuple[str, str]] = []
    start_ms = 0
    index = 0
    duration_ms = len(segment)
    nominal_segment_duration_ms = 60 * 1000 if fmt == "wav" else 5 * 60 * 1000

    while start_ms < duration_ms:
        curr_duration_ms = min(nominal_segment_duration_ms, duration_ms - start_ms)
        end_ms = start_ms + curr_duration_ms
        part = segment[start_ms:end_ms]

        buf = io.BytesIO()
        part.export(buf, format=fmt)
        chunk_bytes = buf.getvalue()

        ext = "." + fmt if fmt != "mp4" else ".m4a"
        chunk_filename = f"{base_name}_part_{index + 1:03d}{ext}"
        chunk_path = Path(temp_dir) / chunk_filename
        chunk_path.write_bytes(chunk_bytes)  # (2) write immediately, then release refs
        out_list.append((str(chunk_path), chunk_filename))
        del part, buf, chunk_bytes  # release before next iteration to ease GC
        index += 1
        start_ms = end_ms

    return out_list
