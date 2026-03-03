"""Local translation via OPUS-MT (MarianMT). Lazy-loads model on first use."""
from __future__ import annotations

import re
import threading

from app.config import (
    TRANSLATE_OPUS_DEVICE,
    TRANSLATE_OPUS_MODEL_EN_ZH,
    TRANSLATE_OPUS_MODEL_ZH_EN,
)

# MarianMT max length is 512; use a safe chunk size in chars to stay under that
_MAX_CHUNK_CHARS = 400

# Lazy-loaded pipelines: key = target_lang normalised to zh/en
_pipelines: dict[str, object] = {}
_lock = threading.Lock()


def _get_pipeline(target_lang: str):
    """Return the translation pipeline for the given target language (zh or en). Load on first use."""
    key = (target_lang or "").strip().lower()
    if key not in ("zh", "en"):
        raise ValueError(f"OPUS-MT translation only supports target_lang 'zh' or 'en', got: {target_lang!r}")
    with _lock:
        if key in _pipelines:
            return _pipelines[key]
        import torch
        from transformers import pipeline
        model_name = TRANSLATE_OPUS_MODEL_ZH_EN if key == "en" else TRANSLATE_OPUS_MODEL_EN_ZH
        device = 0 if TRANSLATE_OPUS_DEVICE == "cuda" and torch.cuda.is_available() else -1
        pipe = pipeline("translation", model=model_name, device=device)
        _pipelines[key] = pipe
        return pipe


def _chunk_text(text: str, max_chars: int = _MAX_CHUNK_CHARS) -> list[str]:
    """Split text into chunks that fit within model max length. Prefer sentence/paragraph boundaries."""
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    # Split by double newline first (paragraphs)
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= max_chars:
            chunks.append(para)
            continue
        # Split by sentence-like boundaries (., !, ?, newline)
        for sent in re.split(r"(?<=[.!?\n])\s+", para):
            sent = sent.strip()
            if not sent:
                continue
            if len(sent) <= max_chars:
                chunks.append(sent)
                continue
            # Hard split by max_chars
            for i in range(0, len(sent), max_chars):
                chunks.append(sent[i : i + max_chars].strip())
    return [c for c in chunks if c]


def translate_opus(text: str, target_lang: str) -> str:
    """
    Translate text using OPUS-MT (Helsinki-NLP). target_lang must be 'zh' or 'en'.
    Long text is chunked to stay within model max length (512 tokens).
    """
    text = (text or "").strip()
    if not text:
        return ""
    pipe = _get_pipeline(target_lang)
    chunks = _chunk_text(text)
    if not chunks:
        return ""
    results: list[str] = []
    for chunk in chunks:
        out = pipe(chunk, max_length=512)
        if out and isinstance(out, list):
            for item in out:
                if isinstance(item, dict) and item.get("translation_text"):
                    results.append(item["translation_text"])
    return " ".join(results).strip() if results else ""
