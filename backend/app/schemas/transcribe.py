from pydantic import BaseModel, Field


class TranscribeResponse(BaseModel):
    """Response for transcription endpoint. If failed_chunk_ids is present, transcription was partial."""

    text: str = Field(..., description="Transcribed text (partial if failed_chunk_ids present)", max_length=1_000_000)
    failed_chunk_ids: list[str] | None = Field(
        None, description="Upload IDs of chunks that failed (use these to retry transcription)"
    )
    text_segments: list[str] | None = Field(
        None,
        description="Segment texts in request order (one per chunk; empty string for failed). Only when upload_ids were used.",
    )
    failed_chunk_indices: list[int] | None = Field(
        None,
        description="0-based indices of failed chunks in the original request order. Only when failed_chunk_ids is present.",
    )
