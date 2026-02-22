from pydantic import BaseModel, Field


class UploadChunkItem(BaseModel):
    """One chunk produced by split. Use upload_id in POST /api/transcribe to transcribe this chunk."""

    path: str = Field(..., description="Server path to the chunk file")
    filename: str = Field(..., description="Suggested filename for the chunk")
    upload_id: str = Field(..., description="Id to pass to transcribe (chunk file)")


class UploadResponse(BaseModel):
    """Response after upload (step 1). Use upload_id to call POST /api/split."""

    upload_id: str = Field(..., description="Id to use for the split endpoint")
    duration_seconds: float | None = Field(None, description="Audio duration in seconds (for segment count); None if unreadable")


class UploadDurationResponse(BaseModel):
    """Duration of an uploaded file (for computing split segment count)."""

    duration_seconds: float = Field(..., description="Total duration in seconds")


class SplitRequest(BaseModel):
    """Request body for POST /api/split."""

    upload_id: str = Field(..., description="Id returned from POST /api/upload")
    segment_minutes: int = Field(5, ge=1, le=10, description="Duration of each chunk in minutes")


class SplitResponse(BaseModel):
    """Response after split. Caller must delete temp_dir when done (e.g. shutil.rmtree)."""

    temp_dir: str = Field(..., description="Temporary directory containing chunk files")
    chunks: list[UploadChunkItem] = Field(..., description="Chunk files in time order")
