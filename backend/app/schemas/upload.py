from pydantic import BaseModel, Field


class UploadChunkItem(BaseModel):
    """One chunk produced by split. Use upload_id in POST /api/transcribe to transcribe this chunk. path is not sent to client (internal only)."""

    path: str = Field("", description="Server path (internal); not exposed to client")
    filename: str = Field(..., description="Suggested filename for the chunk")
    upload_id: str = Field(..., description="Id to pass to transcribe (chunk file)")


class UploadResponse(BaseModel):
    """Response after upload (step 1). Use upload_id to call POST /api/split."""

    upload_id: str = Field(..., description="Id to use for the split endpoint")
    duration_seconds: float | None = Field(None, description="Audio duration in seconds (for segment count); None if unreadable")


class UploadDurationResponse(BaseModel):
    """Duration of an uploaded file (for computing split segment count)."""

    duration_seconds: float = Field(..., description="Total duration in seconds")


class UploadConfigResponse(BaseModel):
    """Public upload limits (single source of truth; backend config)."""

    max_upload_bytes: int = Field(..., description="Max upload size in bytes (e.g. 300MB)")
    upload_ttl_seconds: int = Field(..., description="Upload expiry in seconds; after this the file is cleaned and may be re-uploaded")


class UploadFromUrlRequest(BaseModel):
    """Request body for POST /api/podcast/upload-from-url."""

    url: str = Field(..., description="Audio URL to fetch and store as upload")
    filename: str | None = Field(None, description="Optional display filename (sanitized); inferred from URL if omitted")
    expected_size: int | None = Field(None, description="Expected size in bytes (from RSS); used for progress when stream_progress=True")
    stream_progress: bool = Field(False, description="If True, response is NDJSON stream with progress events and final done")


class SplitRequest(BaseModel):
    """Request body for POST /api/split."""

    upload_id: str = Field(..., description="Id returned from POST /api/upload")
    segment_minutes: int = Field(5, ge=1, le=10, description="Duration of each chunk in minutes")


class SplitResponse(BaseModel):
    """Response after split. temp_dir is not exposed to client (internal cleanup only)."""

    temp_dir: str = Field("", description="Internal; not exposed to client")
    chunks: list[UploadChunkItem] = Field(..., description="Chunk files in time order")
