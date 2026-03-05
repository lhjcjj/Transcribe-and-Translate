"""Schemas for podcast (Get Information) list and save."""
from pydantic import BaseModel, Field


class PodcastListItem(BaseModel):
    """One podcast in the list."""

    id: str = Field(..., description="Podcast id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    name: str = Field(..., description="Podcast name")
    link: str = Field(..., description="Podcast link (e.g. Apple Podcasts URL)")
    rss: str | None = Field(None, description="RSS feed URL (filled after RSS button)")


class PodcastSaveRequest(BaseModel):
    """Request body for creating a podcast (name + link)."""

    name: str = Field(..., description="Podcast name")
    link: str = Field(..., description="Podcast link")


class PodcastSaveResponse(BaseModel):
    """Response after creating a podcast."""

    id: str = Field(..., description="Podcast id (UUID)")
    created_at: float | None = Field(None, description="Unix timestamp when saved")
    name: str = Field(..., description="Podcast name")
    link: str = Field(..., description="Podcast link")
    rss: str | None = Field(None, description="RSS feed URL if already set")


class PodcastUpdateRequest(BaseModel):
    """Request body for updating name/link (after Edit + Save)."""

    name: str = Field(..., description="Podcast name")
    link: str = Field(..., description="Podcast link")


class PodcastRssRequest(BaseModel):
    """Request body for updating rss (after RSS button)."""

    rss: str = Field(..., description="RSS feed URL")


class PodcastFeedAudioItem(BaseModel):
    """One audio file from a podcast RSS feed (enclosure)."""

    url: str = Field(..., description="Audio file URL")
    title: str | None = Field(None, description="Episode title from feed")
    pub_date: str | None = Field(None, description="Publication date from feed")
