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

logger = logging.getLogger(__name__)


class SplitCancelled(Exception):
    """Raised when client disconnects during split stream."""
    pass

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app import config
from app.api.deps import allowed_audio_content_type, read_file_with_size_cap
from app.schemas.upload import (
    SplitRequest,
    SplitResponse,
    UploadChunkItem,
    UploadDurationResponse,
    UploadResponse,
)
from app.api.upload_store import StoreFullError, get_upload, pop_upload, put_upload, save_upload_bytes
from app.schemas.transcribe import TranscribeResponse
from app.schemas.translate import TranslateRequest, TranslateResponse
from app.services import audio_split as audio_split_svc
from app.services import transcribe as transcribe_svc
from app.services import translate as translate_svc

router = APIRouter(prefix="/api", tags=["api"])

_MULTIPART_OVERHEAD_BYTES = 1 * 1024 * 1024  # 1MB for Content-Length reject

# Delay (seconds) after each progress line (1/6..6/6) so client is more likely to receive lines one-by-one
PROGRESS_YIELD_DELAY_SEC = 0.2


def _upload_413_message() -> str:
    return f"Request body too large (max {config.MAX_UPLOAD_BYTES} bytes)"


def _transcribe_413_message() -> str:
    return f"File too large (max {config.MAX_TRANSCRIBE_BYTES} bytes)"


# Sanitize target_lang: alphanumeric, spaces, hyphens only (no injection)
TARGET_LANG_PATTERN = re.compile(r"^[a-zA-Z0-9\u4e00-\u9fff\s\-]{1,20}$")


def _reject_413(message: str) -> None:
    """Raise HTTP 413 with the given message (caller never returns)."""
    raise HTTPException(413, message)


def _sanitize_filename(audio: UploadFile) -> str:
    name = audio.filename or "audio"
    if "/" in name or "\\" in name:
        name = name.replace("\\", "/").split("/")[-1]
    return name.strip() or "audio"


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
            pass
    if len(body) == 0:
        del body
        raise HTTPException(400, "Empty file")
    return (body, filename)


