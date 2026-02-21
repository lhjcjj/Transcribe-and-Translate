"""Translation via OpenAI or configurable provider."""
from openai import OpenAI

from app.config import TRANSLATE_API_KEY, TRANSLATE_PROVIDER, OPENAI_API_BASE


def translate_text(text: str, target_lang: str) -> str:
    """
    Translate text to target language.
    Uses OpenAI chat completion by default. Raises ValueError if not configured.
    """
    if not TRANSLATE_API_KEY:
        raise ValueError("Translation API key not configured (set OPENAI_API_KEY or TRANSLATE_API_KEY)")

    if TRANSLATE_PROVIDER != "openai":
        # Placeholder for future Aliyun or other provider
        raise ValueError(f"Translation provider '{TRANSLATE_PROVIDER}' not implemented; use 'openai'")

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
