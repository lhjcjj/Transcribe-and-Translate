"""Transcribe and translate endpoints."""
import asyncio
import json
import logging
import os
import queue
import re
import shutil
import threading
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import AsyncIterator, Callable
from urllib.parse import urlparse, unquote

import httpx

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app import config
from app.api.deps import allowed_audio_content_type, read_file_with_size_cap, require_api_key
from app.schemas.upload import (
    SplitRequest,
    SplitResponse,
    UploadChunkItem,
    UploadConfigResponse,
    UploadDurationResponse,
    UploadFromUrlRequest,
    UploadResponse,
)
from app.api.upload_store import (
    StoreFullError,
    get_upload,
    pop_upload,
    put_upload,
    save_upload_bytes,
    upload_semaphore,
)
from app.schemas.transcribe import TranscribeResponse
from app.schemas.summarize import SummarizeRequest, SummarizeResponse
from app.schemas.transcription_history import TranscriptionDetail, TranscriptionListItem
from app.schemas.translation_history import (
    TranslationDetail,
    TranslationListItem,
    TranslationSaveRequest,
    TranslationSaveResponse,
)
from app.schemas.summary_history import (
    SummaryDetail,
    SummaryListItem,
    SummarySaveRequest,
    SummarySaveResponse,
)
from app.schemas.article_history import (
    ArticleDetail,
    ArticleListItem,
    ArticleNotionExportRequest,
    ArticleNotionExportResponse,
    ArticleSaveRequest,
    ArticleSaveResponse,
)
from app.schemas.podcast_history import (
    PodcastFeedAudioItem,
    PodcastListItem,
    PodcastRssRequest,
    PodcastSaveRequest,
    PodcastSaveResponse,
    PodcastUpdateRequest,
)
from app.api import transcription_history, translation_history, summary_history, article_history, podcast_history
from app.schemas.translate import TranslateRequest, TranslateResponse
from app.services import audio_split as audio_split_svc
from app.services import transcribe as transcribe_svc
from app.services import translate as translate_svc
from app.services import summarize as summarize_svc
from app.services import summarize_qwen as summarize_qwen_svc
from app.services import notion_articles as notion_articles_svc


class SplitCancelled(Exception):
    """Raised when client disconnects during split stream."""
    pass


router = APIRouter(prefix="/api", tags=["api"], dependencies=[Depends(require_api_key)])

_MULTIPART_OVERHEAD_BYTES = 1 * 1024 * 1024  # 1MB for Content-Length reject

# Delay (seconds) after each progress line (1/6..6/6) so client is more likely to receive lines one-by-one
PROGRESS_YIELD_DELAY_SEC = 0.2


def _reject_413_size(max_bytes: int, kind: str = "Request body") -> None:
    """Raise HTTP 413 for size limit exceeded. Never returns."""
    raise HTTPException(413, f"{kind} too large (max {max_bytes} bytes)")


# Sanitize target_lang: alphanumeric, spaces, hyphens only (no injection)
TARGET_LANG_PATTERN = re.compile(r"^[a-zA-Z0-9\u4e00-\u9fff\s\-]{1,20}$")

# Filename: max length and allowed chars (alphanumeric, dot, underscore, hyphen, space, basic Unicode letters)
FILENAME_MAX_LENGTH = 200
FILENAME_ALLOWED_PATTERN = re.compile(r"[a-zA-Z0-9._\s\-\u4e00-\u9fff]+")


def _chunk_filename_to_original(chunk_filename: str) -> str:
    """If chunk_filename matches split pattern '{base}_part_{NNN}{ext}', return '{base}{ext}' (original upload name). Else return as-is."""
    if not chunk_filename:
        return chunk_filename
    m = re.match(r"^(.+)_part_\d{1,5}(\.[a-zA-Z0-9]+)$", chunk_filename)
    if m:
        return m.group(1) + m.group(2)
    return chunk_filename


def _sanitize_filename(audio: UploadFile) -> str:
    """Return a safe filename: no path, whitelist chars only, max length. Prevents abuse and confusion."""
    name = audio.filename or "audio"
    if "/" in name or "\\" in name:
        name = name.replace("\\", "/").split("/")[-1]
    name = name.strip()
    # Keep only allowed characters
    name = ("".join(FILENAME_ALLOWED_PATTERN.findall(name))).strip() or "audio"
    # Truncate to max length
    if len(name) > FILENAME_MAX_LENGTH:
        name = name[:FILENAME_MAX_LENGTH].rstrip() or "audio"
    return name


def _sanitize_download_filename_from_url(url: str) -> str:
    """Infer a safe download filename from a URL (used for podcast episode downloads)."""
    name = ""
    try:
        parsed = urlparse(url)
        path = unquote(parsed.path or "")
        if path:
            name = os.path.basename(path)
    except Exception:
        name = ""
    if not name:
        name = "audio.mp3"
    # Ensure extension looks like audio; default to .mp3 when missing.
    lower = name.lower()
    if not any(lower.endswith(ext) for ext in (".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus")):
        name = f"{name}.mp3"
    # Keep only allowed characters and enforce max length.
    name = ("".join(FILENAME_ALLOWED_PATTERN.findall(name))).strip() or "audio.mp3"
    if len(name) > FILENAME_MAX_LENGTH:
        name = name[:FILENAME_MAX_LENGTH].rstrip() or "audio.mp3"
    return name


def _consume_upload_body(upload_id: str) -> tuple[bytes, str]:
    """Pop upload by id, read file bytes, delete temp file. Returns (body, filename). Raises 404 if not found, 400 if empty."""
    entry = pop_upload(upload_id)
    if not entry:
        raise HTTPException(404, "Upload not found or already consumed")
    temp_path, filename = entry
    try:
        with open(temp_path, "rb") as f:
            body = f.read()
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            logger.debug("Cleanup failed (unlink)")
    if len(body) == 0:
        del body
        raise HTTPException(400, "Empty file")
    return (body, filename)


def _build_chunk_items(chunk_list: list[tuple[str, str]]) -> list[UploadChunkItem]:
    """Build list of UploadChunkItem from (path, filename) list and register each in upload_store. path not sent to client."""
    return [
        UploadChunkItem(path="", filename=n, upload_id=put_upload(p, n, os.path.getsize(p)))
        for p, n in chunk_list
    ]


