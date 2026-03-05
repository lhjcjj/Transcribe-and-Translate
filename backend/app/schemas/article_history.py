"""Schemas for restructured article history list and get."""

from pydantic import BaseModel, Field


class ArticleListItem(BaseModel):
    """One entry in the restructured article history list (metadata only)."""

    id: str = Field(..., description="Article id (string, matches filename stem)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name (source or fallback)")
    notion_url: str | None = Field(None, description="URL of last Notion page pushed for this article")


class ArticleDetail(BaseModel):
    """Full article for get/download."""

    id: str = Field(..., description="Article id")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")
    text: str = Field(..., description="Article text", max_length=2_000_000)
    notion_url: str | None = Field(None, description="URL of last Notion page pushed for this article")


class ArticleSaveRequest(BaseModel):
    """Request body for saving a restructured article to history."""

    display_name: str = Field(..., min_length=1, max_length=500, description="Display name for the entry")
    text: str = Field(..., min_length=1, max_length=2_000_000, description="Full article text")


class ArticleSaveResponse(BaseModel):
    """Response after saving an article (id and metadata for list)."""

    id: str = Field(..., description="Article id")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    display_name: str = Field(..., description="Display name")


class ArticleNotionExportResponse(BaseModel):
    """Response after exporting an article to Notion."""

    notion_page_id: str | None = Field(None, description="Created Notion page id")
    notion_url: str | None = Field(None, description="URL of created Notion page")


class ArticleNotionExportRequest(BaseModel):
    """Request body for exporting an article to Notion."""

    database: str | None = Field(
        None,
        description="Target database key: 'main' or 'alt'. When omitted, backend default is used.",
    )


