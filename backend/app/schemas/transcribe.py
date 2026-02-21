from pydantic import BaseModel, Field


class TranscribeResponse(BaseModel):
    """Response for transcription endpoint. If failed_chunk_ids is present, transcription was partial."""

    text: str = Field(..., description="Transcribed text (partial if failed_chunk_ids present)", max_length=1_000_000)
    failed_chunk_ids: list[str] | None = Field(
        None, description="Upload IDs of chunks that failed (use these to retry transcription)"
    )
