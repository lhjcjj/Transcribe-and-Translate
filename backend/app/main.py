"""FastAPI application entrypoint."""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.upload_store import (
    cleanup_expired_uploads,
    cleanup_orphaned_temp_files,
    cleanup_orphaned_audio_split_dirs,
    cleanup_orphaned_spool_temp_files,
)
from app.api.routes import router
from app.config import ALLOWED_ORIGINS, CLEANUP_INTERVAL_SECONDS


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: remove orphan temp files from previous runs (upload_*, audio_split_*, old tmp* spool; single listdir)
    await asyncio.to_thread(cleanup_orphaned_temp_files)
    # Background: periodically remove expired uploads
    stop = asyncio.Event()
    task = asyncio.create_task(_cleanup_loop(stop))
    try:
        yield
    finally:
        stop.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def _cleanup_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=CLEANUP_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            await asyncio.to_thread(cleanup_expired_uploads)
            await asyncio.to_thread(cleanup_orphaned_audio_split_dirs)
            await asyncio.to_thread(cleanup_orphaned_spool_temp_files)


app = FastAPI(
    title="Transcribe and Translate",
    description="Audio transcription and text translation API",
    version="1.0.3",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "X-API-Key", "Authorization"],
)

app.include_router(router)


@app.get("/health")
def health():
    return {"status": "ok"}
