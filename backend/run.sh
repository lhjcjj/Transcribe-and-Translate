#!/usr/bin/env bash
# Run the backend with the project venv (PyTorch used by faster-whisper etc.).
# Avoid libiomp5/OpenMP crash on macOS when PyTorch and OpenBLAS both ship OpenMP (set single thread).
export KMP_DUPLICATE_LIB_OK=TRUE
export OMP_NUM_THREADS=1
cd "$(dirname "$0")"

# With local models (e.g. faster-whisper), --reload can hang on file change. Use --no-reload to disable.
if [ "$1" = "--no-reload" ] || [ "$RELOAD" = "0" ]; then
  exec .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0
else
  exec .venv/bin/python -m uvicorn app.main:app --reload --host 0.0.0.0 --reload-exclude '.venv/*'
fi
