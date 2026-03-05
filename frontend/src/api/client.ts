/**
 * Backend API client. Uses relative /api in dev (Vite proxy) or VITE_API_BASE in build.
 * When VITE_API_KEY is set (same as backend API_KEY), all requests send X-API-Key header.
 */
const API_BASE = (typeof import.meta !== "undefined" && (import.meta as ImportMeta).env?.VITE_API_BASE) || "";

function getApiHeaders(): Record<string, string> {
  const key = (typeof import.meta !== "undefined" && (import.meta as ImportMeta).env?.VITE_API_KEY) as string | undefined;
  if (!key) return {};
  return { "X-API-Key": key };
}

export interface UploadConfig {
  max_upload_bytes: number;
}

export async function getUploadConfig(
  options?: { signal?: AbortSignal }
): Promise<UploadConfig> {
  const res = await fetch(`${API_BASE}/api/config`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Get config failed"));
  }
  return res.json();
}

/** Return safe user-facing message; reject raw strings that look like paths or stack traces. */
function sanitizeErrorMessage(raw: string, fallback: string): string {
  const looksInternal =
    raw.includes("\n") ||
    /Traceback|File\s+["']|^\s*\/[^\s]/.test(raw) ||
    /[a-zA-Z]:\\.*\.(py|js|ts)/.test(raw);
  return looksInternal ? fallback : raw;
}

/** Use backend detail only; avoid exposing internal paths/stack. Reject detail that looks like paths or stack traces. */
async function getErrorMessageFromResponse(res: Response, defaultMessage: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    const raw = body.detail ?? res.statusText ?? defaultMessage;
    return sanitizeErrorMessage(raw, res.statusText || defaultMessage);
  } catch {
    return res.statusText || defaultMessage;
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export function upload(
  file: File,
  options?: { signal?: AbortSignal; onProgress?: (p: UploadProgress) => void }
): Promise<{ upload_id: string; duration_seconds?: number | null }> {
  const { signal, onProgress } = options ?? {};
  const form = new FormData();
  form.append("audio", file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => {
      xhr.abort();
      removeListeners();
    };
    const onProgressHandler = (e: ProgressEvent<XMLHttpRequestEventTarget>) => {
      if (e.lengthComputable && onProgress) {
        onProgress({
          loaded: e.loaded,
          total: e.total,
          percent: Math.min(99, Math.round((e.loaded / e.total) * 100)),
        });
      }
    };
    const onLoadHandler = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { upload_id: string; duration_seconds?: number | null };
          removeListeners();
          resolve(data);
        } catch {
          removeListeners();
          reject(new Error("Invalid response"));
        }
      } else {
        let detail = xhr.statusText;
        try {
          const body = JSON.parse(xhr.responseText) as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {
          // ignore
        }
        removeListeners();
        detail = sanitizeErrorMessage(detail || "Upload failed", "Upload failed");
        reject(new Error(detail));
      }
    };
    const onErrorHandler = () => {
      removeListeners();
      reject(new Error("Network error"));
    };
    const onAbortXhr = () => {
      removeListeners();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const removeListeners = () => {
      signal?.removeEventListener("abort", onAbort);
      xhr.upload.removeEventListener("progress", onProgressHandler);
      xhr.removeEventListener("load", onLoadHandler);
      xhr.removeEventListener("error", onErrorHandler);
      xhr.removeEventListener("abort", onAbortXhr);
    };
    if (signal) signal.addEventListener("abort", onAbort);
    xhr.upload.addEventListener("progress", onProgressHandler);
    xhr.addEventListener("load", onLoadHandler);
    xhr.addEventListener("error", onErrorHandler);
    xhr.addEventListener("abort", onAbortXhr);
    xhr.open("POST", `${API_BASE}/api/upload`);
    Object.entries(getApiHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.send(form);
  });
}

export async function deleteUpload(
  uploadId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/upload/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(await getErrorMessageFromResponse(res, "Delete upload failed"));
  }
}

export interface SplitChunkItem {
  path: string;
  filename: string;
  upload_id: string;
}

export async function getUploadDuration(
  uploadId: string,
  options?: { signal?: AbortSignal }
): Promise<{ duration_seconds: number }> {
  const res = await fetch(`${API_BASE}/api/upload/${encodeURIComponent(uploadId)}/duration`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Get duration failed"));
  }
  return res.json();
}

