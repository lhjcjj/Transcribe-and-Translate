/**
 * Backend API client. Uses relative /api in dev (Vite proxy) or VITE_API_BASE in build.
 * No API keys or secrets here; all auth is on the backend.
 */
const BASE = (typeof import.meta !== "undefined" && (import.meta as ImportMeta).env?.VITE_API_BASE) || "";

async function doFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return res;
}

export async function transcribe(file: File): Promise<{ text: string }> {
  const form = new FormData();
  form.append("audio", file);
  const res = await fetch(`${BASE}/api/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail || res.statusText || "Transcription failed");
  }
  return res.json();
}

export async function translate(text: string, targetLang: string): Promise<{ text: string }> {
  const res = await doFetch("/api/translate", {
    method: "POST",
    body: JSON.stringify({ text, target_lang: targetLang }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail || res.statusText || "Translation failed");
  }
  return res.json();
}