def _record_failed_chunk(
    chunk_path: str,
    chunk_filename: str,
    cleanup_failed: bool,
    failed_chunk_ids: list[str],
    uid: str,
    failed_chunks_to_cleanup: list[tuple[str, str]],
) -> None:
    """Record a failed chunk: append to failed_chunk_ids; either queue for cleanup or put back in store."""
    failed_chunk_ids.append(uid)
    if cleanup_failed:
        failed_chunks_to_cleanup.append((chunk_path, chunk_filename))
    else:
        put_upload(chunk_path, chunk_filename, os.path.getsize(chunk_path))


@router.get("/config", response_model=UploadConfigResponse)
def get_upload_config() -> UploadConfigResponse:
    """Return upload limits and TTL so the frontend can validate and re-enable upload after expiry."""
    return UploadConfigResponse(
        max_upload_bytes=config.MAX_UPLOAD_BYTES,
        upload_ttl_seconds=config.UPLOAD_TTL_SECONDS,
    )


@router.post("/upload", response_model=UploadResponse)
async def upload(req: Request, audio: UploadFile = File(...)) -> UploadResponse:
    """Upload an audio file (step 1). Saves file only; call POST /api/split with upload_id to split. Max size MAX_UPLOAD_BYTES (e.g. 300MB)."""
    if not allowed_audio_content_type(audio.content_type):
        raise HTTPException(400, "Invalid file type: audio only")

    cl_raw = req.headers.get("content-length")
    if cl_raw is not None:
        try:
            cl = int(cl_raw)
            if cl > config.MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_BYTES:
                _reject_413_size(config.MAX_UPLOAD_BYTES, "Request body")
        except ValueError:
            pass

    async with upload_semaphore:
        try:
            body = await read_file_with_size_cap(
                audio, config.MAX_UPLOAD_BYTES, lambda: _reject_413_size(config.MAX_UPLOAD_BYTES, "Request body")
            )
            if len(body) == 0:
                del body
                raise HTTPException(400, "Empty file")

            name = _sanitize_filename(audio)
            try:
                upload_id = save_upload_bytes(body, name)
            except StoreFullError:
                del body
                raise HTTPException(503, "Upload store full. Try again later.")
            del body
            # Return immediately so client gets upload_id fast; duration via GET /upload/{id}/duration.
            # This avoids orphan temp files when user cancels before response (no reliance on http.disconnect).
            return UploadResponse(upload_id=upload_id, duration_seconds=None)
        finally:
            await audio.close()


@router.get("/upload/{upload_id}/duration", response_model=UploadDurationResponse)
async def get_upload_duration(upload_id: str) -> UploadDurationResponse:
    """Return duration of the uploaded file in seconds (for computing split segment count)."""
    entry = get_upload(upload_id)
    if not entry:
        raise HTTPException(404, "Upload not found or already consumed")
    temp_path, filename = entry
    if not os.path.exists(temp_path):
        pop_upload(upload_id)
        raise HTTPException(404, "Upload not found or already consumed")
    try:
        duration_seconds = audio_split_svc.get_audio_duration_seconds(temp_path, filename)
        return UploadDurationResponse(duration_seconds=duration_seconds)
    except ValueError:
        raise HTTPException(400, "Failed to get audio duration or invalid file")


@router.delete("/upload/{upload_id}", status_code=204)
async def delete_upload(upload_id: str) -> None:
    """Remove an uploaded file by upload_id and delete the temp file. Idempotent: 204 even when not found or already consumed. If the file was in an audio_split_* dir and the dir becomes empty, the dir is removed."""
    entry = pop_upload(upload_id)
    if not entry:
        return  # 204 No Content (idempotent: already gone or consumed)
    temp_path, _ = entry
    try:
        os.unlink(temp_path)
    except OSError:
        logger.debug("Cleanup failed (unlink)")
    try:
        parent = os.path.dirname(temp_path)
        if os.path.basename(parent).startswith("audio_split_") and os.path.isdir(parent):
            if not os.listdir(parent):
                os.rmdir(parent)
    except OSError:
        logger.debug("Cleanup failed (rmdir)")


@router.post("/split", response_model=SplitResponse)
async def split(req: SplitRequest) -> SplitResponse:
    """Split an uploaded file into chunks by upload_id. Removes the stored upload after split."""
    body, filename = _consume_upload_body(req.upload_id)
    try:
        temp_dir, chunk_list = audio_split_svc.split_audio_into_chunks(
            body, filename, segment_minutes=req.segment_minutes
        )
    except ValueError:
        raise HTTPException(400, "Split failed: invalid audio or unsupported format")
    finally:
        del body
    try:
        chunks_with_ids = _build_chunk_items(chunk_list)
    except StoreFullError:
        raise HTTPException(503, "Upload store full. Try again later.")
    return SplitResponse(temp_dir="", chunks=chunks_with_ids)


def _split_with_progress(
    body: bytes,
    filename: str,
    segment_minutes: int,
    progress_queue: queue.Queue,
    cancel_event: threading.Event,
) -> None:
    """Run split in a thread; put progress and result onto progress_queue. Stops and cleans up if cancel_event is set."""
    try:
        def progress_cb(current: int, total: int) -> None:
            if cancel_event.is_set():
                raise SplitCancelled()
            progress_queue.put({"type": "progress", "current": current, "total": total})

        temp_dir, chunk_list = audio_split_svc.split_audio_into_chunks(
            body, filename, segment_minutes=segment_minutes, progress_callback=progress_cb
        )
        chunks_with_ids = _build_chunk_items(chunk_list)
        progress_queue.put({
            "type": "result",
            "temp_dir": "",
            "chunks": [c.model_dump() for c in chunks_with_ids],
        })
    except SplitCancelled:
        # temp_dir and any partial chunks are already removed by split_audio_into_chunks (rmtree on exception).
        progress_queue.put({"type": "cancelled"})
    except Exception:
        logger.error("Split stream failed")
        logger.debug("Split stream exception", exc_info=True)
        progress_queue.put({"type": "error", "detail": "Split failed"})


async def _wait_disconnect(request: Request) -> None:
    """Return when client disconnects (http.disconnect)."""
    while True:
        message = await request.receive()
        if message.get("type") == "http.disconnect":
            return


# When a split/stream is running, its cancel_event is stored here so POST /api/split/cancel can set it.
_current_split_cancel_event: threading.Event | None = None
_split_cancel_lock = threading.Lock()


def _clear_current_split_cancel_event() -> None:
    with _split_cancel_lock:
        global _current_split_cancel_event
        _current_split_cancel_event = None