export async function splitStream(
  uploadId: string,
  segmentMinutes: number,
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ temp_dir: string; chunks: SplitChunkItem[] }> {
  const res = await fetch(`${API_BASE}/api/split/stream`, {
    method: "POST",
    headers: { ...getApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId, segment_minutes: segmentMinutes }),
    signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Split failed"));
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  type NdjsonState = { result: { temp_dir: string; chunks: SplitChunkItem[] } | null; errorDetail: string | null };
  const state: NdjsonState = { result: null, errorDetail: null };
  const defaultError = "Split failed";

  function processNdjsonLine(line: string): void {
    if (!line.trim()) return;
    const item = JSON.parse(line) as {
      type: string;
      current?: number;
      total?: number;
      detail?: string;
      temp_dir?: string;
      chunks?: SplitChunkItem[];
    };
    if (item.type === "progress" && item.current != null && item.total != null) {
      onProgress(item.current, item.total);
    } else if (item.type === "result" && item.temp_dir != null && item.chunks) {
      state.result = { temp_dir: item.temp_dir, chunks: item.chunks };
    } else if (item.type === "error") {
      state.errorDetail = sanitizeErrorMessage(item.detail ?? defaultError, defaultError);
    }
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processNdjsonLine(line);
    if (done) break;
  }
  for (const line of buffer.split("\n").filter((s) => s.trim())) processNdjsonLine(line);
  if (!state.result && buffer.trim()) {
    try {
      const item = JSON.parse(buffer.trim()) as { type: string; temp_dir?: string; chunks?: SplitChunkItem[]; detail?: string };
      if (item.type === "result" && item.temp_dir != null && item.chunks) {
        state.result = { temp_dir: item.temp_dir, chunks: item.chunks };
      } else if (item.type === "error" && state.errorDetail == null) {
        state.errorDetail = sanitizeErrorMessage(item.detail ?? defaultError, defaultError);
      }
    } catch {
      /* ignore malformed trailing buffer */
    }
  }
  if (state.errorDetail) throw new Error(state.errorDetail);
  if (!state.result) throw new Error(defaultError);
  return state.result;
}

/** Ask the server to stop the currently running split/stream. Call when user cancels split. */
export async function cancelSplitStream(
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/split/cancel`, {
    method: "POST",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(res.statusText || "Cancel split failed");
  }
}

async function jsonPost(
  path: string,
  body: object,
  options?: { signal?: AbortSignal }
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...getApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
}

/** API response shape for transcribe endpoints (avoids name clash with TranscribeResult component). */
export interface TranscribeApiResult {
  text: string;
  failed_chunk_ids?: string[] | null;
  text_segments?: string[] | null;
  failed_chunk_indices?: number[] | null;
}

export type TranscribeEngine = "api" | "faster_whisper";

export async function transcribe(
  file: File,
  options?: { language?: string; cleanUp?: boolean; displayName?: string; engine?: TranscribeEngine; signal?: AbortSignal }
): Promise<TranscribeApiResult> {
  const form = new FormData();
  form.append("audio", file);
  if (options?.language != null && options.language !== "") {
    form.append("language", options.language);
  }
  form.append("clean_up", options?.cleanUp !== false ? "true" : "false");
  if (options?.displayName != null && options.displayName.trim() !== "") {
    form.append("display_name", options.displayName.trim());
  }
  if (options?.engine != null) {
    form.append("engine", options.engine);
  }
  const res = await fetch(`${API_BASE}/api/transcribe`, {
    method: "POST",
    headers: getApiHeaders(),
    body: form,
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Transcription failed"));
  }
  return res.json();
}

export type TranscribeChunkProgress = { current: number; total: number; filename: string };

export async function transcribeByUploadIdsStream(
  uploadIds: string[],
  onProgress: (current: number, total: number, filename: string) => void,
  options?: { cleanupFailed?: boolean; language?: string; cleanUp?: boolean; displayName?: string; engine?: TranscribeEngine; signal?: AbortSignal }
): Promise<TranscribeApiResult> {
  const form = new FormData();
  uploadIds.forEach((id) => form.append("upload_ids", id));
  form.append("cleanup_failed", options?.cleanupFailed === true ? "true" : "false");
  if (options?.language != null && options.language !== "") {
    form.append("language", options.language);
  }
  form.append("clean_up", options?.cleanUp !== false ? "true" : "false");
  if (options?.displayName != null && options.displayName.trim() !== "") {
    form.append("display_name", options.displayName.trim());
  }
  if (options?.engine != null) {
    form.append("engine", options.engine);
  }
  const res = await fetch(`${API_BASE}/api/transcribe/stream`, {
    method: "POST",
    headers: getApiHeaders(),
    body: form,
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Transcription failed"));
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TranscribeApiResult | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as {
          type: string;
          current?: number;
          total?: number;
          filename?: string;
          text?: string;
          failed_chunk_ids?: string[] | null;
          text_segments?: string[] | null;
          failed_chunk_indices?: number[] | null;
          detail?: string;
        };
        if (item.type === "progress" && item.current != null && item.total != null && item.filename != null) {
          onProgress(item.current, item.total, item.filename);
        } else if (item.type === "result") {
          result = {
            text: item.text ?? "",
            failed_chunk_ids: item.failed_chunk_ids ?? null,
            text_segments: item.text_segments ?? null,
            failed_chunk_indices: item.failed_chunk_indices ?? null,
          };
        } else if (item.type === "error") {
          throw new Error(sanitizeErrorMessage(item.detail ?? "Transcription failed", "Transcription failed"));
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    try {
      const item = JSON.parse(buffer.trim()) as { type: string; text?: string; failed_chunk_ids?: string[] | null; text_segments?: string[] | null; failed_chunk_indices?: number[] | null; detail?: string };
      if (item.type === "result") {
        result = { text: item.text ?? "", failed_chunk_ids: item.failed_chunk_ids ?? null, text_segments: item.text_segments ?? null, failed_chunk_indices: item.failed_chunk_indices ?? null };
      } else if (item.type === "error") {
        throw new Error(sanitizeErrorMessage(item.detail ?? "Transcription failed", "Transcription failed"));
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  if (!result) throw new Error("Transcription failed");
  return result;
}

/** Transcription history list item (metadata only). */
export interface TranscriptionListItem {
  id: string;
  created_at: number | null;
  display_name: string;
}

/** Full transcription for get/download. */
export interface TranscriptionDetail {
  id: string;
  created_at: number | null;
  display_name: string;
  text: string;
  meta: Record<string, unknown> | null;
}

export async function listTranscriptions(
  options?: { limit?: number; offset?: number; signal?: AbortSignal }
): Promise<TranscriptionListItem[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const res = await fetch(
    `${API_BASE}/api/transcriptions?limit=${Math.min(100, Math.max(1, limit))}&offset=${Math.max(0, offset)}`,
    {
      headers: getApiHeaders(),
      signal: options?.signal,
    }
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "List transcriptions failed"));
  }
  return res.json();
}

export async function getTranscription(
  transcriptionId: string,
  options?: { signal?: AbortSignal }
): Promise<TranscriptionDetail> {
  const res = await fetch(`${API_BASE}/api/transcriptions/${encodeURIComponent(transcriptionId)}`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Get transcription failed"));
  }
  return res.json();
}

export async function deleteTranscription(
  transcriptionId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/transcriptions/${encodeURIComponent(transcriptionId)}`, {
    method: "DELETE",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(await getErrorMessageFromResponse(res, "Delete transcription failed"));
  }
}

export interface TranslateResponse {
  text: string;
}

/** Translation history list item (metadata only). */
export interface TranslationListItem {
  id: string;
  created_at: number | null;
  display_name: string;
}

/** Full translation for get/download. */
export interface TranslationDetail {
  id: string;
  created_at: number | null;
  display_name: string;
  text: string;
  meta?: Record<string, unknown> | null;
}

export async function saveTranslation(
  displayName: string,
  text: string,
  options?: { signal?: AbortSignal }
): Promise<TranslationListItem> {
  const res = await jsonPost(
    `${API_BASE}/api/translations`,
    { display_name: displayName, text },
    options
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Save translation failed"));
  }
  return res.json();
}

export async function listTranslations(
  options?: { limit?: number; offset?: number; signal?: AbortSignal }
): Promise<TranslationListItem[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const res = await fetch(
    `${API_BASE}/api/translations?limit=${Math.min(100, Math.max(1, limit))}&offset=${Math.max(0, offset)}`,
    {
      headers: getApiHeaders(),
      signal: options?.signal,
    }
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "List translations failed"));
  }
  return res.json();
}

