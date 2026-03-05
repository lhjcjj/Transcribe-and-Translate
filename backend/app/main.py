"""FastAPI application entrypoint."""
import asyncio
import os
import signal
import threading
import time
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

# Grace period (seconds) before force exit when receiving SIGTERM/SIGINT.
# Prevents hang when non-daemon threads (e.g. PyTorch, run_in_executor) block process exit.
_SHUTDOWN_FORCE_EXIT_SECONDS = 5

_force_exit_timer_started = False
_force_exit_lock = threading.Lock()
_original_sigterm = None
_original_sigint = None


def _force_exit_after_delay() -> None:
    time.sleep(_SHUTDOWN_FORCE_EXIT_SECONDS)
    os._exit(0)


def _shutdown_signal_handler(signum: int, frame: object) -> None:
    global _force_exit_timer_started
    with _force_exit_lock:
        if not _force_exit_timer_started:
            _force_exit_timer_started = True
            t = threading.Thread(target=_force_exit_after_delay, daemon=True)
            t.start()
    handler = _original_sigterm if signum == signal.SIGTERM else _original_sigint
    if callable(handler):
        handler(signum, frame)
    elif signum == signal.SIGINT:
        raise KeyboardInterrupt()
    else:
        raise SystemExit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Install signal handlers so that if graceful shutdown hangs (e.g. PyTorch/executor threads),
    # the process still exits after _SHUTDOWN_FORCE_EXIT_SECONDS.
    global _original_sigterm, _original_sigint
    if hasattr(signal, "SIGTERM"):
        _original_sigterm = signal.signal(signal.SIGTERM, _shutdown_signal_handler)
    _original_sigint = signal.signal(signal.SIGINT, _shutdown_signal_handler)

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
    version="1.0.7",
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