@router.post("/split/cancel", status_code=204)
async def split_cancel() -> None:
    """Signal the currently running split/stream to stop. Idempotent: 204 even when no split is running."""
    with _split_cancel_lock:
        ev = _current_split_cancel_event
    if ev is not None:
        ev.set()


@router.post("/split/stream")
async def split_stream(req: SplitRequest, request: Request):
    """Split with NDJSON stream: progress events then result. Cancels and cleans up temp files if client disconnects or POST /api/split/cancel is called."""
    body, filename = _consume_upload_body(req.upload_id)

    progress_queue: queue.Queue = queue.Queue()
    cancel_event = threading.Event()
    with _split_cancel_lock:
        global _current_split_cancel_event
        _current_split_cancel_event = cancel_event

    async def ndjson_stream():
        executor_fut: asyncio.Future | None = None
        try:
            loop = asyncio.get_running_loop()
            body_ref = body  # avoid UnboundLocalError (del body below makes body local otherwise)
            executor_fut = loop.run_in_executor(
                None,
                _split_with_progress,
                body_ref,
                filename,
                req.segment_minutes,
                progress_queue,
                cancel_event,
            )
            del body_ref
            disconnect_task = asyncio.create_task(_wait_disconnect(request))
            received_real_progress = False
            while True:
                get_task = loop.run_in_executor(None, progress_queue.get)
                done, pending = await asyncio.wait(
                    [get_task, disconnect_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if disconnect_task in done:
                    (get_task,) = pending
                    item = await get_task
                    yield json.dumps(item, ensure_ascii=False) + "\n"
                    if received_real_progress:
                        cancel_event.set()
                    break
                if get_task in done:
                    item = get_task.result()
                    if item.get("type") == "progress" and item.get("current", 0) >= 1:
                        received_real_progress = True
                    disconnect_task.cancel()
                    try:
                        await disconnect_task
                    except asyncio.CancelledError:
                        pass
                    disconnect_task = asyncio.create_task(_wait_disconnect(request))
                    yield json.dumps(item, ensure_ascii=False) + "\n"
                    if item.get("type") == "progress" and item.get("current", 0) >= 1:
                        await asyncio.sleep(PROGRESS_YIELD_DELAY_SEC)
                    if item.get("type") in ("result", "error", "cancelled"):
                        disconnect_task.cancel()
                        try:
                            await disconnect_task
                        except asyncio.CancelledError:
                            pass
                        break
        finally:
            _clear_current_split_cancel_event()
            if executor_fut is not None:
                try:
                    await executor_fut
                except asyncio.CancelledError:
                    pass
                except Exception:
                    logger.error("Split stream executor failed")
                    logger.debug("Split stream executor exception", exc_info=True)

    return StreamingResponse(
        ndjson_stream(),
        media_type="application/x-ndjson",
    )


def _parse_language(raw: str | None) -> str:
    """Return 'auto', 'en', or 'zh' for Whisper. Default 'auto'."""
    if not raw or not raw.strip():
        return "auto"
    v = raw.strip().lower()
    if v in ("en", "zh"):
        return v
    return "auto"


def _parse_clean_up(raw: str | None) -> bool:
    """Return True for 'true'/'yes'/'1', else False."""
    if not raw:
        return True
    return raw.strip().lower() in ("true", "yes", "1")


def _transcribe_upload_ids_impl(
    ids: list[str],
    cleanup_failed: bool,
    language: str,
    clean_up: bool,
    progress_callback: Callable[[int, int, str], None] | None = None,
    engine: str | None = None,
) -> tuple[list[str], list[str], list[int], set[Path], list[tuple[str, str]]]:
    """Shared transcribe loop for upload_ids. Optionally call progress_callback(current_1based, total, filename) before each chunk. Returns (segments, failed_chunk_ids, failed_chunk_indices, parent_dirs, failed_chunks_to_cleanup). May raise StoreFullError."""
    segments: list[str] = [""] * len(ids)
    failed_chunk_ids: list[str] = []
    failed_chunk_indices: list[int] = []
    parent_dirs: set[Path] = set()
    failed_chunks_to_cleanup: list[tuple[str, str]] = []
    for i, uid in enumerate(ids):
        entry = pop_upload(uid)
        if not entry:
            failed_chunk_ids.append(uid)
            failed_chunk_indices.append(i)
            continue
        chunk_path, chunk_filename = entry
        parent_dirs.add(Path(chunk_path).parent)
        if progress_callback is not None:
            progress_callback(i + 1, len(ids), chunk_filename)
        try:
            chunk_bytes = Path(chunk_path).read_bytes()
        except Exception:
            logger.error("Failed to read chunk file")
            logger.debug("Read chunk file exception", exc_info=True)
            _record_failed_chunk(
                chunk_path, chunk_filename, cleanup_failed,
                failed_chunk_ids, uid, failed_chunks_to_cleanup,
            )
            failed_chunk_indices.append(i)
            continue
        if len(chunk_bytes) == 0:
            _record_failed_chunk(
                chunk_path, chunk_filename, cleanup_failed,
                failed_chunk_ids, uid, failed_chunks_to_cleanup,
            )
            failed_chunk_indices.append(i)
            try:
                os.unlink(chunk_path)
            except OSError:
                logger.debug("Cleanup failed (unlink)")
            continue
        try:
            segment_text = transcribe_svc.transcribe_audio(
                chunk_bytes, chunk_filename, language=language, clean_up=clean_up, engine=engine
            )
            segments[i] = segment_text
            try:
                os.unlink(chunk_path)
            except OSError:
                logger.debug("Cleanup failed (unlink)")
        except ValueError:
            logger.error("Transcription failed (upload_ids)")
            logger.debug("Transcription upload_ids ValueError", exc_info=True)
            _record_failed_chunk(
                chunk_path, chunk_filename, cleanup_failed,
                failed_chunk_ids, uid, failed_chunks_to_cleanup,
            )
            failed_chunk_indices.append(i)
        except Exception:
            logger.error("Transcription failed (upload_ids)")
            logger.debug("Transcription upload_ids exception", exc_info=True)
            _record_failed_chunk(
                chunk_path, chunk_filename, cleanup_failed,
                failed_chunk_ids, uid, failed_chunks_to_cleanup,
            )
            failed_chunk_indices.append(i)
        finally:
            del chunk_bytes
    return (segments, failed_chunk_ids, failed_chunk_indices, parent_dirs, failed_chunks_to_cleanup)


def _cleanup_after_transcribe_impl(
    failed_chunks_to_cleanup: list[tuple[str, str]],
    parent_dirs: set[Path],
    failed_chunk_ids: list[str],
    cleanup_failed: bool,
) -> None:
    """Unlink failed chunk files and optionally rmtree parent dirs. Shared by sync and queue paths."""
    for chunk_path, _ in failed_chunks_to_cleanup:
        try:
            os.unlink(chunk_path)
        except OSError:
            logger.debug("Cleanup failed (unlink)")
    if not failed_chunk_ids or cleanup_failed:
        for d in parent_dirs:
            try:
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                logger.debug("Cleanup failed (rmtree)")


def _transcribe_upload_ids_sync(
    ids: list[str],
    cleanup_failed: bool,
    language: str,
    clean_up: bool,
    engine: str | None = None,
) -> tuple[list[str], list[str], list[int], set[Path], list[tuple[str, str]]]:
    """Run transcribe loop for upload_ids in a thread. Returns (segments, failed_chunk_ids, failed_chunk_indices, parent_dirs, failed_chunks_to_cleanup)."""
    return _transcribe_upload_ids_impl(ids, cleanup_failed, language, clean_up, progress_callback=None, engine=engine)


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    audio: list[UploadFile] | None = File(None),
    upload_ids: list[str] | None = Form(None),
    cleanup_failed: bool = Form(False),
    language: str | None = Form(None),
    clean_up: str | None = Form(None),
    display_name: str | None = Form(None),
    engine: str | None = Form(None),
) -> TranscribeResponse:
    """Transcribe to text: provide upload_ids (list of chunk upload_ids from split) or one or more audio files (multipart 'audio'). Exactly one of upload_ids / audio required. Optional: language (auto/en/zh), clean_up (true/false), display_name (original filename for history), engine (api | faster_whisper). If cleanup_failed=True, failed chunks are deleted (abandon retry); if False (default), failed chunks are kept for manual retry."""
    ids = [x.strip() for x in (upload_ids or []) if x and x.strip()]
    has_upload_ids = len(ids) > 0
    has_files = audio and len(audio) > 0

    if has_upload_ids and has_files:
        raise HTTPException(400, "Provide either audio file(s) or upload_ids, not both")
    if not has_upload_ids and not has_files:
        raise HTTPException(400, "Provide either audio file(s) or upload_ids")
    if has_upload_ids and len(ids) > config.TRANSCRIBE_MAX_BATCH_SIZE:
        raise HTTPException(
            400,
            f"Too many chunks (max {config.TRANSCRIBE_MAX_BATCH_SIZE}). Split into smaller batches.",
        )

    lang = _parse_language(language)
    do_clean_up = _parse_clean_up(clean_up)
    texts: list[str] = []
    failed_chunk_ids: list[str] = []
    failed_chunk_indices: list[int] = []
    segments: list[str] = []

    if has_upload_ids:
        loop = asyncio.get_running_loop()
        try:
            (
                segments,
                failed_chunk_ids,
                failed_chunk_indices,
                parent_dirs,
                failed_chunks_to_cleanup,
            ) = await loop.run_in_executor(
                None,
                _transcribe_upload_ids_sync,
                ids,
                cleanup_failed,
                lang,
                do_clean_up,
                (engine.strip() if engine and engine.strip() else None),
            )
        except StoreFullError:
            raise HTTPException(503, "Upload store full. Try again later.")
        _cleanup_after_transcribe_impl(
            failed_chunks_to_cleanup, parent_dirs, failed_chunk_ids, cleanup_failed
        )
    else:
        # Direct audio upload: transcribe one or more files in executor threads.
        loop = asyncio.get_running_loop()

        engine_param = engine.strip() if engine and engine.strip() else None

        async def transcribe_one_file(f: UploadFile) -> str:
            if not allowed_audio_content_type(f.content_type):
                raise HTTPException(400, "Invalid file type: audio only")
            body = await read_file_with_size_cap(
                f, config.MAX_TRANSCRIBE_BYTES, lambda: _reject_413_size(config.MAX_TRANSCRIBE_BYTES, "File")
            )
            if len(body) == 0:
                del body
                raise HTTPException(400, "Empty file")
            name = _sanitize_filename(f)
            try:
                return await loop.run_in_executor(
                    None,
                    lambda b=body, n=name, e=engine_param: transcribe_svc.transcribe_audio(
                        b, n, language=lang, clean_up=do_clean_up, engine=e
                    ),
                )
            except ValueError:
                raise HTTPException(503, "Transcription service unavailable")
            except Exception:
                logger.error("Transcription failed (audio)")
                logger.debug("Transcription audio exception", exc_info=True)
                raise HTTPException(502, "Transcription request failed")
            finally:
                del body

        texts = await asyncio.gather(*[transcribe_one_file(f) for f in audio])

    if has_upload_ids:
        result_text = "\n\n".join(segments) if segments else ""
        disp = (display_name or "").strip() if display_name else ""
        if not disp and ids:
            first_info = get_upload(ids[0])
            if first_info:
                disp = _chunk_filename_to_original(first_info[1])
        transcription_history.save_transcription(
            disp,
            result_text,
            {
                "source": "upload_ids",
                "upload_ids": ids,
                "language": lang,
                "clean_up": do_clean_up,
                "failed_chunk_ids": failed_chunk_ids or None,
                "failed_chunk_indices": failed_chunk_indices or None,
                # Persist per-chunk text segments for future segmented translation.
                "segments": segments or None,
            },
        )
        return TranscribeResponse(
            text=result_text,
            failed_chunk_ids=failed_chunk_ids if failed_chunk_ids else None,
            text_segments=segments,
            failed_chunk_indices=failed_chunk_indices if failed_chunk_indices else None,
        )

    result_text = "\n\n".join(texts) if texts else ""
    disp = (display_name or "").strip() if display_name else ""
    if not disp and audio and len(audio) > 0:
        disp = _sanitize_filename(audio[0])
    transcription_history.save_transcription(
        disp,
        result_text,
        {
            "source": "audio",
            "file_count": len(audio or []),
            "language": lang,
            "clean_up": do_clean_up,
        },
    )
    return TranscribeResponse(
        text=result_text,
        failed_chunk_ids=failed_chunk_ids if failed_chunk_ids else None,
    )


def _transcribe_upload_ids_to_queue(
    ids: list[str],
    cleanup_failed: bool,
    progress_queue: queue.Queue,
    language: str = "auto",
    clean_up: bool = True,
    display_name_from_request: str | None = None,
    engine: str | None = None,
) -> None:
    """Run transcribe loop for upload_ids; put progress before each chunk and result at end. Uses _transcribe_upload_ids_impl."""
    def on_progress(current: int, total: int, filename: str) -> None:
        progress_queue.put({"type": "progress", "current": current, "total": total, "filename": filename})

    try:
        segments, failed_chunk_ids, failed_chunk_indices, parent_dirs, failed_chunks_to_cleanup = _transcribe_upload_ids_impl(
            ids, cleanup_failed, language, clean_up, progress_callback=on_progress, engine=engine
        )
    except StoreFullError:
        progress_queue.put({"type": "error", "detail": "Upload store full. Try again later."})
        return
    except Exception:
        logger.error("Transcription failed (stream)")
        logger.debug("Transcription stream exception", exc_info=True)
        progress_queue.put({"type": "error", "detail": "Transcription failed."})
        return
    _cleanup_after_transcribe_impl(
        failed_chunks_to_cleanup, parent_dirs, failed_chunk_ids, cleanup_failed
    )
    result_text = "\n\n".join(segments) if segments else ""
    disp = (display_name_from_request or "").strip() if display_name_from_request else ""
    if not disp and ids:
        first_info = get_upload(ids[0])
        if first_info:
            disp = _chunk_filename_to_original(first_info[1])
    transcription_history.save_transcription(
        disp,
        result_text,
        {
            "source": "upload_ids_stream",
            "upload_ids": ids,
            "language": language,
            "clean_up": clean_up,
            "failed_chunk_ids": failed_chunk_ids or None,
            "failed_chunk_indices": failed_chunk_indices or None,
            # Persist per-chunk text segments for future segmented translation.
            "segments": segments or None,
        },
    )
    progress_queue.put({
        "type": "result",
        "text": result_text,
        "failed_chunk_ids": failed_chunk_ids if failed_chunk_ids else None,
        "text_segments": segments,
        "failed_chunk_indices": failed_chunk_indices if failed_chunk_indices else None,
    })


@router.post("/transcribe/stream")
async def transcribe_stream(
    upload_ids: list[str] | None = Form(None),
    cleanup_failed: bool = Form(False),
    language: str | None = Form(None),
    clean_up: str | None = Form(None),
    display_name: str | None = Form(None),
    engine: str | None = Form(None),
):
    """Stream transcribe progress (NDJSON): progress events with current/total/filename, then result. upload_ids only. Optional: language (auto/en/zh), clean_up (true/false), display_name (original filename for history), engine (api | faster_whisper)."""
    ids = [x.strip() for x in (upload_ids or []) if x and x.strip()]
    if not ids:
        raise HTTPException(400, "Provide upload_ids")
    if len(ids) > config.TRANSCRIBE_MAX_BATCH_SIZE:
        raise HTTPException(
            400,
            f"Too many chunks (max {config.TRANSCRIBE_MAX_BATCH_SIZE}). Split into smaller batches.",
        )
    progress_queue: queue.Queue = queue.Queue()
    lang = _parse_language(language)
    do_clean_up = _parse_clean_up(clean_up)
    disp = (display_name or "").strip() or None
    engine_param = engine.strip() if engine and engine.strip() else None

    async def ndjson_stream():
        loop = asyncio.get_running_loop()
        run = loop.run_in_executor(
            None,
            _transcribe_upload_ids_to_queue,
            ids,
            cleanup_failed,
            progress_queue,
            lang,
            do_clean_up,
            disp,
            engine_param,
        )
        try:
            while True:
                item = await loop.run_in_executor(None, progress_queue.get)
                yield json.dumps(item, ensure_ascii=False) + "\n"
                if item.get("type") in ("result", "error"):
                    break
        finally:
            try:
                await run
            except Exception:
                logger.debug("Transcribe stream executor finished with exception", exc_info=True)

    return StreamingResponse(ndjson_stream(), media_type="application/x-ndjson")


# --- Transcription history (list / get / delete) ---

_LIST_PAGE_SIZE_MAX = 100


@router.get("/transcriptions", response_model=list[TranscriptionListItem])
async def list_transcriptions(limit: int = 50, offset: int = 0) -> list[TranscriptionListItem]:
    """Return recent transcriptions (metadata only). Sorted by created_at desc. Pagination: limit (max 100), offset."""
    capped = min(max(1, limit), _LIST_PAGE_SIZE_MAX)
    off = max(0, offset)
    items = transcription_history.list_transcriptions(limit=capped, offset=off)
    return [TranscriptionListItem(**x) for x in items]


@router.get("/transcriptions/{transcription_id}", response_model=TranscriptionDetail)
async def get_transcription(transcription_id: str) -> TranscriptionDetail:
    """Return one transcription by id (full text). 404 if not found or invalid id."""
    data = transcription_history.get_transcription(transcription_id)
    if data is None:
        raise HTTPException(404, "Not found")
    return TranscriptionDetail(**data)


@router.delete("/transcriptions/{transcription_id}", status_code=204)
async def delete_transcription(transcription_id: str) -> None:
    """Delete one transcription by id. 404 if not found or invalid id."""
    if not transcription_history.delete_transcription(transcription_id):
        raise HTTPException(404, "Not found")


# --- Translation history (save / list / get / delete) ---


@router.post("/translations", response_model=TranslationSaveResponse)
async def save_translation(req: TranslationSaveRequest) -> TranslationSaveResponse:
    """Save a translation to history. Returns id and metadata (no full text)."""
    translation_id = translation_history.save_translation(req.display_name, req.text)
    data = translation_history.get_translation(translation_id)
    if not data:
        return TranslationSaveResponse(id=translation_id, created_at=None, display_name=req.display_name)
    return TranslationSaveResponse(id=data["id"], created_at=data.get("created_at"), display_name=data["display_name"])


@router.get("/translations", response_model=list[TranslationListItem])
async def list_translations(limit: int = 50, offset: int = 0) -> list[TranslationListItem]:
    """Return recent translations (metadata only). Sorted by created_at desc. Pagination: limit (max 100), offset."""
    capped = min(max(1, limit), _LIST_PAGE_SIZE_MAX)
    off = max(0, offset)
    items = translation_history.list_translations(limit=capped, offset=off)
    return [TranslationListItem(**x) for x in items]


@router.get("/translations/{translation_id}", response_model=TranslationDetail)
async def get_translation(translation_id: str) -> TranslationDetail:
    """Return one translation by id (full text). 404 if not found or invalid id."""
    data = translation_history.get_translation(translation_id)
    if data is None:
        raise HTTPException(404, "Not found")
    return TranslationDetail(**data)


@router.delete("/translations/{translation_id}", status_code=204)
async def delete_translation(translation_id: str) -> None:
    """Delete one translation by id. 404 if not found or invalid id."""
    if not translation_history.delete_translation(translation_id):
        raise HTTPException(404, "Not found")


# --- Summary history (save / list / get / delete) ---


@router.post("/summaries", response_model=SummarySaveResponse)
async def save_summary(req: SummarySaveRequest) -> SummarySaveResponse:
    """Save a summary to history. Returns id and metadata (no full text)."""
    summary_id = summary_history.save_summary(req.display_name, req.text)
    data = summary_history.get_summary(summary_id)
    if not data:
        return SummarySaveResponse(id=summary_id, created_at=None, display_name=req.display_name)
    return SummarySaveResponse(id=data["id"], created_at=data.get("created_at"), display_name=data["display_name"])


@router.get("/summaries", response_model=list[SummaryListItem])
async def list_summaries(limit: int = 50, offset: int = 0) -> list[SummaryListItem]:
    """Return recent summaries (metadata only). Sorted by created_at desc. Pagination: limit (max 100), offset."""
    capped = min(max(1, limit), _LIST_PAGE_SIZE_MAX)
    off = max(0, offset)
    items = summary_history.list_summaries(limit=capped, offset=off)
    return [SummaryListItem(**x) for x in items]


@router.get("/summaries/{summary_id}", response_model=SummaryDetail)
async def get_summary(summary_id: str) -> SummaryDetail:
    """Return one summary by id (full text). 404 if not found or invalid id."""
    data = summary_history.get_summary(summary_id)
    if data is None:
        raise HTTPException(404, "Not found")
    return SummaryDetail(**data)


@router.delete("/summaries/{summary_id}", status_code=204)
async def delete_summary(summary_id: str) -> None:
    """Delete one summary by id. 404 if not found or invalid id."""
    if not summary_history.delete_summary(summary_id):
        raise HTTPException(404, "Not found")


# --- Restructured articles history (save / list / get / delete) ---


@router.post("/articles", response_model=ArticleSaveResponse)
async def save_article(req: ArticleSaveRequest) -> ArticleSaveResponse:
    """Save a restructured article to history. Returns id and metadata (no full text)."""
    article_id = article_history.save_article(req.display_name, req.text)
    data = article_history.get_article(article_id)
    if not data:
        return ArticleSaveResponse(id=article_id, created_at=None, display_name=req.display_name)
    return ArticleSaveResponse(id=data["id"], created_at=data.get("created_at"), display_name=data["display_name"])


@router.get("/articles", response_model=list[ArticleListItem])
async def list_articles(limit: int = 50, offset: int = 0) -> list[ArticleListItem]:
    """Return recent restructured articles (metadata only). Sorted by created_at desc. Pagination: limit (max 100), offset."""
    capped = min(max(1, limit), _LIST_PAGE_SIZE_MAX)
    off = max(0, offset)
    items = article_history.list_articles(limit=capped, offset=off)
    return [ArticleListItem(**x) for x in items]


@router.get("/articles/{article_id}", response_model=ArticleDetail)
async def get_article(article_id: str) -> ArticleDetail:
    """Return one restructured article by id (full text). 404 if not found or invalid id."""
    data = article_history.get_article(article_id)
    if data is None:
        raise HTTPException(404, "Not found")
    return ArticleDetail(**data)


@router.delete("/articles/{article_id}", status_code=204)
async def delete_article(article_id: str) -> None:
    """Delete one restructured article by id. 404 if not found or invalid id."""
    if not article_history.delete_article(article_id):
        raise HTTPException(404, "Not found")


@router.post("/articles/{article_id}/notion", response_model=ArticleNotionExportResponse)
async def export_article_to_notion(
    article_id: str,
    body: ArticleNotionExportRequest | None = None,
) -> ArticleNotionExportResponse:
    """Create a Notion page for the given article id with a 2-column layout."""
    data = article_history.get_article(article_id)
    if data is None:
        raise HTTPException(404, "Not found")
    try:
        result = notion_articles_svc.export_article_to_notion(
            display_name=data["display_name"],
            text=data.get("text") or "",
            database=(body.database if body else None),
        )
    except notion_articles_svc.NotionConfigError as e:
        logger.warning("Notion integration not configured: %s", e)
        raise HTTPException(503, "Notion integration not configured")
    except notion_articles_svc.NotionApiError as e:
        logger.warning("Notion API error: %s", e)
        raise HTTPException(502, "Notion export failed")
    except Exception:
        logger.error("Notion export failed")
        raise HTTPException(502, "Notion export failed")

    notion_url = result.get("url")
    notion_page_id = result.get("page_id")
    article_history.update_article_notion(article_id, notion_url, notion_page_id)
    return ArticleNotionExportResponse(notion_page_id=notion_page_id, notion_url=notion_url)


@router.post("/translate", response_model=TranslateResponse)
async def translate(req: TranslateRequest) -> TranslateResponse:
    """Translate text to target language. When segments are provided, translates each and joins (avoids long single-request timeouts)."""
    if not TARGET_LANG_PATTERN.match(req.target_lang):
        raise HTTPException(400, "Invalid target_lang")

    try:
        if req.segments and len(req.segments) > 0:
            text = translate_svc.translate_text_segments(req.segments, req.target_lang, engine=req.engine)
        else:
            text = translate_svc.translate_text((req.text or "").strip(), req.target_lang, engine=req.engine)
    except ValueError as e:
        logger.warning("Translation configuration/local error: %s", e)
        raise HTTPException(503, "Translation service unavailable")
    except Exception as e:
        logger.exception("Translation request failed: %s", e)
        raise HTTPException(502, "Translation request failed")

    return TranslateResponse(text=text)


@router.post("/summarize", response_model=SummarizeResponse)
async def summarize(req: SummarizeRequest) -> SummarizeResponse:
    """Summarize text using remote API (OpenAI) or local Qwen, depending on engine."""
    engine = (req.engine or "api").strip().lower()
    try:
        if engine == "local":
            text = summarize_qwen_svc.summarize_qwen(req.text)
        else:
            text = summarize_svc.summarize_text(req.text)
    except ValueError as e:
        logger.warning("Summary configuration/local error: %s", e)
        raise HTTPException(503, "Summary service unavailable")
    except Exception as e:
        logger.exception("Summary request failed: %s", e)
        raise HTTPException(502, "Summary request failed")

    return SummarizeResponse(text=text)


_APPLE_PODCAST_ID_RE = re.compile(r"podcasts\.apple\.com[/\w]*/id(\d+)", re.IGNORECASE)


@router.get("/podcast/rss")
async def get_podcast_rss(link: str) -> dict:
    """Resolve Apple Podcasts link to RSS feed URL via iTunes Lookup API."""
    link = (link or "").strip()
    if not link:
        raise HTTPException(400, "link is required")
    match = _APPLE_PODCAST_ID_RE.search(link)
    if not match:
        raise HTTPException(400, "Invalid Apple Podcasts link; expected URL containing podcasts.apple.com/.../id<number>")
    podcast_id = match.group(1)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                "https://itunes.apple.com/lookup",
                params={"id": podcast_id, "country": "US", "media": "podcast"},
            )
        r.raise_for_status()
        data = r.json()
    except httpx.HTTPError as e:
        logger.warning("iTunes lookup failed for id=%s: %s", podcast_id, e)
        raise HTTPException(502, "Could not fetch podcast info from Apple")
    results = data.get("results") or []
    if not results:
        raise HTTPException(404, "Podcast not found")
    feed_url = results[0].get("feedUrl")
    if not feed_url:
        raise HTTPException(404, "RSS feed URL not available for this podcast")
    return {"feedUrl": feed_url}


