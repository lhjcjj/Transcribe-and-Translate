"""Translation: remote API (engine=api, e.g. OpenAI) or local Qwen (engine=local)."""
from __future__ import annotations

from openai import OpenAI

from app.config import OPENAI_API_BASE, TRANSLATE_API_KEY, TRANSLATE_PROVIDER
from app.services import translate_qwen


def translate_text(text: str, target_lang: str, engine: str = "api") -> str:
    """
    Translate text to target language.
    engine: "api" -> remote API (currently OpenAI). "local" -> local Qwen model (with internal chunking).
    """
    if engine == "local":
        return translate_qwen.translate_qwen_long(text, target_lang)

    if not TRANSLATE_API_KEY:
        raise ValueError("Translation API key not configured (set OPENAI_API_KEY or TRANSLATE_API_KEY)")

    if TRANSLATE_PROVIDER != "api":
        raise ValueError(f"Translation provider '{TRANSLATE_PROVIDER}' not implemented; use 'api'")

    client_kw: dict = {"api_key": TRANSLATE_API_KEY}
    if OPENAI_API_BASE:
        client_kw["base_url"] = OPENAI_API_BASE
    client = OpenAI(**client_kw)

    prompt = f"Translate the following text to {target_lang}. Output only the translation, no explanations.\n\n{text}"
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
    )
    if not response.choices:
        raise ValueError("Empty translation response")
    return (response.choices[0].message.content or "").strip()
