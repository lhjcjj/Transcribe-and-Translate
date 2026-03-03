from typing import Literal

from pydantic import BaseModel, Field


class SummarizeRequest(BaseModel):
    """Request body for summarize endpoint."""

    text: str = Field(
        ...,
        min_length=1,
        max_length=200_000,
        description="Text to summarize",
    )

    engine: Literal["api", "local"] = Field(
        "api",
        description="Summarization engine: api (remote OpenAI) or local (Qwen)",
    )


class SummarizeResponse(BaseModel):
    """Response for summarize endpoint."""

    text: str = Field(
        ...,
        description="Summarized text",
        max_length=300_000,
    )