def _parse_itunes_duration(s: str) -> int | None:
    """Parse itunes:duration string to seconds. Supports '123', '45:30', '1:23:45'. Returns None if invalid."""
    s = (s or "").strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        if len(parts) == 1:
            return int(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 4:
            return int(parts[0]) * 86400 + int(parts[1]) * 3600 + int(parts[2]) * 60 + int(parts[3])
    except ValueError:
        pass
    return None


def _parse_rss_audio_enclosures(xml_text: str) -> list[dict]:
    """Parse RSS/Atom XML and return list of {url, title?, pub_date?, duration_seconds?} for all enclosures."""
    out: list[dict] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out

    def local_tag(elem: ET.Element) -> str:
        tag = elem.tag
        if isinstance(tag, str) and "}" in tag:
            return tag.split("}", 1)[1]
        return tag

    def text_of(parent: ET.Element, name: str) -> str | None:
        for c in parent:
            if local_tag(c) == name and c.text is not None:
                return (c.text or "").strip() or None
        return None

    # RSS: rss > channel > item; Atom: feed > entry
    channel_or_feed = None
    item_tag = "item"
    if local_tag(root) == "rss":
        for c in root:
            if local_tag(c) == "channel":
                channel_or_feed = c
                break
    elif local_tag(root) == "feed":
        channel_or_feed = root
        item_tag = "entry"

    if channel_or_feed is None:
        return out

    for elem in channel_or_feed:
        if local_tag(elem) != item_tag:
            continue
        title = text_of(elem, "title")
        pub_date = text_of(elem, "pubDate") or text_of(elem, "published") or text_of(elem, "updated")
        duration_raw = text_of(elem, "duration")
        duration_seconds = _parse_itunes_duration(duration_raw) if duration_raw else None
        for c in elem:
            if local_tag(c) != "enclosure":
                continue
            url = c.get("url") or c.get("href")
            if not url or not url.strip():
                continue
            length_raw = c.get("length")
            length_bytes: int | None = None
            if length_raw is not None and str(length_raw).strip():
                try:
                    n = int(length_raw)
                    if n > 0:
                        length_bytes = n
                except ValueError:
                    pass
            out.append({
                "url": url.strip(),
                "title": title,
                "pub_date": pub_date,
                "duration_seconds": duration_seconds,
                "length_bytes": length_bytes,
            })
    return out


@router.get("/podcast/feed/audio-links", response_model=list[PodcastFeedAudioItem])
async def get_podcast_feed_audio_links(feed_url: str) -> list[PodcastFeedAudioItem]:
    """Fetch RSS feed and return all audio enclosure URLs (for Preview)."""
    feed_url = (feed_url or "").strip()
    if not feed_url:
        raise HTTPException(400, "feed_url is required")
    if not feed_url.startswith("http://") and not feed_url.startswith("https://"):
        raise HTTPException(400, "feed_url must be http or https")
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            r = await client.get(feed_url)
        r.raise_for_status()
        xml_text = r.text
    except httpx.HTTPError as e:
        logger.warning("Failed to fetch feed %s: %s", feed_url[:80], e)
        raise HTTPException(502, "Could not fetch RSS feed")
    items = _parse_rss_audio_enclosures(xml_text)
    return [PodcastFeedAudioItem(**x) for x in items]


@router.get("/podcast/download")
async def download_podcast_audio(url: str, filename: str | None = None) -> StreamingResponse:
    """Proxy download for podcast episode audio.

    Streams from the remote URL to the client so the browser starts receiving data
    immediately instead of waiting for the backend to download the entire file first.
    """
    url = (url or "").strip()
    if not url:
        raise HTTPException(400, "url is required")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "url must be http or https")

    safe_filename: str
    if filename:
        name = filename.strip() or "audio.mp3"
        lower = name.lower()
        if not any(lower.endswith(ext) for ext in (".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus")):
            name = f"{name}.mp3"
        name = ("".join(FILENAME_ALLOWED_PATTERN.findall(name))).strip() or "audio.mp3"
        if len(name) > FILENAME_MAX_LENGTH:
            name = name[:FILENAME_MAX_LENGTH].rstrip() or "audio.mp3"
        safe_filename = name
    else:
        safe_filename = _sanitize_download_filename_from_url(url)

    # Optional HEAD to get Content-Type; if HEAD fails (e.g. 405), we still stream with GET
    content_type = "application/octet-stream"
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            head_r = await client.head(url)
            if head_r.status_code < 400 and head_r.headers.get("content-type"):
                content_type = head_r.headers.get("content-type", "").split(";")[0].strip() or content_type
    except Exception:
        pass

    async def generate() -> AsyncIterator[bytes]:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            async with client.stream("GET", url) as r:
                r.raise_for_status()
                async for chunk in r.aiter_bytes():
                    yield chunk

    headers = {
        "Content-Disposition": f'attachment; filename="{safe_filename}"',
    }
    return StreamingResponse(generate(), media_type=content_type, headers=headers)


