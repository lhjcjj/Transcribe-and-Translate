"""Transcribe and translate endpoints."""
import asyncio
import json
import logging
import os
import queue
import re
import shutil
import threading
from pathlib import Path
from typing import Callable

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
from app.schemas.transcription_history import TranscriptionDetail, TranscriptionListItem
from app.api import transcription_history
from app.schemas.translate import TranslateRequest, TranslateResponse
from app.services import audio_split as audio_split_svc
from app.services import transcribe as transcribe_svc
from app.services import translate as translate_svc


class SplitCancelled(Exception):
    """Raised when client disconnects during split stream."""
    pass


router = APIRouter(prefix="/api", tags=["api"], dependencies=[Depends(require_api_key)])

_MULTIPART_OVERHEAD_BYTES = 1 * 1024 * 1024  # 1MB for Content-Length reject

# Delay (seconds) after each progress line (1/6..6/6) so client is more likely to receive lines one-by-one
PROGRESS_YIELD_DELAY_SEC = 0.2


def _upload_413_message() -> str:
    return f"Request body too large (max {config.MAX_UPLOAD_BYTES} bytes)"


def _transcribe_413_message() -> str:
    return f"File too large (max {config.MAX_TRANSCRIBE_BYTES} bytes)"


# Sanitize target_lang: alphanumeric, spaces, hyphens only (no injection)
TARGET_LANG_PATTERN = re.compile(r"^[a-zA-Z0-9\u4e00-\u9fff\s\-]{1,20}$")

# Filename: max length and allowed chars (alphanumeric, dot, underscore, hyphen, space, basic Unicode letters)
FILENAME_MAX_LENGTH = 200
FILENAME_ALLOWED_PATTERN = re.compile(r"[a-zA-Z0-9._\s\-\u4e00-\u9fff]+")


def _reject_413(message: str) -> None:
    """Raise HTTP 413 with the given message (caller never returns)."""
    raise HTTPException(413, message)


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
    """Return upload limits so the frontend can validate without duplicating backend config."""
    return UploadConfigResponse(max_upload_bytes=config.MAX_UPLOAD_BYTES)


@router.post("/upload", response_model=UploadResponse)
async def upload(req: Request, audio: UploadFile = File(...)) -> UploadResponse:
    """Upload an audio file (step 1). Saves file only; call POST /api/split with upload_id to split. Max size MAX_UPLOAD_BYTES (e.g. 100MB)."""
    if not allowed_audio_content_type(audio.content_type):
        raise HTTPException(400, "Invalid file type: audio only")

    cl_raw = req.headers.get("content-length")
    if cl_raw is not None:
        try:
            cl = int(cl_raw)
            if cl > config.MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_BYTES:
                _reject_413(_upload_413_message())
        except ValueError:
            pass

    async with upload_semaphore:
        try:
            body = await read_file_with_size_cap(
                audio, config.MAX_UPLOAD_BYTES, lambda: _reject_413(_upload_413_message())
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
    """Transcribe to text: provide upload_ids (list of chunk upload_ids from split) or one or more audio files (multipart 'audio'). Exactly one of upload_ids / audio required. Optional: language (auto/en/zh), clean_up (true/false), display_name (original filename for history), engine (openai | faster_whisper). If cleanup_failed=True, failed chunks are deleted (abandon retry); if False (default), failed chunks are kept for manual retry."""
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
                f, config.MAX_TRANSCRIBE_BYTES, lambda: _reject_413(_transcribe_413_message())
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
            result_text,
            {
                "source": "upload_ids",
                "upload_ids": ids,
                "language": lang,
                "clean_up": do_clean_up,
                "failed_chunk_ids": failed_chunk_ids or None,
                "failed_chunk_indices": failed_chunk_indices or None,
                "display_name": disp,
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
        result_text,
        {
            "source": "audio",
            "file_count": len(audio or []),
            "language": lang,
            "clean_up": do_clean_up,
            "display_name": disp,
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
        result_text,
        {
            "source": "upload_ids_stream",
            "upload_ids": ids,
            "language": language,
            "clean_up": clean_up,
            "failed_chunk_ids": failed_chunk_ids or None,
            "failed_chunk_indices": failed_chunk_indices or None,
            "display_name": disp,
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
    """Stream transcribe progress (NDJSON): progress events with current/total/filename, then result. upload_ids only. Optional: language (auto/en/zh), clean_up (true/false), display_name (original filename for history), engine (openai | faster_whisper)."""
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


@router.post("/translate", response_model=TranslateResponse)
async def translate(req: TranslateRequest) -> TranslateResponse:
    """Translate text to target language."""
    if not TARGET_LANG_PATTERN.match(req.target_lang):
        raise HTTPException(400, "Invalid target_lang")

    try:
        text = translate_svc.translate_text(req.text, req.target_lang)
    except ValueError:
        raise HTTPException(503, "Translation service unavailable")
    except Exception:
        logger.debug("Translation exception", exc_info=True)
        raise HTTPException(502, "Translation request failed")

    return TranslateResponse(text=text)
