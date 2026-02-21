from pydantic import BaseModel, Field


class UploadChunkItem(BaseModel):
    """One chunk produced by split. Use upload_id in POST /api/transcribe to transcribe this chunk."""

    path: str = Field(..., description="Server path to the chunk file")
    filename: str = Field(..., description="Suggested filename for the chunk")
    upload_id: str = Field(..., description="Id to pass to transcribe (chunk file)")


class UploadResponse(BaseModel):
    """Response after upload (step 1). Use upload_id to call POST /api/split."""

    upload_id: str = Field(..., description="Id to use for the split endpoint")


class SplitRequest(BaseModel):
    """Request body for POST /api/split."""

    upload_id: str = Field(..., description="Id returned from POST /api/upload")


class SplitResponse(BaseModel):
    """Response after split. Caller must delete temp_dir when done (e.g. shutil.rmtree)."""

    temp_dir: str = Field(..., description="Temporary directory containing chunk files")
    chunks: list[UploadChunkItem] = Field(..., description="Chunk files in time order")
