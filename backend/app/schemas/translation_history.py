"""Schemas for translation history list and get."""
from pydantic import BaseModel, Field


class TranslationListItem(BaseModel):
    """One entry in the translation history list (metadata only)."""

    id: str = Field(..., description="Translation id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name (source or fallback)")


class TranslationDetail(BaseModel):
    """Full translation for get/download."""

    id: str = Field(..., description="Translation id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")
    text: str = Field(..., description="Translated text", max_length=2_000_000)
    meta: dict | None = Field(None, description="Optional metadata (e.g. source transcription id, direction)")


class TranslationSaveRequest(BaseModel):
    """Request body for saving a translation to history."""

    display_name: str = Field(..., min_length=1, max_length=500, description="Display name for the entry")
    text: str = Field(..., min_length=1, max_length=2_000_000, description="Translated text")


class TranslationSaveResponse(BaseModel):
    """Response after saving a translation (id and metadata for list)."""

    id: str = Field(..., description="Translation id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")
