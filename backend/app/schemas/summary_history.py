"""Schemas for summary history list and get."""
from pydantic import BaseModel, Field


class SummaryListItem(BaseModel):
    """One entry in the summary history list (metadata only)."""

    id: str = Field(..., description="Summary id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name (source or fallback)")


class SummaryDetail(BaseModel):
    """Full summary for get/download."""

    id: str = Field(..., description="Summary id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")
    text: str = Field(..., description="Summary text", max_length=2_000_000)
    meta: dict | None = Field(None, description="Optional metadata (e.g. source type and parameters)")


class SummarySaveRequest(BaseModel):
    """Request body for saving a summary to history."""

    display_name: str = Field(..., min_length=1, max_length=500, description="Display name for the entry")
    text: str = Field(..., min_length=1, max_length=2_000_000, description="Summary text")


class SummarySaveResponse(BaseModel):
    """Response after saving a summary (id and metadata for list)."""

    id: str = Field(..., description="Summary id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")
