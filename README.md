# Transcribe and Translate

Small tool: upload audio → transcribe to text → translate to another language. Backend (Python/FastAPI) holds API keys; frontend (React/TypeScript) talks to the backend only.

## Requirements

- Python 3.10+
- Node 18+ (for frontend)
- OpenAI API key (for Whisper transcription and optional translation)

## Setup

1. Clone the repo and open the project directory.

2. **Backend**  
   Use a virtual environment (recommended for local development). From the project root:

   **Create the venv (one-time, already done if you see `backend/.venv`):**

   ```bash
   cd backend && python3 -m venv .venv
   ```

   **Activate and run:**

   - **macOS / Linux:**
     ```bash
     cd backend
     source .venv/bin/activate
     cp .env.example .env
     # Edit .env and set OPENAI_API_KEY=sk-...
     pip install -r requirements.txt
     uvicorn app.main:app --reload --port 8000
     ```
   - **Windows (Cmd):**
     ```bash
     cd backend
     .venv\Scripts\activate.bat
     copy .env.example .env
     # Edit .env and set OPENAI_API_KEY=sk-...
     pip install -r requirements.txt
     uvicorn app.main:app --reload --port 8000
     ```
   - **Windows (PowerShell):**
     ```bash
     cd backend
     .venv\Scripts\Activate.ps1
     copy .env.example .env
     # Edit .env and set OPENAI_API_KEY=sk-...
     pip install -r requirements.txt
     uvicorn app.main:app --reload --port 8000
     ```

   After activation, your prompt will show `(.venv)`. The `.venv` folder is in `.gitignore` and is not committed.

3. **Frontend** (another terminal)

   ```bash
   cd frontend && npm install && npm run dev
   ```

   Open http://localhost:5173. The dev server proxies `/api` and `/health` to the backend at port 8000.

## Running with Docker

From the project root:

```bash
# Create backend/.env with OPENAI_API_KEY (see backend/.env.example)
docker compose up --build
```

- Frontend: http://localhost:3000  
- Backend API: http://localhost:8000  

## Environment variables (backend)

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Used for Whisper and, if not overridden, for translation. Do not commit. |
| `TRANSCRIBE_API_KEY` | Optional override for transcription only. |
| `TRANSLATE_API_KEY` | Optional override for translation; defaults to `OPENAI_API_KEY`. |
| `OPENAI_API_BASE` | Optional API base URL override. |
| `TRANSLATE_PROVIDER` | `openai` (default); others (e.g. aliyun) can be added later. |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. |
| `MAX_TRANSCRIBE_BYTES` | Max audio size in bytes for transcribe (default 25MB). |
| `MAX_UPLOAD_BYTES` | Max file upload size in bytes (default 100MB). |

See `backend/.env.example` for a template. Never put real keys in the repo or in frontend code.

## API

- `POST /api/transcribe` — body: multipart form with `audio` file. Response: `{ "text": "..." }`.
- `POST /api/translate` — body: `{ "text": "...", "target_lang": "English" }`. Response: `{ "text": "..." }`.
- `GET /health` — health check.

## Security

- All API keys are read only in the backend from environment variables.
- Frontend never receives or sends secrets; it only calls backend endpoints.
- CORS is configured via `ALLOWED_ORIGINS` (no `*` in production).
- Uploads are validated (audio type, size limit); input is validated with Pydantic. Rendered text is never injected as HTML (no XSS).

## Deployment (AWS / Aliyun)

- **Backend**: run the backend container (e.g. ECS/ACK/EC2), inject env vars or use AWS Secrets Manager / Aliyun KMS.
- **Frontend**: build with `npm run build` and serve the `frontend/dist` folder (e.g. S3/OSS + CDN), or keep using the frontend container and set `ALLOWED_ORIGINS` to your frontend origin. Configure `VITE_API_BASE` at build time if the frontend is on a different domain than the API.

## Embedding

- **Backend**: standalone HTTP API; no DB or queue required. Integrate by calling `POST /api/transcribe` and `POST /api/translate`.
- **Frontend**: can be built and mounted under another app (iframe or sub-path), or the UI components can be reused with a single config (backend base URL).