export async function getTranslation(
  translationId: string,
  options?: { signal?: AbortSignal }
): Promise<TranslationDetail> {
  const res = await fetch(`${API_BASE}/api/translations/${encodeURIComponent(translationId)}`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Get translation failed"));
  }
  return res.json();
}

export async function deleteTranslation(
  translationId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/translations/${encodeURIComponent(translationId)}`, {
    method: "DELETE",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(await getErrorMessageFromResponse(res, "Delete translation failed"));
  }
}

/** Summary history list item (metadata only). */
export interface SummaryListItem {
  id: string;
  created_at: number | null;
  display_name: string;
}

/** Full summary for get/download. */
export interface SummaryDetail {
  id: string;
  created_at: number | null;
  display_name: string;
  text: string;
  meta?: Record<string, unknown> | null;
}

export async function saveSummary(
  displayName: string,
  text: string,
  options?: { signal?: AbortSignal }
): Promise<SummaryListItem> {
  const res = await jsonPost(
    `${API_BASE}/api/summaries`,
    { display_name: displayName, text },
    options
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Save summary failed"));
  }
  return res.json();
}

export async function listSummaries(
  options?: { limit?: number; offset?: number; signal?: AbortSignal }
): Promise<SummaryListItem[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const res = await fetch(
    `${API_BASE}/api/summaries?limit=${Math.min(100, Math.max(1, limit))}&offset=${Math.max(0, offset)}`,
    { headers: getApiHeaders(), signal: options?.signal }
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "List summaries failed"));
  }
  return res.json();
}

export async function getSummary(
  summaryId: string,
  options?: { signal?: AbortSignal }
): Promise<SummaryDetail> {
  const res = await fetch(`${API_BASE}/api/summaries/${encodeURIComponent(summaryId)}`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Get summary failed"));
  }
  return res.json();
}

export async function deleteSummary(
  summaryId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/summaries/${encodeURIComponent(summaryId)}`, {
    method: "DELETE",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(await getErrorMessageFromResponse(res, "Delete summary failed"));
  }
}

