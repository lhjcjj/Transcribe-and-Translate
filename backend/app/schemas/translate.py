from typing import Literal

from pydantic import BaseModel, Field


class TranslateRequest(BaseModel):
    """Request body for translation endpoint."""

    text: str = Field(..., min_length=1, max_length=200_000, description="Text to translate")
    target_lang: str = Field(..., min_length=1, max_length=20, description="Target language code or name (e.g. zh, English)")
    engine: Literal["api", "local"] = Field("api", description="Translation engine: api (remote) or local")


class TranslateResponse(BaseModel):
    """Response for translation endpoint."""

    text: str = Field(..., description="Translated text", max_length=300_000)
