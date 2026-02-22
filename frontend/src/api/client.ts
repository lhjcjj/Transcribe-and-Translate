/**
 * Backend API client. Uses relative /api in dev (Vite proxy) or VITE_API_BASE in build.
 * No API keys or secrets here; all auth is on the backend.
 */
const API_BASE = (typeof import.meta !== "undefined" && (import.meta as ImportMeta).env?.VITE_API_BASE) || "";

async function getErrorMessageFromResponse(res: Response, defaultMessage: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    return body.detail ?? res.statusText ?? defaultMessage;
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
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort);
    const done = (fn: () => void) => () => {
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({
          loaded: e.loaded,
          total: e.total,
          percent: Math.min(99, Math.round((e.loaded / e.total) * 100)),
        });
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { upload_id: string; duration_seconds?: number | null };
          done(() => resolve(data))();
        } catch {
          done(() => reject(new Error("Invalid response")))();
        }
      } else {
        let detail = xhr.statusText;
        try {
          const body = JSON.parse(xhr.responseText) as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {
          // ignore
        }
        done(() => reject(new Error(detail || "Upload failed")))();
      }
    });
    xhr.addEventListener("error", done(() => reject(new Error("Network error"))));
    xhr.addEventListener("abort", done(() => reject(new DOMException("Aborted", "AbortError"))));
    xhr.open("POST", `${API_BASE}/api/upload`);
    xhr.send(form);
  });
}

export async function deleteUpload(uploadId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/upload/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
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

export async function getUploadDuration(uploadId: string): Promise<{ duration_seconds: number }> {
  const res = await fetch(`${API_BASE}/api/upload/${encodeURIComponent(uploadId)}/duration`);
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
    headers: { "Content-Type": "application/json" },
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
      state.errorDetail = item.detail ?? defaultError;
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
        state.errorDetail = item.detail ?? defaultError;
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
export async function cancelSplitStream(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/split/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 204) {
    throw new Error(res.statusText || "Cancel split failed");
  }
}

async function jsonPost(path: string, body: object): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface TranscribeResult {
  text: string;
  failed_chunk_ids?: string[] | null;
  text_segments?: string[] | null;
  failed_chunk_indices?: number[] | null;
}

export async function transcribe(
  file: File,
  options?: { language?: string; cleanUp?: boolean }
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("audio", file);
  if (options?.language != null && options.language !== "") {
    form.append("language", options.language);
  }
  form.append("clean_up", options?.cleanUp !== false ? "true" : "false");
  const res = await fetch(`${API_BASE}/api/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Transcription failed"));
  }
  return res.json();
}

export async function transcribeByUploadIds(
  uploadIds: string[],
  options?: { cleanupFailed?: boolean }
): Promise<TranscribeResult> {
  const form = new FormData();
  uploadIds.forEach((id) => form.append("upload_ids", id));
  form.append("cleanup_failed", options?.cleanupFailed === true ? "true" : "false");
  const res = await fetch(`${API_BASE}/api/transcribe`, {
    method: "POST",
    body: form,
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
  options?: { cleanupFailed?: boolean; language?: string; cleanUp?: boolean }
): Promise<TranscribeResult> {
  const form = new FormData();
  uploadIds.forEach((id) => form.append("upload_ids", id));
  form.append("cleanup_failed", options?.cleanupFailed === true ? "true" : "false");
  if (options?.language != null && options.language !== "") {
    form.append("language", options.language);
  }
  form.append("clean_up", options?.cleanUp !== false ? "true" : "false");
  const res = await fetch(`${API_BASE}/api/transcribe/stream`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Transcription failed"));
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let result: TranscribeResult | null = null;
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
          throw new Error(item.detail ?? "Transcription failed");
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
        throw new Error(item.detail ?? "Transcription failed");
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  if (!result) throw new Error("Transcription failed");
  return result;
}

export async function translate(text: string, targetLang: string): Promise<{ text: string }> {
  const res = await jsonPost("/api/translate", { text, target_lang: targetLang });
  if (!res.ok) {
    throw new Error(await getErrorMessageFromResponse(res, "Translation failed"));
  }
  return res.json();
}