/** Restructured article history list item (metadata only). */
export interface ArticleListItem {
  id: string;
  created_at: number | null;
  display_name: string;
  notion_url?: string | null;
}

/** Full restructured article for get/download. */
export interface ArticleDetail {
  id: string;
  created_at: number | null;
  display_name: string;
  text: string;
  notion_url?: string | null;
}

export async function saveArticle(
  displayName: string,
  text: string,
  options?: { signal?: AbortSignal }
): Promise<ArticleListItem> {
  const res = await jsonPost(
    `${API_BASE}/api/articles`,
    { display_name: displayName, text },
    options
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Save article failed"));
  }
  return res.json();
}

export async function listArticles(
  options?: { limit?: number; offset?: number; signal?: AbortSignal }
): Promise<ArticleListItem[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const res = await fetch(
    `${API_BASE}/api/articles?limit=${Math.min(100, Math.max(1, limit))}&offset=${Math.max(0, offset)}`,
    { headers: getApiHeaders(), signal: options?.signal }
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "List articles failed"));
  }
  return res.json();
}

export async function getArticle(
  articleId: string,
  options?: { signal?: AbortSignal }
): Promise<ArticleDetail> {
  const res = await fetch(`${API_BASE}/api/articles/${encodeURIComponent(articleId)}`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Get article failed"));
  }
  return res.json();
}