async def _stream_upload_from_url(
    url: str,
    safe_filename: str,
    expected_size: int | None,
) -> AsyncIterator[str]:
    """Yield NDJSON lines: progress (bytes, total) then done (upload_id) or error (message)."""
    PROGRESS_INTERVAL = 256 * 1024  # 256KB
    chunks: list[bytes] = []
    total = 0
    last_yielded = 0
    try:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            async with client.stream("GET", url) as r:
                r.raise_for_status()
                async for chunk in r.aiter_bytes():
                    total += len(chunk)
                    if total > config.MAX_UPLOAD_BYTES:
                        yield json.dumps({
                            "type": "error",
                            "message": f"Remote audio is too large (max {config.MAX_UPLOAD_BYTES // (1024 * 1024)}MB)",
                        }) + "\n"
                        return
                    chunks.append(chunk)
                    if total - last_yielded >= PROGRESS_INTERVAL:
                        yield json.dumps({"type": "progress", "bytes": total, "total": expected_size or 0}) + "\n"
                        last_yielded = total
        body_bytes = b"".join(chunks)
        if len(body_bytes) == 0:
            yield json.dumps({"type": "error", "message": "Empty file from URL"}) + "\n"
            return
        try:
            upload_id = save_upload_bytes(body_bytes, safe_filename)
        except StoreFullError:
            yield json.dumps({"type": "error", "message": "Upload store full. Try again later."}) + "\n"
            return
        yield json.dumps({"type": "done", "upload_id": upload_id, "duration_seconds": None}) + "\n"
    except httpx.HTTPStatusError as e:
        yield json.dumps({"type": "error", "message": str(e) or "HTTP error"}) + "\n"
    except Exception as e:
        yield json.dumps({"type": "error", "message": str(e)}) + "\n"


