"""Summarization via remote API (currently OpenAI)."""

from __future__ import annotations

from openai import OpenAI

from app.config import SUMMARIZE_API_BASE, SUMMARIZE_API_KEY


def summarize_text(text: str) -> str:
    """
    Summarize the given text using a remote API (OpenAI Chat Completions).
    Uses SUMMARIZE_API_KEY / SUMMARIZE_API_BASE, or falls back to OPENAI/GPTS vars.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty text for summarization")

    if not SUMMARIZE_API_KEY:
        raise ValueError(
            "Summary API key not configured (set SUMMARIZE_API_KEY, OPENAI_API_KEY, or GPTS_API_KEY)"
        )

    client_kw: dict = {"api_key": SUMMARIZE_API_KEY}
    if SUMMARIZE_API_BASE:
        client_kw["base_url"] = SUMMARIZE_API_BASE
    client = OpenAI(**client_kw)

    prompt = (
        "First, generate a concise title for the following content in the same language as the input. "
        "Then, on a new line, write a summary in the same language as the input. "
        "Keep a moderate length: preserve key ideas, main arguments, important details and numbers, and enough context so the summary stands on its own. "
        "Do not over-compress; the summary should be readable and informative, not just bullet points. "
        "Output ONLY the title on the first line and the summary on the following line(s); do not output any other text.\n\n"
        f"{text}"
    )
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
    )
    if not response.choices:
        raise ValueError("Empty summary response")
    return (response.choices[0].message.content or "").strip()