export async function deleteArticle(
  articleId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/articles/${encodeURIComponent(articleId)}`, {
    method: "DELETE",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(await getErrorMessageFromResponse(res, "Delete article failed"));
  }
}

export interface ArticleNotionExportResponse {
  notion_page_id: string | null;
  notion_url: string | null;
}

export type NotionDatabaseKey = "main" | "alt";

export async function exportArticleToNotion(
  articleId: string,
  database: NotionDatabaseKey,
  options?: { signal?: AbortSignal }
): Promise<ArticleNotionExportResponse> {
  const res = await jsonPost(
    `${API_BASE}/api/articles/${encodeURIComponent(articleId)}/notion`,
    { database },
    options
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Export article to Notion failed"));
  }
  return res.json();
}

export interface SummarizeResponse {
  text: string;
}

export type SummarizeEngine = "api" | "local";

export async function summarize(
  text: string,
  options?: { signal?: AbortSignal; engine?: SummarizeEngine }
): Promise<SummarizeResponse> {
  const body: { text: string; engine?: SummarizeEngine } = { text };
  if (options?.engine !== undefined) body.engine = options.engine;
  const res = await jsonPost(
    `${API_BASE}/api/summarize`,
    body,
    { signal: options?.signal }
  );
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Summary failed"));
  }
  return res.json();
}

export type TranslateEngine = "api" | "local";

export async function translate(
  textOrSegments: string | string[],
  targetLang: string,
  options?: { signal?: AbortSignal; engine?: TranslateEngine }
): Promise<TranslateResponse> {
  const body: { text?: string; segments?: string[]; target_lang: string; engine?: TranslateEngine } = {
    target_lang: targetLang,
  };
  if (Array.isArray(textOrSegments)) {
    body.segments = textOrSegments;
  } else {
    body.text = textOrSegments;
  }
  if (options?.engine !== undefined) body.engine = options.engine;
  const res = await fetch(`${API_BASE}/api/translate`, {
    method: "POST",
    headers: { ...getApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Translation failed"));
  }
  return res.json();
}

export interface PodcastRssResponse {
  feedUrl: string;
}

export interface PodcastFeedAudioItem {
  url: string;
  title?: string | null;
  pub_date?: string | null;
}

export async function getPodcastFeedAudioLinks(
  feedUrl: string,
  options?: { signal?: AbortSignal }
): Promise<PodcastFeedAudioItem[]> {
  const res = await fetch(
    `${API_BASE}/api/podcast/feed/audio-links?${new URLSearchParams({ feed_url: feedUrl }).toString()}`,
    {
      headers: getApiHeaders(),
      signal: options?.signal,
    }
  );
  if (!res.ok) {
    const msg = await getErrorMessageFromResponse(res, "Fetch audio links failed");
    throw new Error(msg);
  }
  return res.json();
}

export async function getPodcastRss(
  link: string,
  options?: { signal?: AbortSignal }
): Promise<PodcastRssResponse> {
  const url = `${API_BASE}/api/podcast/rss?${new URLSearchParams({ link: link.trim() }).toString()}`;
  const res = await fetch(url, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    const msg = await getErrorMessageFromResponse(res, "Get RSS failed");
    throw new Error(msg);
  }
  return res.json();
}

export function downloadPodcastEpisodeAudio(audioUrl: string, filename: string): void {
  const url = `${API_BASE}/api/podcast/download?${new URLSearchParams({
    url: audioUrl,
    filename,
  }).toString()}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export interface PodcastListItem {
  id: string;
  created_at: number | null;
  name: string;
  link: string;
  rss: string | null;
}

export interface PodcastSaveResponse {
  id: string;
  created_at: number | null;
  name: string;
  link: string;
  rss: string | null;
}

export async function listPodcasts(options?: { signal?: AbortSignal }): Promise<PodcastListItem[]> {
  const res = await fetch(`${API_BASE}/api/podcasts?limit=100&offset=0`, {
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "List podcasts failed"));
  }
  return res.json();
}

export async function savePodcast(
  name: string,
  link: string,
  options?: { signal?: AbortSignal }
): Promise<PodcastSaveResponse> {
  const res = await fetch(`${API_BASE}/api/podcasts`, {
    method: "POST",
    headers: { ...getApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), link: link.trim() }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Save podcast failed"));
  }
  return res.json();
}

export async function updatePodcast(
  podcastId: string,
  name: string,
  link: string,
  options?: { signal?: AbortSignal }
): Promise<PodcastSaveResponse> {
  const res = await fetch(`${API_BASE}/api/podcasts/${encodeURIComponent(podcastId)}`, {
    method: "PUT",
    headers: { ...getApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), link: link.trim() }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Update podcast failed"));
  }
  return res.json();
}

export async function updatePodcastRss(
  podcastId: string,
  rss: string,
  options?: { signal?: AbortSignal }
): Promise<PodcastListItem> {
  const res = await fetch(`${API_BASE}/api/podcasts/${encodeURIComponent(podcastId)}`, {
    method: "PATCH",
    headers: { ...getApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ rss }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Update podcast RSS failed"));
  }
  return res.json();
}

export async function deletePodcast(
  podcastId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/podcasts/${encodeURIComponent(podcastId)}`, {
    method: "DELETE",
    headers: getApiHeaders(),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Delete podcast failed"));
  }
}
