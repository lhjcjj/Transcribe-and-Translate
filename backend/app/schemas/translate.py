from typing import Literal

from pydantic import BaseModel, Field, model_validator

# Max segments for translate-by-segments (align with transcribe chunk batch size)
TRANSLATE_MAX_SEGMENTS = 300
TRANSLATE_SEGMENT_MAX_LENGTH = 200_000


class TranslateRequest(BaseModel):
    """Request body for translation endpoint. Provide either text or segments (not both). When segments given, each is translated separately and results are joined with double newline."""

    text: str | None = Field(None, max_length=200_000, description="Text to translate (used when segments not provided)")
    segments: list[str] | None = Field(None, max_length=TRANSLATE_MAX_SEGMENTS, description="Translate by chunk/segment: one request per segment, then concatenated. When non-empty, text is ignored.")
    target_lang: str = Field(..., min_length=1, max_length=20, description="Target language code or name (e.g. zh, English)")
    engine: Literal["api", "local"] = Field("api", description="Translation engine: api (remote) or local")

    @model_validator(mode="after")
    def require_text_or_segments(self):
        use_segments = self.segments and len(self.segments) > 0
        use_text = self.text is not None and self.text.strip() != ""
        if not use_segments and not use_text:
            raise ValueError("Provide either text or non-empty segments")
        if use_segments:
            for i, s in enumerate(self.segments):
                if not s or not s.strip():
                    raise ValueError(f"Segment {i} must be non-empty string")
                if len(s) > TRANSLATE_SEGMENT_MAX_LENGTH:
                    raise ValueError(f"Segment {i} exceeds max length {TRANSLATE_SEGMENT_MAX_LENGTH}")
        return self


class TranslateResponse(BaseModel):
    """Response for translation endpoint."""

    text: str = Field(..., description="Translated text", max_length=300_000)
