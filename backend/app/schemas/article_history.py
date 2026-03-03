"""Schemas for restructured article history list and get."""

from pydantic import BaseModel, Field


class ArticleListItem(BaseModel):
    """One entry in the restructured article history list (metadata only)."""

    id: str = Field(..., description="Article id (string, matches filename stem)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name (source or fallback)")


class ArticleDetail(BaseModel):
    """Full article for get/download."""

    id: str = Field(..., description="Article id")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")
    text: str = Field(..., description="Article text", max_length=2_000_000)


class ArticleSaveRequest(BaseModel):
    """Request body for saving a restructured article to history."""

    display_name: str = Field(..., min_length=1, max_length=500, description="Display name for the entry")
    text: str = Field(..., min_length=1, max_length=2_000_000, description="Full article text")


class ArticleSaveResponse(BaseModel):
    """Response after saving an article (id and metadata for list)."""

    id: str = Field(..., description="Article id")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")

