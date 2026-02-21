"""Transcribe and translate endpoints."""
import logging
import os
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from app import config
from app.api.deps import allowed_audio_content_type, read_file_with_size_cap
from app.schemas.upload import SplitRequest, SplitResponse, UploadChunkItem, UploadResponse
from app.api.upload_store import pop_upload, put_upload, save_upload_bytes
from app.schemas.transcribe import TranscribeResponse
from app.schemas.translate import TranslateRequest, TranslateResponse
from app.services import audio_split as audio_split_svc
from app.services import transcribe as transcribe_svc
from app.services import translate as translate_svc

router = APIRouter(prefix="/api", tags=["api"])

_MULTIPART_OVERHEAD_BYTES = 1 * 1024 * 1024  # 1MB for Content-Length reject

# Sanitize target_lang: alphanumeric, spaces, hyphens only (no injection)
TARGET_LANG_PATTERN = re.compile(r"^[a-zA-Z0-9\u4e00-\u9fff\s\-]{1,20}$")


def _reject_413_request_too_large():
    raise HTTPException(
        413,
        f"Request body too large (max {config.MAX_UPLOAD_BYTES} bytes)",
    )


def _reject_413_transcribe_too_large():
    raise HTTPException(
        413,
        f"File too large (max {config.MAX_TRANSCRIBE_BYTES} bytes)",
    )


def _sanitize_filename(audio: UploadFile) -> str:
    name = audio.filename or "audio"
    if "/" in name or "\\" in name:
        name = name.replace("\\", "/").split("/")[-1]
    return name.strip() or "audio"


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
                _reject_413_request_too_large()
        except ValueError:
            pass

    body = await read_file_with_size_cap(
        audio, config.MAX_UPLOAD_BYTES, _reject_413_request_too_large
    )
    if len(body) == 0:
        del body
        raise HTTPException(400, "Empty file")

    name = _sanitize_filename(audio)
    upload_id = save_upload_bytes(body, name)
    del body
    return UploadResponse(upload_id=upload_id)


@router.post("/split", response_model=SplitResponse)
async def split(req: SplitRequest) -> SplitResponse:
    """Split an uploaded file into chunks by upload_id. Removes the stored upload after split."""
    entry = pop_upload(req.upload_id)
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
    try:
        temp_dir, chunk_list = audio_split_svc.split_audio_into_chunks(body, filename)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    finally:
        del body
    chunks_with_ids = []
    for p, n in chunk_list:
        chunk_upload_id = put_upload(p, n)
        chunks_with_ids.append(UploadChunkItem(path=p, filename=n, upload_id=chunk_upload_id))
    return SplitResponse(temp_dir=temp_dir, chunks=chunks_with_ids)


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    audio: list[UploadFile] | None = File(None),
    upload_ids: list[str] | None = Form(None),
    cleanup_failed: bool = Form(False),
) -> TranscribeResponse:
    """Transcribe to text: provide upload_ids (list of chunk upload_ids from split) or one or more audio files (multipart 'audio'). Exactly one of upload_ids / audio required. Each file max MAX_TRANSCRIBE_BYTES (e.g. 25MB). If cleanup_failed=True, failed chunks are deleted (abandon retry); if False (default), failed chunks are kept for manual retry."""
    ids = [x.strip() for x in (upload_ids or []) if x and x.strip()]
    has_upload_ids = len(ids) > 0
    has_files = audio and len(audio) > 0

    if has_upload_ids and has_files:
        raise HTTPException(400, "Provide either audio file(s) or upload_ids, not both")
    if not has_upload_ids and not has_files:
        raise HTTPException(400, "Provide either audio file(s) or upload_ids")

    texts: list[str] = []
    failed_chunk_ids: list[str] = []

    if has_upload_ids:
        parent_dirs: set[Path] = set()
        successful_ids: set[str] = set()
        failed_chunks_to_cleanup: list[tuple[str, str]] = []  # (chunk_path, chunk_filename)
        for uid in ids:
            entry = pop_upload(uid)
            if not entry:
                failed_chunk_ids.append(uid)
                continue
            chunk_path, chunk_filename = entry
            parent_dirs.add(Path(chunk_path).parent)
            try:
                chunk_bytes = Path(chunk_path).read_bytes()
            except Exception as e:
                logger.exception("Failed to read chunk file: %s", e)
                failed_chunk_ids.append(uid)
                if cleanup_failed:
                    failed_chunks_to_cleanup.append((chunk_path, chunk_filename))
                else:
                    # Put back into store so user can retry
                    put_upload(chunk_path, chunk_filename)
                continue
            if len(chunk_bytes) == 0:
                failed_chunk_ids.append(uid)
                if cleanup_failed:
                    failed_chunks_to_cleanup.append((chunk_path, chunk_filename))
                else:
                    # Put back into store so user can retry
                    put_upload(chunk_path, chunk_filename)
                try:
                    os.unlink(chunk_path)
                except OSError:
                    pass
                continue
            try:
                segment_text = transcribe_svc.transcribe_audio(
                    chunk_bytes, chunk_filename
                )
                texts.append(segment_text)
                successful_ids.add(uid)
                # Success: unlink file and don't put back in store
                try:
                    os.unlink(chunk_path)
                except OSError:
                    pass
            except ValueError as e:
                logger.exception("Transcription failed (upload_ids): %s", e)
                failed_chunk_ids.append(uid)
                if cleanup_failed:
                    failed_chunks_to_cleanup.append((chunk_path, chunk_filename))
                else:
                    # Put back into store so user can retry
                    put_upload(chunk_path, chunk_filename)
            except Exception as e:
                logger.exception("Transcription failed (upload_ids): %s", e)
                failed_chunk_ids.append(uid)
                if cleanup_failed:
                    failed_chunks_to_cleanup.append((chunk_path, chunk_filename))
                else:
                    # Put back into store so user can retry
                    put_upload(chunk_path, chunk_filename)
            finally:
                del chunk_bytes
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
                f, config.MAX_TRANSCRIBE_BYTES, _reject_413_transcribe_too_large
            )
            if len(body) == 0:
                del body
                raise HTTPException(400, "Empty file")
            name = _sanitize_filename(f)
            try:
                text = transcribe_svc.transcribe_audio(body, name)
                texts.append(text)
            except ValueError as e:
                raise HTTPException(503, str(e)) from e
            except Exception as e:
                logger.exception("Transcription failed (audio): %s", e)
                raise HTTPException(502, "Transcription request failed") from e
            finally:
                del body

    result_text = "\n\n".join(texts) if texts else ""
    return TranscribeResponse(
        text=result_text,
        failed_chunk_ids=failed_chunk_ids if failed_chunk_ids else None,
    )


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