@router.post("/podcast/upload-from-url")
async def upload_podcast_from_url(body_req: UploadFromUrlRequest):
    """Fetch podcast episode audio from URL and store as upload (avoids CORS).
    If stream_progress=True, response is NDJSON stream (progress then done/error).
    Otherwise returns JSON { upload_id, duration_seconds }."""
    url = (body_req.url or "").strip()
    if not url:
        raise HTTPException(400, "url is required")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "url must be http or https")

    if body_req.filename and body_req.filename.strip():
        name = body_req.filename.strip()
        lower = name.lower()
        if not any(lower.endswith(ext) for ext in (".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus")):
            name = f"{name}.mp3"
        name = ("".join(FILENAME_ALLOWED_PATTERN.findall(name))).strip() or "audio.mp3"
        if len(name) > FILENAME_MAX_LENGTH:
            name = name[:FILENAME_MAX_LENGTH].rstrip() or "audio.mp3"
        safe_filename = name
    else:
        safe_filename = _sanitize_download_filename_from_url(url)

    expected_size = body_req.expected_size if (body_req.expected_size and body_req.expected_size > 0) else None

    if body_req.stream_progress:
        async def ndjson_stream() -> AsyncIterator[bytes]:
            async with upload_semaphore:
                async for line in _stream_upload_from_url(url, safe_filename, expected_size):
                    yield line.encode("utf-8")

        return StreamingResponse(ndjson_stream(), media_type="application/x-ndjson")

    async with upload_semaphore:
        chunks: list[bytes] = []
        total = 0
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            async with client.stream("GET", url) as r:
                r.raise_for_status()
                async for chunk in r.aiter_bytes():
                    total += len(chunk)
                    if total > config.MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            413,
                            f"Remote audio is too large (max {config.MAX_UPLOAD_BYTES // (1024 * 1024)}MB)",
                        )
                    chunks.append(chunk)
        body_bytes = b"".join(chunks)
        if len(body_bytes) == 0:
            raise HTTPException(400, "Empty file from URL")
        try:
            upload_id = save_upload_bytes(body_bytes, safe_filename)
        except StoreFullError:
            raise HTTPException(503, "Upload store full. Try again later.")
        return UploadResponse(upload_id=upload_id, duration_seconds=None)


