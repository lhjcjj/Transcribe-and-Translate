"""Schemas for transcription history list and get."""
from pydantic import BaseModel, Field


class TranscriptionListItem(BaseModel):
    """One entry in the transcription history list (metadata only)."""

    id: str = Field(..., description="Transcription id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name (filename or fallback)")


class TranscriptionDetail(BaseModel):
    """Full transcription for get/download."""

    id: str = Field(..., description="Transcription id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    text: str = Field(..., description="Transcribed text", max_length=2_000_000)
    meta: dict | None = Field(None, description="Optional metadata")