def _build_chunk_items(chunk_list: list[tuple[str, str]]) -> list[UploadChunkItem]:
    """Build list of UploadChunkItem from (path, filename) list and register each in upload_store."""
    return [
        UploadChunkItem(path=p, filename=n, upload_id=put_upload(p, n, os.path.getsize(p)))
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
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


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
        pass
    try:
        parent = os.path.dirname(temp_path)
        if os.path.basename(parent).startswith("audio_split_") and os.path.isdir(parent):
            if not os.listdir(parent):
                os.rmdir(parent)
    except OSError:
        pass


@router.post("/split", response_model=SplitResponse)
async def split(req: SplitRequest) -> SplitResponse:
    """Split an uploaded file into chunks by upload_id. Removes the stored upload after split."""
    body, filename = _consume_upload_body(req.upload_id)
    try:
        temp_dir, chunk_list = audio_split_svc.split_audio_into_chunks(
            body, filename, segment_minutes=req.segment_minutes
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    finally:
        del body
    try:
        chunks_with_ids = _build_chunk_items(chunk_list)
    except StoreFullError:
        raise HTTPException(503, "Upload store full. Try again later.")
    return SplitResponse(temp_dir=temp_dir, chunks=chunks_with_ids)


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
            "temp_dir": temp_dir,
            "chunks": [c.model_dump() for c in chunks_with_ids],
        })
    except SplitCancelled:
        # temp_dir and any partial chunks are already removed by split_audio_into_chunks (rmtree on exception).
        progress_queue.put({"type": "cancelled"})
    except Exception as e:
        progress_queue.put({"type": "error", "detail": str(e)})


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
        try:
            loop = asyncio.get_event_loop()
            body_ref = body  # avoid UnboundLocalError (del body below makes body local otherwise)
            executor = loop.run_in_executor(
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
                    print("[split/stream] put message:", item)
                    yield json.dumps(item, ensure_ascii=False) + "\n"
                    if received_real_progress:
                        cancel_event.set()
                    break
                if get_task in done:
                    item = get_task.result()
                    print("[split/stream] put message:", item)
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
                        break
        finally:
            _clear_current_split_cancel_event()

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


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    audio: list[UploadFile] | None = File(None),
    upload_ids: list[str] | None = Form(None),
    cleanup_failed: bool = Form(False),
    language: str | None = Form(None),
    clean_up: str | None = Form(None),
) -> TranscribeResponse:
    """Transcribe to text: provide upload_ids (list of chunk upload_ids from split) or one or more audio files (multipart 'audio'). Exactly one of upload_ids / audio required. Optional: language (auto/en/zh), clean_up (true/false). If cleanup_failed=True, failed chunks are deleted (abandon retry); if False (default), failed chunks are kept for manual retry."""
    ids = [x.strip() for x in (upload_ids or []) if x and x.strip()]
    has_upload_ids = len(ids) > 0
    has_files = audio and len(audio) > 0

    if has_upload_ids and has_files:
        raise HTTPException(400, "Provide either audio file(s) or upload_ids, not both")
    if not has_upload_ids and not has_files:
        raise HTTPException(400, "Provide either audio file(s) or upload_ids")

    lang = _parse_language(language)
    do_clean_up = _parse_clean_up(clean_up)
    texts: list[str] = []
    failed_chunk_ids: list[str] = []
    failed_chunk_indices: list[int] = []
    segments: list[str] = []

    if has_upload_ids:
        segments = [""] * len(ids)
        parent_dirs: set[Path] = set()
        successful_ids: set[str] = set()
        failed_chunks_to_cleanup: list[tuple[str, str]] = []  # (chunk_path, chunk_filename)
        try:
            for i, uid in enumerate(ids):
                entry = pop_upload(uid)
                if not entry:
                    failed_chunk_ids.append(uid)
                    failed_chunk_indices.append(i)
                    continue
                chunk_path, chunk_filename = entry
                parent_dirs.add(Path(chunk_path).parent)
                try:
                    chunk_bytes = Path(chunk_path).read_bytes()
                except Exception as e:
                    logger.exception("Failed to read chunk file: %s", e)
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
                        pass
                    continue
                try:
                    segment_text = transcribe_svc.transcribe_audio(
                        chunk_bytes, chunk_filename, language=lang, clean_up=do_clean_up
                    )
                    texts.append(segment_text)
                    segments[i] = segment_text
                    successful_ids.add(uid)
                    # Success: unlink file and don't put back in store
                    try:
                        os.unlink(chunk_path)
                    except OSError:
                        pass
                except ValueError as e:
                    logger.exception("Transcription failed (upload_ids): %s", e)
                    _record_failed_chunk(
                        chunk_path, chunk_filename, cleanup_failed,
                        failed_chunk_ids, uid, failed_chunks_to_cleanup,
                    )
                    failed_chunk_indices.append(i)
                except Exception as e:
                    logger.exception("Transcription failed (upload_ids): %s", e)
                    _record_failed_chunk(
                        chunk_path, chunk_filename, cleanup_failed,
                        failed_chunk_ids, uid, failed_chunks_to_cleanup,
                    )
                    failed_chunk_indices.append(i)
                finally:
                    del chunk_bytes
        except StoreFullError:
            raise HTTPException(503, "Upload store full. Try again later.")
        # Cleanup failed chunks if cleanup_failed=True
        for chunk_path, _ in failed_chunks_to_cleanup:
            try:
                os.unlink(chunk_path)
            except OSError:
                pass
        # Clean up parent dirs if all chunks succeeded or cleanup_failed=True
        if not failed_chunk_ids or cleanup_failed:
            for d in parent_dirs:
                try:
                    shutil.rmtree(d, ignore_errors=True)
                except OSError:
                    pass
    else:
        for f in audio:
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
                text = transcribe_svc.transcribe_audio(body, name, language=lang, clean_up=do_clean_up)
                texts.append(text)
            except ValueError as e:
                raise HTTPException(503, str(e)) from e
            except Exception as e:
                logger.exception("Transcription failed (audio): %s", e)
                raise HTTPException(502, "Transcription request failed") from e
            finally:
                del body

    if has_upload_ids:
        result_text = "\n\n".join(segments) if segments else ""
        return TranscribeResponse(
            text=result_text,
            failed_chunk_ids=failed_chunk_ids if failed_chunk_ids else None,
            text_segments=segments,
            failed_chunk_indices=failed_chunk_indices if failed_chunk_indices else None,
        )
    result_text = "\n\n".join(texts) if texts else ""
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
) -> None:
    """Run transcribe loop for upload_ids; put progress (current, total, filename) before each chunk and result at end."""
    segments: list[str] = [""] * len(ids)
    failed_chunk_ids: list[str] = []
    failed_chunk_indices: list[int] = []
    parent_dirs: set[Path] = set()
    failed_chunks_to_cleanup: list[tuple[str, str]] = []
    try:
        for i, uid in enumerate(ids):
            entry = pop_upload(uid)
            if not entry:
                failed_chunk_ids.append(uid)
                failed_chunk_indices.append(i)
                continue
            chunk_path, chunk_filename = entry
            parent_dirs.add(Path(chunk_path).parent)
            progress_queue.put({"type": "progress", "current": i + 1, "total": len(ids), "filename": chunk_filename})
            try:
                chunk_bytes = Path(chunk_path).read_bytes()
            except Exception as e:
                logger.exception("Failed to read chunk file: %s", e)
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
                    pass
                continue
            try:
                segment_text = transcribe_svc.transcribe_audio(
                    chunk_bytes, chunk_filename, language=language, clean_up=clean_up
                )
                segments[i] = segment_text
                try:
                    os.unlink(chunk_path)
                except OSError:
                    pass
            except ValueError as e:
                logger.exception("Transcription failed (upload_ids): %s", e)
                _record_failed_chunk(
                    chunk_path, chunk_filename, cleanup_failed,
                    failed_chunk_ids, uid, failed_chunks_to_cleanup,
                )
                failed_chunk_indices.append(i)
            except Exception as e:
                logger.exception("Transcription failed (upload_ids): %s", e)
                _record_failed_chunk(
                    chunk_path, chunk_filename, cleanup_failed,
                    failed_chunk_ids, uid, failed_chunks_to_cleanup,
                )
                failed_chunk_indices.append(i)
            finally:
                del chunk_bytes
    except StoreFullError:
        progress_queue.put({"type": "error", "detail": "Upload store full. Try again later."})
        return
    for chunk_path, _ in failed_chunks_to_cleanup:
        try:
            os.unlink(chunk_path)
        except OSError:
            pass
    if not failed_chunk_ids or cleanup_failed:
        for d in parent_dirs:
            try:
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
    result_text = "\n\n".join(segments) if segments else ""
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
):
    """Stream transcribe progress (NDJSON): progress events with current/total/filename, then result. upload_ids only. Optional: language (auto/en/zh), clean_up (true/false)."""
    ids = [x.strip() for x in (upload_ids or []) if x and x.strip()]
    if not ids:
        raise HTTPException(400, "Provide upload_ids")
    progress_queue: queue.Queue = queue.Queue()
    lang = _parse_language(language)
    do_clean_up = _parse_clean_up(clean_up)

    async def ndjson_stream():
        loop = asyncio.get_event_loop()
        run = loop.run_in_executor(
            None,
            _transcribe_upload_ids_to_queue,
            ids,
            cleanup_failed,
            progress_queue,
            lang,
            do_clean_up,
        )
        while True:
            item = await loop.run_in_executor(None, progress_queue.get)
            yield json.dumps(item, ensure_ascii=False) + "\n"
            if item.get("type") in ("result", "error"):
                break

    return StreamingResponse(ndjson_stream(), media_type="application/x-ndjson")


@router.post("/translate", response_model=TranslateResponse)
async def translate(req: TranslateRequest) -> TranslateResponse:
    """Translate text to target language."""
    if not TARGET_LANG_PATTERN.match(req.target_lang):
        raise HTTPException(400, "Invalid target_lang")

    try:
        text = translate_svc.translate_text(req.text, req.target_lang)
    except ValueError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(502, "Translation request failed") from e

    return TranslateResponse(text=text)