# --- Podcast list (Get Information) persist ---


@router.get("/podcasts", response_model=list[PodcastListItem])
async def list_podcasts(limit: int = 100, offset: int = 0) -> list[PodcastListItem]:
    """List saved podcasts. Sorted by created_at desc."""
    capped = min(max(1, limit), _LIST_PAGE_SIZE_MAX)
    off = max(0, offset)
    items = podcast_history.list_podcasts(limit=capped, offset=off)
    return [PodcastListItem(**x) for x in items]


@router.post("/podcasts", response_model=PodcastSaveResponse)
async def save_podcast(req: PodcastSaveRequest) -> PodcastSaveResponse:
    """Create a new podcast (name + link). Called when user clicks Save."""
    podcast_id = podcast_history.save_podcast(req.name, req.link)
    data = podcast_history.get_podcast(podcast_id)
    if not data:
        return PodcastSaveResponse(id=podcast_id, created_at=None, name=req.name, link=req.link, rss=None)
    return PodcastSaveResponse(**data)


@router.put("/podcasts/{podcast_id}", response_model=PodcastSaveResponse)
async def update_podcast(podcast_id: str, req: PodcastUpdateRequest) -> PodcastSaveResponse:
    """Update podcast name and link (after Edit + Save)."""
    if not podcast_history.update_podcast(podcast_id, req.name, req.link):
        raise HTTPException(404, "Not found")
    data = podcast_history.get_podcast(podcast_id)
    if not data:
        raise HTTPException(404, "Not found")
    return PodcastSaveResponse(**data)


@router.patch("/podcasts/{podcast_id}")
async def update_podcast_rss(podcast_id: str, req: PodcastRssRequest) -> dict:
    """Update podcast rss (after RSS button). Returns updated podcast."""
    if not podcast_history.update_podcast_rss(podcast_id, req.rss):
        raise HTTPException(404, "Not found")
    data = podcast_history.get_podcast(podcast_id)
    if not data:
        raise HTTPException(404, "Not found")
    return data


@router.delete("/podcasts/{podcast_id}", status_code=204)
async def delete_podcast(podcast_id: str) -> None:
    """Delete a saved podcast."""
    if not podcast_history.delete_podcast(podcast_id):
        raise HTTPException(404, "Not found")
