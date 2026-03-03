"""Summarization via remote API (currently OpenAI)."""

from __future__ import annotations

from openai import OpenAI

from app.config import OPENAI_API_BASE, TRANSLATE_API_KEY


def summarize_text(text: str) -> str:
    """
    Summarize the given text using a remote API (OpenAI Chat Completions).
    Uses the same API key/base URL configuration as translation.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty text for summarization")

    if not TRANSLATE_API_KEY:
        raise ValueError("Summary API key not configured (set OPENAI_API_KEY or GPTS_API_KEY)")

    client_kw: dict = {"api_key": TRANSLATE_API_KEY}
    if OPENAI_API_BASE:
        client_kw["base_url"] = OPENAI_API_BASE
    client = OpenAI(**client_kw)

    prompt = (
        "Summarize the following content. "
        "Keep a moderate length: preserve key ideas, main arguments, important details and numbers, and enough context so the summary stands on its own. "
        "Do not over-compress; the summary should be readable and informative, not just bullet points. "
        "Output only the summary, no meta explanations.\n\n"
        f"{text}"
    )
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
    )
    if not response.choices:
        raise ValueError("Empty summary response")
    return (response.choices[0].message.content or "").strip()

