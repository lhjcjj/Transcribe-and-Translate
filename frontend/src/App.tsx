import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import {
  cancelSplitStream,
  deleteArticle,
  deleteSummary,
  deleteTranscription,
  deleteTranslation,
  deleteUpload,
  getArticle,
  getSummary,
  getTranscription,
  getTranslation,
  deletePodcast,
  getPodcastFeedAudioLinks,
  getPodcastRss,
  listPodcasts,
  savePodcast,
  updatePodcast,
  updatePodcastRss,
  getUploadConfig,
  checkUploadExists,
  getUploadDuration,
  listSummaries,
  listTranscriptions,
  listTranslations,
  listArticles,
  saveSummary,
  saveTranslation,
  saveArticle,
  summarize,
  transcribe,
  transcribeByUploadIdsStream,
  translate,
  upload,
  uploadFromUrl,
  TranscribeApiResult,
  TranscribeEngine,
  TranscriptionListItem,
  TranslationListItem,
  SummaryListItem,
  ArticleListItem,
  exportArticleToNotion,
  downloadPodcastEpisodeAudio,
} from "./api/client";
import deleteIcon from "./assets/icons/delete-icon.svg";
import downloadIcon from "./assets/icons/download-icon.svg";
import uploadIcon from "./assets/icons/upload-icon.svg";
import splitIcon from "./assets/icons/split-icon.svg";
import transcribeIcon from "./assets/icons/transcribe-icon.svg";
import summarizeIcon from "./assets/icons/summarize-icon.svg";
import translateIcon from "./assets/icons/translate-icon.svg";
import notionIcon from "./assets/icons/notion-icon.svg";
import podcastsIcon from "./assets/icons/podcasts-icon.svg";
import addIcon from "./assets/icons/add-icon.svg";
import editIcon from "./assets/icons/edit-icon.svg";
import saveIcon from "./assets/icons/save-icon.svg";
import previewIcon from "./assets/icons/preview-icon.svg";
import rssIcon from "./assets/icons/rss-icon.svg";
import rssInlineIcon from "./assets/icons/RSS-inline-icon.svg";
import newsIcon from "./assets/icons/news-icon.svg";
import linkIcon from "./assets/icons/link-icon.svg";
import { FileUpload } from "./components/FileUpload";
import { TranscribeResult } from "./components/TranscribeResult";
import { useSplitFlow } from "./hooks/useSplitFlow";

/** UI display threshold (MB): show split hint when file exceeds this. Actual limit from API. */
const DISPLAY_SPLIT_THRESHOLD_MB = 25;
/** UI display cap (MB): show ">N MB" when file exceeds this. Actual limit from API. */
const DISPLAY_UPLOAD_MAX_MB = 300;

/** Chunk size input clamp (minutes). */
const CHUNK_SIZE_MIN = 1;
const CHUNK_SIZE_MAX = 10;
/** Max length of chunk size input (digits). */
const CHUNK_INPUT_MAX_LENGTH = 2;

/** Max attempts for duration fetch after upload. */
const DURATION_FETCH_MAX_ATTEMPTS = 2;

/** Debounce delay (ms) for chunk size input. */
const CHUNK_SIZE_DEBOUNCE_MS = 300;

/** Delay (ms) before revoking download blob URL so the browser can start the download. */
const DOWNLOAD_REVOKE_DELAY_MS = 200;

/** Log error message; in dev only also log detail to avoid leaking in production. */
function reportError(message: string, err?: unknown): void {
  console.error(message);
  if (import.meta.env.DEV && err != null) console.error(err);
}

async function deleteUploadIds(
  ids: string[] | null,
  signal?: AbortSignal
): Promise<void> {
  if (!ids?.length) return;
  await Promise.allSettled(ids.map((id) => deleteUpload(id, { signal })));
}

function clampChunkInput(raw: string): string {
  if (raw === "") return "";
  const n = parseInt(raw, 10);
  if (n > CHUNK_SIZE_MAX) return String(CHUNK_SIZE_MAX);
  if (n < CHUNK_SIZE_MIN) return String(CHUNK_SIZE_MIN);
  return raw;
}

/** Split a long line into chunks of at most maxLen (for PDF fallback when splitTextToSize is unavailable). */
function matchChunks(line: string, maxLen: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += maxLen) out.push(line.slice(i, i + maxLen));
  return out;
}

/** Base name for download file: upload file name without extension, or "transcribe" if none. Sanitized for filesystem. */
function downloadBaseName(uploadFileName: string): string {
  const base = uploadFileName.trim() || "transcribe";
  const lastDot = base.lastIndexOf(".");
  const nameWithoutExt = lastDot > 0 ? base.slice(0, lastDot) : base;
  return nameWithoutExt.replace(/[/\\:*?"<>|]/g, "_") || "transcribe";
}

/** Format Unix timestamp (seconds) as yyyy-mm-dd hh:mm:ss. Returns empty string if null. */
function formatCreatedAt(createdAt: number | null): string {
  if (createdAt == null) return "";
  const d = new Date(createdAt * 1000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${min}:${s}`;
}

/** Format RSS/ISO pub_date string as yyyy-mm-dd hh:mm:ss. Returns "-" if null/empty or unparseable. */
function formatPubDate(pubDate: string | null | undefined): string {
  if (pubDate == null || String(pubDate).trim() === "") return "-";
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return "-";
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${min}:${s}`;
}

/** Format duration in seconds as hh:mm:ss. */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Format file size in bytes as human-readable string (e.g. "50.0 MB"). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Remove common audio/file extensions from display name (e.g. .mp3, .wav). */
function stripDisplayNameExtension(name: string): string {
  if (!name || typeof name !== "string") return name;
  return name.replace(/\.(mp3|wav|m4a|flac|ogg|webm|mp4|aac|opus|wma)$/i, "");
}

/** Suggested filename for podcast episode download: sanitized title + extension from URL. */
function podcastEpisodeDownloadName(title: string | null | undefined, url: string): string {
  const base = (title || "episode").trim().replace(/[/\\:*?"<>|]/g, "_").slice(0, 120) || "episode";
  const pathname = url.split("?")[0];
  const ext = pathname.includes(".") ? pathname.slice(pathname.lastIndexOf(".")) : ".mp3";
  return `${base}${ext}`;
}

/** True if string contains CJK or other characters not in Helvetica's repertoire (e.g. Chinese). */
function hasCjkOrNonLatin(text: string): boolean {
  return /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/.test(text);
}

/** Wrap text into lines that fit within maxWidthPx when measured with ctx. */
function wrapTextToLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidthPx: number
): string[] {
  const lines: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    const rawLines = para.split(/\n/);
    for (const raw of rawLines) {
      if (maxWidthPx <= 0) {
        lines.push(raw);
        continue;
      }
      let line = "";
      for (const char of raw) {
        const next = line + char;
        if (ctx.measureText(next).width <= maxWidthPx) {
          line = next;
        } else {
          if (line) lines.push(line);
          line = char;
        }
      }
      if (line) lines.push(line);
    }
    if (lines.length > 0 && paragraphs.indexOf(para) < paragraphs.length - 1) lines.push("");
  }
  return lines;
}

/** 1 pt = 25.4/72 mm (points to mm for canvas scaling). */
const PT_TO_MM = 25.4 / 72;

/** Draw one PDF page of text onto a canvas (for CJK support). Returns canvas. Font sizes in pt to match English PDF. */
function drawPdfPageToCanvas(
  pageLines: string[],
  opts: {
    pageWidthMm: number;
    pageHeightMm: number;
    marginMm: number;
    titleLines?: string[];
    titleFontSizePt: number;
    bodyFontSizePt: number;
    lineHeightMm: number;
    scale?: number;
  }
): HTMLCanvasElement {
  const scale = opts.scale ?? 2;
  const pxPerMm = (595.28 / opts.pageWidthMm) * scale;
  const canvas = document.createElement("canvas");
  canvas.width = opts.pageWidthMm * pxPerMm;
  canvas.height = opts.pageHeightMm * pxPerMm;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  const marginPx = opts.marginMm * pxPerMm;
  const lineHeightPx = opts.lineHeightMm * pxPerMm;
  const titleFontPx = opts.titleFontSizePt * PT_TO_MM * pxPerMm;
  const bodyFontPx = opts.bodyFontSizePt * PT_TO_MM * pxPerMm;
  const fontFamily = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif';
  let y = marginPx;

  if (opts.titleLines?.length) {
    ctx.font = `bold ${titleFontPx}px ${fontFamily}`;
    for (const titleLine of opts.titleLines) {
      ctx.fillText(titleLine, marginPx, y);
      y += lineHeightPx;
    }
    y += lineHeightPx;
  }

  ctx.font = `${bodyFontPx}px ${fontFamily}`;
  for (const line of pageLines) {
    if (y > canvas.height - marginPx) break;
    ctx.fillText(line, marginPx, y);
    y += lineHeightPx;
  }

  return canvas;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function App() {
  const [langOption, setLangOption] = useState<"auto" | "en" | "zh">("auto");
  const [cleanOption, setCleanOption] = useState<"yes" | "no">("yes");
  const [translateOption, setTranslateOption] = useState<"en-cn" | "cn-en">("en-cn");
  const [transcribeHistoryOpen, setTranscribeHistoryOpen] = useState(true);
  const [translateHistoryOpen, setTranslateHistoryOpen] = useState(true);
  const [summarizeHistoryOpen, setSummarizeHistoryOpen] = useState(true);
  const [restructureHistoryOpen, setRestructureHistoryOpen] = useState(true);
  const [uploadFileName, setUploadFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  /** File size in bytes when current upload is from episode (RSS length_bytes); used to show MB in step 1. */
  const [uploadSizeBytes, setUploadSizeBytes] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadingEpisodeUrl, setUploadingEpisodeUrl] = useState<string | null>(null);
  /** Episode URL -> { uploadedAt, uploadId }. Upload expires after uploadTtlMs or if server deletes file; then button re-enables. */
  const [uploadedEpisodeUrls, setUploadedEpisodeUrls] = useState<Map<string, { uploadedAt: number; uploadId: string }>>(new Map());
  /** When user deletes/clears this upload, we remove that episode from uploadedEpisodeUrls so the button re-enables. */
  const [uploadIdToEpisodeUrl, setUploadIdToEpisodeUrl] = useState<Map<string, string>>(new Map());
  const episodeUploadIdRef = useRef<string | null>(null);
  const [uploadTtlMs, setUploadTtlMs] = useState<number>(3600 * 1000); // default 1h; from backend config
  const [chunkSizeInput, setChunkSizeInput] = useState("5");
  const chunkSizeDebounced = useDebouncedValue(chunkSizeInput, CHUNK_SIZE_DEBOUNCE_MS);
  const [splitChunkIds, setSplitChunkIds] = useState<string[] | null>(null);
  const [uploadDurationSeconds, setUploadDurationSeconds] = useState<number | null>(null);
  const [confirmCancelType, setConfirmCancelType] = useState<"upload" | "split" | null>(null);
  const [isDeletingUpload, setIsDeletingUpload] = useState(false);
  const [isCancellingSplit, setIsCancellingSplit] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeText, setTranscribeText] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [transcribeSegments, setTranscribeSegments] = useState<string[] | null>(null);
  const [failedChunkIds, setFailedChunkIds] = useState<string[] | null>(null);
  const [failedChunkIndices, setFailedChunkIndices] = useState<number[] | null>(null);
  const [transcribeChunkProgress, setTranscribeChunkProgress] = useState<{
    current: number;
    total: number;
    filename: string;
  } | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  /** When set, download dialog is for this history item (PDF/TXT); when null, for current transcribe result. */
  const [pendingTranscriptionDownload, setPendingTranscriptionDownload] = useState<TranscriptionListItem | null>(null);
  const [pendingDeleteTranscriptionItem, setPendingDeleteTranscriptionItem] = useState<TranscriptionListItem | null>(null);
  const [transcribeHistoryItems, setTranscribeHistoryItems] = useState<TranscriptionListItem[]>([]);
  const [transcribeHistoryLoading, setTranscribeHistoryLoading] = useState(false);
  const [transcribeHistoryLoadingMore, setTranscribeHistoryLoadingMore] = useState(false);
  const [transcribeHistoryHasMore, setTranscribeHistoryHasMore] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const apiAbortRef = useRef<AbortController | null>(null);
  const configAbortRef = useRef<AbortController | null>(null);
  const durationAbortRef = useRef<AbortController | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const uploadGenerationRef = useRef(0);
  const downloadRevokeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSplitDelayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);
  /** Local vs API: applies to translation and summarize; transcribe always uses local for now. */
  const [selectedEngine, setSelectedEngine] = useState<"local" | "api">("api");
  const transcribeEngine: TranscribeEngine = "faster_whisper";
  const [translateResult, setTranslateResult] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [summarizeResult, setSummarizeResult] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);
  const [summarizeSource, setSummarizeSource] = useState<"all" | "transcript" | "translation">("all");
  /** Translation history: list of { id, display_name, created_at, text } (client-side only). */
  const [translateHistoryItems, setTranslateHistoryItems] = useState<TranslationListItem[]>([]);
  const [pendingTranslationDownload, setPendingTranslationDownload] = useState<TranslationListItem | null>(null);
  const [pendingDeleteTranslationItem, setPendingDeleteTranslationItem] = useState<TranslationListItem | null>(null);
  /** Summary history: same pattern as translation (list from API, get for download, delete from API). */
  const [summarizeHistoryItems, setSummarizeHistoryItems] = useState<SummaryListItem[]>([]);
  const [pendingSummaryDownload, setPendingSummaryDownload] = useState<SummaryListItem | null>(null);
  const [pendingDeleteSummaryItem, setPendingDeleteSummaryItem] = useState<SummaryListItem | null>(null);
  const [pendingDeleteArticleItem, setPendingDeleteArticleItem] = useState<ArticleListItem | null>(null);
  const [pendingArticleDownload, setPendingArticleDownload] = useState<ArticleListItem | null>(null);
  /** Restructure history: list from API (articles). */
  const [restructureHistoryItems, setRestructureHistoryItems] = useState<ArticleListItem[]>([]);
  /** Sub-nav active tab: which item has sub-nav-active class. */
  const [subNavActive, setSubNavActive] = useState<"home" | "get-info" | "transcribe">("get-info");
  type PodcastRow = { id: string; name: string; link: string; rss?: string | null; inputsDisabled: boolean; showValidationError: boolean };
  const [podcastRows, setPodcastRows] = useState<PodcastRow[]>([{ id: "new-0", name: "", link: "", inputsDisabled: false, showValidationError: false }]);
  useEffect(() => {
    if (subNavActive !== "get-info") return;
    listPodcasts()
      .then((items) => {
        if (items.length === 0) return;
        setPodcastRows(
          items.map((p) => ({
            id: p.id,
            name: p.name,
            link: p.link,
            rss: p.rss ?? undefined,
            inputsDisabled: true,
            showValidationError: false,
          }))
        );
      })
      .catch(() => {});
  }, [subNavActive]);
  /** When set, show "Choose translation direction." dialog for this transcription history item. */
  const [pendingTranslateFromHistoryItem, setPendingTranslateFromHistoryItem] = useState<TranscriptionListItem | null>(null);
  const [pendingSummarizeTranscriptionItem, setPendingSummarizeTranscriptionItem] = useState<TranscriptionListItem | null>(null);
  const [pendingSummarizeTranslationItem, setPendingSummarizeTranslationItem] = useState<TranslationListItem | null>(null);
  const [downloadSource, setDownloadSource] = useState<"transcription" | "translation" | "summary" | "restructure" | null>(null);
  const [restructureDialogOpen, setRestructureDialogOpen] = useState(false);
  const [restructureSelectedTranscriptionIds, setRestructureSelectedTranscriptionIds] = useState<string[]>([]);
  const [restructureSelectedTranslationIds, setRestructureSelectedTranslationIds] = useState<string[]>([]);
  const [restructureSelectedSummaryIds, setRestructureSelectedSummaryIds] = useState<string[]>([]);
  const [restructureResultFilesLabel, setRestructureResultFilesLabel] = useState("");
  const [isRestructuring, setIsRestructuring] = useState(false);
  const [restructureResultText, setRestructureResultText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [podcastPreviewOpen, setPodcastPreviewOpen] = useState(false);
  const [podcastPreviewFeedUrl, setPodcastPreviewFeedUrl] = useState<string>("");
  const [podcastPreviewLoading, setPodcastPreviewLoading] = useState(false);
  const [podcastPreviewLinks, setPodcastPreviewLinks] = useState<{ url: string; title?: string | null; pub_date?: string | null; duration_seconds?: number | null; length_bytes?: number | null }[]>([]);
  const [podcastPreviewSelectedIndices, setPodcastPreviewSelectedIndices] = useState<number[]>([]);
  const [podcastPreviewNewUrls, setPodcastPreviewNewUrls] = useState<Set<string>>(new Set());
  const PODCAST_PREVIEW_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
  const PODCAST_PREVIEW_NEW_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours for "new" badge
  const PODCAST_PREVIEW_NEW_STORAGE_KEY = "podcast-preview-new-episodes";
  const podcastPreviewCacheRef = useRef<{ feedUrl: string; links: { url: string; title?: string | null; pub_date?: string | null; duration_seconds?: number | null; length_bytes?: number | null }[]; cachedAt: number } | null>(null);

  const getStoredNewUrlsForFeed = (feedUrl: string, currentLinkUrls: string[]): Set<string> => {
    try {
      const raw = localStorage.getItem(PODCAST_PREVIEW_NEW_STORAGE_KEY);
      if (!raw) return new Set();
      const data = JSON.parse(raw) as Record<string, Record<string, number>>;
      const byFeed = data[feedUrl];
      if (!byFeed || typeof byFeed !== "object") return new Set();
      const now = Date.now();
      const out = new Set<string>();
      for (const url of currentLinkUrls) {
        const ts = byFeed[url];
        if (typeof ts === "number" && now - ts < PODCAST_PREVIEW_NEW_TTL_MS) out.add(url);
      }
      return out;
    } catch {
      return new Set();
    }
  };

  const persistNewUrlsForFeed = (feedUrl: string, newUrls: string[]): void => {
    if (newUrls.length === 0) return;
    try {
      const raw = localStorage.getItem(PODCAST_PREVIEW_NEW_STORAGE_KEY);
      const data: Record<string, Record<string, number>> = raw ? JSON.parse(raw) : {};
      if (!data[feedUrl]) data[feedUrl] = {};
      const now = Date.now();
      for (const url of newUrls) {
        const existing = data[feedUrl][url];
        if (existing == null || now - existing >= PODCAST_PREVIEW_NEW_TTL_MS) data[feedUrl][url] = now;
      }
      localStorage.setItem(PODCAST_PREVIEW_NEW_STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  };

  const hasNewEpisodesForFeed = (feedUrl: string): boolean => {
    if (!feedUrl?.trim()) return false;
    try {
      const raw = localStorage.getItem(PODCAST_PREVIEW_NEW_STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as Record<string, Record<string, number>>;
      const byFeed = data[feedUrl.trim()];
      if (!byFeed || typeof byFeed !== "object") return false;
      const now = Date.now();
      for (const ts of Object.values(byFeed)) {
        if (typeof ts === "number" && now - ts < PODCAST_PREVIEW_NEW_TTL_MS) return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const [pendingNotionArticleItem, setPendingNotionArticleItem] = useState<ArticleListItem | null>(null);

  const isAnyDialogOpen =
    confirmCancelType !== null ||
    previewOpen ||
    podcastPreviewOpen ||
    showDownloadDialog ||
    restructureDialogOpen ||
    pendingDeleteTranscriptionItem !== null ||
    pendingDeleteTranslationItem !== null ||
    pendingDeleteSummaryItem !== null ||
    pendingDeleteArticleItem !== null ||
    pendingNotionArticleItem !== null ||
    pendingSummarizeTranscriptionItem !== null ||
    pendingSummarizeTranslationItem !== null ||
    pendingTranslateFromHistoryItem !== null;

  useEffect(() => {
    if (isAnyDialogOpen) document.body.classList.add("dialog-open");
    else document.body.classList.remove("dialog-open");
    return () => document.body.classList.remove("dialog-open");
  }, [isAnyDialogOpen]);

  // If this component ever calls translate(), pass apiAbortRef.current?.signal so the request is aborted on unmount.
  useEffect(() => {
    apiAbortRef.current = new AbortController();
    return () => {
      uploadAbortRef.current?.abort();
      apiAbortRef.current?.abort();
      configAbortRef.current?.abort();
      durationAbortRef.current?.abort();
      transcribeAbortRef.current?.abort();
      if (downloadRevokeTimeoutRef.current) clearTimeout(downloadRevokeTimeoutRef.current);
      if (cancelSplitDelayTimeoutRef.current) clearTimeout(cancelSplitDelayTimeoutRef.current);
    };
  }, []);

  const HISTORY_PAGE_SIZE = 50;

  useEffect(() => {
    if (!transcribeHistoryOpen) return;
    setTranscribeHistoryLoading(true);
    setTranscribeHistoryHasMore(true);
    listTranscriptions({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => {
        setTranscribeHistoryItems(data);
        setTranscribeHistoryHasMore(data.length >= HISTORY_PAGE_SIZE);
      })
      .catch(() => setTranscribeHistoryItems([]))
      .finally(() => setTranscribeHistoryLoading(false));
  }, [transcribeHistoryOpen]);

  useEffect(() => {
    if (!translateHistoryOpen) return;
    listTranslations({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => setTranslateHistoryItems(data))
      .catch(() => setTranslateHistoryItems([]));
  }, [translateHistoryOpen]);

  useEffect(() => {
    if (!summarizeHistoryOpen) return;
    listSummaries({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => setSummarizeHistoryItems(data))
      .catch(() => setSummarizeHistoryItems([]));
  }, [summarizeHistoryOpen]);

  useEffect(() => {
    if (!restructureHistoryOpen) return;
    listArticles({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => setRestructureHistoryItems(data))
      .catch(() => setRestructureHistoryItems([]));
  }, [restructureHistoryOpen]);

  // After a successful transcribe, refresh history list if panel is open so the new item appears.
  useEffect(() => {
    if (!transcribeHistoryOpen || !transcribeText) return;
    listTranscriptions({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => {
        setTranscribeHistoryItems(data);
        setTranscribeHistoryHasMore(data.length >= HISTORY_PAGE_SIZE);
      })
      .catch(() => {});
  }, [transcribeHistoryOpen, transcribeText]);

  const handleTranscribeHistoryLoadMore = useCallback(() => {
    if (transcribeHistoryLoadingMore || !transcribeHistoryHasMore) return;
    setTranscribeHistoryLoadingMore(true);
    listTranscriptions({
      limit: HISTORY_PAGE_SIZE,
      offset: transcribeHistoryItems.length,
      signal: apiAbortRef.current?.signal,
    })
      .then((data) => {
        setTranscribeHistoryItems((prev) => [...prev, ...data]);
        setTranscribeHistoryHasMore(data.length >= HISTORY_PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setTranscribeHistoryLoadingMore(false));
  }, [transcribeHistoryLoadingMore, transcribeHistoryHasMore, transcribeHistoryItems.length]);

  useEffect(() => {
    const controller = new AbortController();
    configAbortRef.current = controller;
    getUploadConfig({ signal: controller.signal })
      .then((c) => {
        setMaxUploadBytes(c.max_upload_bytes);
        setUploadTtlMs((c.upload_ttl_seconds ?? 3600) * 1000);
      })
      .catch((err) => {
        // Ignore aborts (React strict mode mounts/unmounts effects).
        if (err instanceof DOMException && err.name === "AbortError") return;
        reportError("Failed to load upload config", err);
      })
      .finally(() => {
        configAbortRef.current = null;
      });
  }, []);

  /** True if this episode was uploaded and the upload has not yet expired (backend TTL). */
  const isEpisodeUploadValid = useCallback(
    (url: string) => {
      const entry = uploadedEpisodeUrls.get(url);
      return entry != null && Date.now() - entry.uploadedAt < uploadTtlMs;
    },
    [uploadedEpisodeUrls, uploadTtlMs]
  );

  useEffect(() => {
    if (!podcastPreviewOpen || uploadedEpisodeUrls.size === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setUploadedEpisodeUrls((prev) => {
        let changed = false;
        const next = new Map(prev);
        next.forEach((entry, url) => {
          if (now - entry.uploadedAt >= uploadTtlMs) {
            next.delete(url);
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }, 60 * 1000);
    return () => clearInterval(interval);
  }, [podcastPreviewOpen, uploadedEpisodeUrls.size, uploadTtlMs]);

  useEffect(() => {
    uploadIdRef.current = uploadId;
  }, [uploadId]);

  /** When episode dialog opens, probe server for each "uploaded" episode; remove if file was deleted (e.g. by admin). Skip the current main upload so we never treat a just-finished upload as deleted (avoids race / multi-instance 404). */
  useEffect(() => {
    if (!podcastPreviewOpen || podcastPreviewLinks.length === 0 || uploadedEpisodeUrls.size === 0) return;
    const controller = new AbortController();
    const links = podcastPreviewLinks;
    const mapSnapshot = new Map(uploadedEpisodeUrls);
    const currentId = uploadIdRef.current;
    const urlsToCheck = links.map((a) => a.url).filter((url) => mapSnapshot.has(url));
    if (urlsToCheck.length === 0) return;
    Promise.all(
      urlsToCheck.map(async (url): Promise<{ url: string; uploadId: string } | null> => {
        const entry = mapSnapshot.get(url);
        if (!entry || Date.now() - entry.uploadedAt >= uploadTtlMs) return null;
        if (entry.uploadId === currentId) return null;
        try {
          const exists = await checkUploadExists(entry.uploadId, { signal: controller.signal });
          if (!exists) return { url, uploadId: entry.uploadId };
        } catch {
          /* leave entry as-is on network error */
        }
        return null;
      })
    ).then((results) => {
      const toRemove = results.filter((r): r is { url: string; uploadId: string } => r != null);
      if (toRemove.length === 0) return;
      const removedIds = new Set(toRemove.map((r) => r.uploadId));
      const currentUploadId = uploadIdRef.current;
      const shouldResetMain = currentUploadId != null && removedIds.has(currentUploadId);
      setUploadedEpisodeUrls((prev) => {
        const next = new Map(prev);
        toRemove.forEach(({ url }) => next.delete(url));
        return next.size === prev.size ? prev : next;
      });
      setUploadIdToEpisodeUrl((prev) => {
        const next = new Map(prev);
        toRemove.forEach(({ uploadId }) => next.delete(uploadId));
        return next.size === prev.size ? prev : next;
      });
      if (shouldResetMain) {
        setUploadId(null);
        setUploadDurationSeconds(null);
        setUploadSizeBytes(null);
        setUploadFileName("");
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setSplitChunkIds(null);
        setFailedChunkIds(null);
        setFailedChunkIndices(null);
        setTranscribeSegments(null);
        setTranscribeText(null);
        setTranscribeError(null);
        episodeUploadIdRef.current = null;
      }
    });
    return () => controller.abort();
  }, [podcastPreviewOpen, podcastPreviewFeedUrl, podcastPreviewLinks, uploadedEpisodeUrls, uploadTtlMs]);

  const chunkSizeMin = useMemo(
    () =>
      Math.max(
        CHUNK_SIZE_MIN,
        Math.min(CHUNK_SIZE_MAX, parseInt(chunkSizeDebounced, 10) || 3)
      ),
    [chunkSizeDebounced]
  );
  const restructureSelectedCount = useMemo(
    () =>
      restructureSelectedTranscriptionIds.length +
      restructureSelectedTranslationIds.length +
      restructureSelectedSummaryIds.length,
    [
      restructureSelectedTranscriptionIds.length,
      restructureSelectedTranslationIds.length,
      restructureSelectedSummaryIds.length,
    ],
  );
  const clearUploadState = useCallback(() => {
    const id = episodeUploadIdRef.current;
    if (id) {
      episodeUploadIdRef.current = null;
      setUploadIdToEpisodeUrl((prev) => {
        const url = prev.get(id);
        if (url) setUploadedEpisodeUrls((u) => { const n = new Map(u); n.delete(url); return n; });
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
    setUploadId(null);
    setUploadDurationSeconds(null);
    setUploadSizeBytes(null);
  }, []);
  const clearFileSelection = useCallback(() => {
    setUploadFileName("");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const onSplitSuccess = useCallback(
    (chunks: { upload_id: string }[]) => {
      setSplitChunkIds(chunks.map((c) => c.upload_id));
      clearUploadState();
    },
    [clearUploadState]
  );
  const { split, isSplitting, splitProgress, splitAbortRef } = useSplitFlow(
    uploadId,
    chunkSizeMin,
    onSplitSuccess,
    clearUploadState
  );

  const hasFile = useMemo(() => Boolean(uploadFileName), [uploadFileName]);
  const isUploaded = useMemo(() => Boolean(uploadId), [uploadId]);
  const hasChunks = useMemo(
    () => splitChunkIds != null && splitChunkIds.length > 0,
    [splitChunkIds]
  );
  const fileSizeMB = useMemo(
    () =>
      selectedFile
        ? Math.round(selectedFile.size / (1024 * 1024))
        : uploadSizeBytes != null
          ? Math.round(uploadSizeBytes / (1024 * 1024))
          : null,
    [selectedFile, uploadSizeBytes]
  );
  const fileTooBig = useMemo(
    () =>
      selectedFile != null &&
      maxUploadBytes != null &&
      selectedFile.size > maxUploadBytes,
    [selectedFile, maxUploadBytes]
  );
  const fileOver25MB = useMemo(
    () => fileSizeMB != null && fileSizeMB > DISPLAY_SPLIT_THRESHOLD_MB,
    [fileSizeMB]
  );
  const uploadStepDisabled = useMemo(
    () =>
      isUploading ||
      isDeletingUpload ||
      isSplitting ||
      isCancellingSplit ||
      isTranscribing ||
      (isUploaded && uploadDurationSeconds == null),
    [isUploading, isDeletingUpload, isSplitting, isCancellingSplit, isTranscribing, isUploaded, uploadDurationSeconds]
  );
  const splitStepDisabled = useMemo(
    () =>
      isUploading ||
      !isUploaded ||
      isDeletingUpload ||
      uploadDurationSeconds == null ||
      (isTranscribing && !hasChunks),
    [isUploading, isUploaded, isDeletingUpload, uploadDurationSeconds, isTranscribing, hasChunks]
  );
  const canTranscribe = useMemo(
    () => hasChunks || (isUploaded && !fileOver25MB),
    [hasChunks, isUploaded, fileOver25MB]
  );
  const segmentCount = useMemo(
    () =>
      uploadDurationSeconds != null && chunkSizeMin > 0
        ? Math.ceil(uploadDurationSeconds / (chunkSizeMin * 60))
        : null,
    [uploadDurationSeconds, chunkSizeMin]
  );
  /** Progress 0–100 for chunks addon fill (1/6 → ~16.67, 2/6 → ~33.33, …). null = no fill. */
  const chunksAddonProgress = useMemo((): number | null => {
    if (isSplitting && splitProgress && splitProgress.total > 0) {
      return (splitProgress.current / splitProgress.total) * 100;
    }
    if (hasChunks && splitChunkIds?.length) return 100;
    if (segmentCount != null) return 0;
    return null;
  }, [isSplitting, splitProgress, hasChunks, splitChunkIds, segmentCount]);
  const fileSizeAddonSuffix = useMemo(
    () =>
      isUploading && uploadProgress != null
        ? `MB: ${uploadProgress}%`
        : isUploaded
          ? "MB: 100%"
          : "MB:%",
    [isUploading, uploadProgress, isUploaded]
  );
  const fileSizeAddon = useMemo(
    () =>
      fileSizeMB != null ? (
        <>
          {fileSizeMB > DISPLAY_UPLOAD_MAX_MB ? (
            <strong>&gt;{DISPLAY_UPLOAD_MAX_MB}</strong>
          ) : fileSizeMB > DISPLAY_SPLIT_THRESHOLD_MB ? (
            <strong>{fileSizeMB}</strong>
          ) : (
            fileSizeMB
          )}
          {"\u00A0"}
          {fileSizeAddonSuffix}
        </>
      ) : (
        fileSizeAddonSuffix
      ),
    [fileSizeMB, fileSizeAddonSuffix]
  );

  const deleteUploadAndClearUploadState = useCallback(
    async (idToDelete: string | null) => {
      if (idToDelete) {
        if (episodeUploadIdRef.current === idToDelete) episodeUploadIdRef.current = null;
        setUploadIdToEpisodeUrl((prev) => {
          const url = prev.get(idToDelete);
          if (url) setUploadedEpisodeUrls((u) => { const n = new Map(u); n.delete(url); return n; });
          const next = new Map(prev);
          next.delete(idToDelete);
          return next;
        });
        try {
          await deleteUpload(idToDelete, {
            signal: apiAbortRef.current?.signal ?? undefined,
          });
        } catch {
          /* ignore (e.g. 404 = already gone) */
        }
      }
      clearUploadState();
    },
    [clearUploadState]
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await deleteUploadIds(splitChunkIds, apiAbortRef.current?.signal ?? undefined);
      await deleteUploadIds(failedChunkIds, apiAbortRef.current?.signal ?? undefined);
      await deleteUploadAndClearUploadState(uploadId);
      setSplitChunkIds(null);
      setTranscribeText(null);
      setTranscribeError(null);
      setTranscribeSegments(null);
      setFailedChunkIds(null);
      setFailedChunkIndices(null);
      setTranscribeChunkProgress(null);
      setUploadFileName(file.name);
      setSelectedFile(file);
      e.target.value = "";
    },
    [splitChunkIds, failedChunkIds, uploadId, deleteUploadAndClearUploadState]
  );

  const handleClear = useCallback(
    async () => {
      await deleteUploadIds(splitChunkIds, apiAbortRef.current?.signal ?? undefined);
      await deleteUploadIds(failedChunkIds, apiAbortRef.current?.signal ?? undefined);
      setFailedChunkIds(null);
      await deleteUploadAndClearUploadState(uploadId);
      setSplitChunkIds(null);
      clearFileSelection();
    },
    [splitChunkIds, failedChunkIds, uploadId, deleteUploadAndClearUploadState, clearFileSelection]
  );

  const handleBrowse = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleConfirmCancel = useCallback(
    async () => {
      const type = confirmCancelType;
      setConfirmCancelType(null);
      if (type === "upload") {
        uploadAbortRef.current?.abort();
        setIsDeletingUpload(true);
        try {
          await deleteUploadAndClearUploadState(uploadId);
          clearFileSelection();
        } finally {
          setIsDeletingUpload(false);
        }
      } else if (type === "split") {
        setIsCancellingSplit(true);
        const minDelDisplayMs = 400;
        const startAt = Date.now();
        try {
          await cancelSplitStream({ signal: apiAbortRef.current?.signal ?? undefined });
        } catch (err) {
          reportError("Cancel split request failed", err);
        } finally {
          splitAbortRef.current?.abort();
          clearUploadState();
          const elapsed = Date.now() - startAt;
          const delay = Math.max(0, minDelDisplayMs - elapsed);
          if (delay > 0) {
            if (cancelSplitDelayTimeoutRef.current) clearTimeout(cancelSplitDelayTimeoutRef.current);
            cancelSplitDelayTimeoutRef.current = setTimeout(() => {
              cancelSplitDelayTimeoutRef.current = null;
              setIsCancellingSplit(false);
            }, delay);
          } else {
            setIsCancellingSplit(false);
          }
        }
      }
    },
    [confirmCancelType, uploadId, deleteUploadAndClearUploadState, clearFileSelection, clearUploadState]
  );

  const uploadFileToTranscribe = useCallback(
    async (file: File) => {
      uploadGenerationRef.current += 1;
      const uploadGeneration = uploadGenerationRef.current;
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setIsUploading(true);
      setUploadProgress(0);
      try {
        await deleteUploadIds(splitChunkIds, controller.signal);
        await deleteUploadIds(failedChunkIds, controller.signal);
        setSplitChunkIds(null);
        setFailedChunkIds(null);
        setFailedChunkIndices(null);
        setTranscribeSegments(null);
        const res = await upload(file, {
          signal: controller.signal,
          onProgress: (p) => setUploadProgress(p.percent),
        });
        setUploadId(res.upload_id);
        setUploadFileName(file.name);
        setIsCancellingSplit(false);
        episodeUploadIdRef.current = null;
        setUploadSizeBytes(null);
        if (res.duration_seconds != null) {
          setUploadDurationSeconds(res.duration_seconds);
          setUploadProgress(100);
          setIsUploading(false);
          setUploadProgress(null);
        } else {
          setUploadProgress(99);
          const durationController = new AbortController();
          durationAbortRef.current = durationController;
          const fetchDuration = async () => {
            for (let attempt = 0; attempt < DURATION_FETCH_MAX_ATTEMPTS; attempt++) {
              try {
                const d = await getUploadDuration(res.upload_id, {
                  signal: durationController.signal,
                });
                if (uploadGenerationRef.current !== uploadGeneration) return;
                setUploadDurationSeconds(d.duration_seconds);
                return;
              } catch (e) {
                if (e instanceof Error && e.name === "AbortError") return;
                if (attempt === DURATION_FETCH_MAX_ATTEMPTS - 1)
                  throw new Error("Failed to get duration");
              }
            }
          };
          fetchDuration()
            .then(() => {
              if (uploadGenerationRef.current !== uploadGeneration) return;
              setUploadProgress(100);
              setIsUploading(false);
              setUploadProgress(null);
            })
            .catch(() => {
              if (uploadGenerationRef.current !== uploadGeneration) return;
              setIsUploading(false);
              setUploadProgress(null);
            })
            .finally(() => {
              durationAbortRef.current = null;
            });
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          reportError("Upload failed", err);
        }
        setIsUploading(false);
        setUploadProgress(null);
      } finally {
        uploadAbortRef.current = null;
      }
    },
    [splitChunkIds, failedChunkIds]
  );

  const uploadFromUrlToTranscribe = useCallback(
    async (url: string, filename: string, lengthBytes?: number | null) => {
      uploadGenerationRef.current += 1;
      const uploadGeneration = uploadGenerationRef.current;
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setIsUploading(true);
      setUploadProgress(0);
      setUploadingEpisodeUrl(url);
      setUploadFileName(filename);
      setUploadSizeBytes(lengthBytes ?? null);
      setUploadId(null);
      setUploadDurationSeconds(null);
      setSplitChunkIds(null);
      setFailedChunkIds(null);
      setFailedChunkIndices(null);
      setTranscribeSegments(null);
      try {
        await deleteUploadIds(splitChunkIds, controller.signal);
        await deleteUploadIds(failedChunkIds, controller.signal);
        const res = await uploadFromUrl(url, filename, {
          signal: controller.signal,
          expectedSize: lengthBytes ?? undefined,
          onProgress: lengthBytes != null && lengthBytes > 0 ? (pct) => setUploadProgress(pct) : undefined,
        });
        setUploadId(res.upload_id);
        setIsCancellingSplit(false);
        episodeUploadIdRef.current = res.upload_id;
        setUploadIdToEpisodeUrl((prev) => new Map(prev).set(res.upload_id, url));
        if (res.duration_seconds != null) {
          setUploadDurationSeconds(res.duration_seconds);
          setUploadProgress(100);
          setIsUploading(false);
          setUploadProgress(null);
          setUploadedEpisodeUrls((prev) => new Map(prev).set(url, { uploadedAt: Date.now(), uploadId: res.upload_id }));
        } else {
          setUploadProgress(99);
          const durationController = new AbortController();
          durationAbortRef.current = durationController;
          const fetchDuration = async () => {
            for (let attempt = 0; attempt < DURATION_FETCH_MAX_ATTEMPTS; attempt++) {
              try {
                const d = await getUploadDuration(res.upload_id, {
                  signal: durationController.signal,
                });
                if (uploadGenerationRef.current !== uploadGeneration) return;
                setUploadDurationSeconds(d.duration_seconds);
                return;
              } catch (e) {
                if (e instanceof Error && e.name === "AbortError") return;
                if (attempt === DURATION_FETCH_MAX_ATTEMPTS - 1)
                  throw new Error("Failed to get duration");
              }
            }
          };
          fetchDuration()
            .then(() => {
              if (uploadGenerationRef.current !== uploadGeneration) return;
              setUploadProgress(100);
              setIsUploading(false);
              setUploadProgress(null);
              setUploadedEpisodeUrls((prev) => new Map(prev).set(url, { uploadedAt: Date.now(), uploadId: res.upload_id }));
            })
            .catch(() => {
              if (uploadGenerationRef.current !== uploadGeneration) return;
              setIsUploading(false);
              setUploadProgress(null);
              setUploadingEpisodeUrl(null);
              episodeUploadIdRef.current = null;
              setUploadIdToEpisodeUrl((prev) => { const n = new Map(prev); n.delete(res.upload_id); return n; });
            })
            .finally(() => {
              durationAbortRef.current = null;
            });
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          reportError("Upload from URL failed", err);
        }
        setIsUploading(false);
        setUploadProgress(null);
        setUploadingEpisodeUrl(null);
      } finally {
        uploadAbortRef.current = null;
      }
    },
    [splitChunkIds, failedChunkIds]
  );

  const handleUploadOrCancel = useCallback(
    async () => {
      if (isUploading) {
        setConfirmCancelType("upload");
        return;
      }
      if (!selectedFile) return;
      await uploadFileToTranscribe(selectedFile);
    },
    [isUploading, selectedFile, uploadFileToTranscribe]
  );

  const handleSplit = useCallback(() => {
    if (isSplitting) {
      setConfirmCancelType("split");
      return;
    }
    split();
  }, [isSplitting, split]);

  const handleTranscribe = useCallback(
    async () => {
      if (!canTranscribe || isTranscribing) return;
      if (hasChunks ? !splitChunkIds?.length : !selectedFile) return;
      setTranscribeError(null);
      setTranscribeText(null);
      setTranscribeSegments(null);
      setFailedChunkIds(null);
      setFailedChunkIndices(null);
      setTranscribeChunkProgress(null);
      transcribeAbortRef.current?.abort();
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      setIsTranscribing(true);
      let wasChunked = false;
      try {
        const chunkIds = splitChunkIds ?? [];
        const file = selectedFile;
        if (!hasChunks && !file) throw new Error("No file");
        wasChunked = hasChunks;
        let result: TranscribeApiResult;
        if (hasChunks) {
          result = await transcribeByUploadIdsStream(
            chunkIds,
            (current, total, filename) => setTranscribeChunkProgress({ current, total, filename }),
            {
              cleanupFailed: false,
              language: langOption,
              cleanUp: cleanOption === "yes",
              displayName: uploadFileName,
              engine: transcribeEngine,
              signal: controller.signal,
            }
          );
        } else {
          if (!file) throw new Error("No file");
          result = await transcribe(file, {
            language: langOption,
            cleanUp: cleanOption === "yes",
            displayName: file.name,
            engine: transcribeEngine,
            signal: controller.signal,
          });
        }
        setTranscribeText(result.text);
        if (hasChunks) {
          setTranscribeChunkProgress((prev) => (prev ? { ...prev, current: prev.total } : null));
        }
        if (hasChunks && result.text_segments?.length) {
          setTranscribeSegments(result.text_segments);
        } else {
          setTranscribeSegments(null);
        }
        if (result.failed_chunk_ids?.length && result.text_segments && result.failed_chunk_indices?.length) {
          setFailedChunkIds(result.failed_chunk_ids);
          setFailedChunkIndices(result.failed_chunk_indices);
          setTranscribeError(`Partial: ${result.failed_chunk_ids.length} chunk(s) failed. You can retry failed chunks.`);
        } else if (result.failed_chunk_ids?.length) {
          setTranscribeError(`Partial: ${result.failed_chunk_ids.length} chunk(s) failed.`);
        }
        if (hasChunks) setSplitChunkIds(null);
        await deleteUploadAndClearUploadState(uploadId);
      } catch (e) {
        if (e instanceof Error && e.name !== "AbortError") {
          setTranscribeError(e.message);
        }
      } finally {
        transcribeAbortRef.current = null;
        setIsTranscribing(false);
        if (!wasChunked) setTranscribeChunkProgress(null);
      }
    },
    [
      canTranscribe,
      isTranscribing,
      hasChunks,
      splitChunkIds,
      selectedFile,
      uploadId,
      uploadFileName,
      langOption,
      cleanOption,
      transcribeEngine,
      deleteUploadAndClearUploadState,
    ]
  );

  /** Shared download: generate PDF or TXT from text and trigger download. Used by main transcribe and history. */
  const doDownload = useCallback((text: string, format: "pdf" | "txt", filenameBase: string) => {
    if (downloadRevokeTimeoutRef.current) clearTimeout(downloadRevokeTimeoutRef.current);

    if (format === "pdf") {
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const margin = 20;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const maxLineWidth = pageWidth - margin * 2;
      const lineHeight = 10;
      const useCjkCanvas = hasCjkOrNonLatin(text) || (filenameBase ? hasCjkOrNonLatin(filenameBase) : false);

      if (useCjkCanvas) {
        const scale = 2;
        const pxPerMm = (595.28 / pageWidth) * scale;
        const maxLineWidthPx = maxLineWidth * pxPerMm;
        const tempCanvas = document.createElement("canvas");
        const tempCtx = tempCanvas.getContext("2d");
        if (tempCtx) {
          const titleFontSizePt = 14;
          const bodyFontSizePt = 10;
          const bodyFontPx = bodyFontSizePt * PT_TO_MM * pxPerMm;
          const titleFontPx = titleFontSizePt * PT_TO_MM * pxPerMm;
          tempCtx.font = `${bodyFontPx}px "Noto Sans SC", sans-serif`;
          const bodyLines = wrapTextToLines(tempCtx, text, maxLineWidthPx);
          tempCtx.font = `bold ${titleFontPx}px "Noto Sans SC", sans-serif`;
          const titleLines = filenameBase ? wrapTextToLines(tempCtx, filenameBase, maxLineWidthPx) : [];
          const linesPerPage = Math.max(1, Math.floor((pageHeight - margin * 2) / lineHeight));
          const firstPageBodyCap = titleLines.length > 0
            ? Math.max(0, linesPerPage - titleLines.length - 1)
            : linesPerPage;
          let bodyIndex = 0;
          for (let p = 0; p < 100; p++) {
            const pageTitle = p === 0 ? titleLines : undefined;
            const pageBody = bodyLines.slice(
              bodyIndex,
              bodyIndex + (p === 0 ? firstPageBodyCap : linesPerPage)
            );
            bodyIndex += p === 0 ? firstPageBodyCap : linesPerPage;
            if (pageTitle?.length || pageBody.length) {
              if (p > 0) doc.addPage();
              const canvas = drawPdfPageToCanvas(pageBody, {
                pageWidthMm: pageWidth,
                pageHeightMm: pageHeight,
                marginMm: margin,
                titleLines: pageTitle,
                titleFontSizePt,
                bodyFontSizePt,
                lineHeightMm: lineHeight,
                scale,
              });
              doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, pageWidth, pageHeight);
            }
            if (bodyIndex >= bodyLines.length) break;
          }
          const blob = doc.output("blob");
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${downloadBaseName(filenameBase)}.pdf`;
          a.click();
          downloadRevokeTimeoutRef.current = setTimeout(() => {
            URL.revokeObjectURL(url);
            downloadRevokeTimeoutRef.current = null;
          }, DOWNLOAD_REVOKE_DELAY_MS);
          return;
        }
      }

      let y = margin;
      if (filenameBase) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        const titleLines =
          typeof doc.splitTextToSize === "function"
            ? doc.splitTextToSize(filenameBase, maxLineWidth)
            : [filenameBase];
        for (const titleLine of titleLines) {
          doc.text(titleLine, margin, y);
          y += lineHeight;
        }
        y += lineHeight;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
      }

      const paragraphs = text.split(/\n\n+/);
      for (const para of paragraphs) {
        const lines =
          typeof doc.splitTextToSize === "function"
            ? doc.splitTextToSize(para, maxLineWidth)
            : para.split(/\n/).flatMap((line) => (line.length > 80 ? matchChunks(line, 80) : [line]));
        for (const line of lines) {
          if (y > pageHeight - margin) {
            doc.addPage();
            y = margin;
          }
          doc.text(line, margin, y);
          y += lineHeight;
        }
        y += lineHeight;
      }
      const blob = doc.output("blob");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${downloadBaseName(filenameBase)}.pdf`;
      a.click();
      downloadRevokeTimeoutRef.current = setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadRevokeTimeoutRef.current = null;
      }, DOWNLOAD_REVOKE_DELAY_MS);
      return;
    }

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${downloadBaseName(filenameBase)}.txt`;
    a.click();
    downloadRevokeTimeoutRef.current = setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadRevokeTimeoutRef.current = null;
    }, DOWNLOAD_REVOKE_DELAY_MS);
  }, []);

  const handleDownloadDialogChoose = useCallback(async (format: "pdf" | "txt") => {
    const summaryItem = pendingSummaryDownload;
    const translationItem = pendingTranslationDownload;
    const transcriptionItem = pendingTranscriptionDownload;
    const articleItem = pendingArticleDownload;
    setShowDownloadDialog(false);
    setPendingTranscriptionDownload(null);
    setPendingTranslationDownload(null);
    setPendingSummaryDownload(null);
    setPendingArticleDownload(null);
    const source = downloadSource;
    setDownloadSource(null);
    if (articleItem) {
      try {
        const detail = await getArticle(articleItem.id, { signal: apiAbortRef.current?.signal });
        doDownload(detail.text, format, detail.display_name);
      } catch {
        // Error from getArticle; dialog already closed
      }
      return;
    }
    if (summaryItem) {
      try {
        const detail = await getSummary(summaryItem.id, { signal: apiAbortRef.current?.signal });
        doDownload(detail.text, format, detail.display_name);
      } catch {
        // Error from getSummary; dialog already closed
      }
      return;
    }
    if (translationItem) {
      try {
        const detail = await getTranslation(translationItem.id, { signal: apiAbortRef.current?.signal });
        doDownload(detail.text, format, detail.display_name);
      } catch {
        // Error from getTranslation; dialog already closed
      }
      return;
    }
    if (transcriptionItem) {
      try {
        const detail = await getTranscription(transcriptionItem.id, { signal: apiAbortRef.current?.signal });
        doDownload(detail.text, format, detail.display_name);
      } catch {
        // Error from getTranscription; dialog already closed
      }
      return;
    }
    if (source === "summary" && summarizeResult) {
      const base =
        uploadFileName && uploadFileName.trim()
          ? `${downloadBaseName(uploadFileName)}(sum)`
          : "Current summary";
      doDownload(summarizeResult, format, base);
      return;
    }
    if (source === "translation" && translateResult) {
      const base =
        uploadFileName && uploadFileName.trim()
          ? `${downloadBaseName(uploadFileName)}(trans)`
          : "Current translation";
      doDownload(translateResult, format, base);
      return;
    }
    if (source === "transcription" && transcribeText) {
      const base =
        uploadFileName && uploadFileName.trim()
          ? `${downloadBaseName(uploadFileName)}(raw)`
          : "Current transcript";
      doDownload(transcribeText, format, base);
      return;
    }
    if (source === "restructure" && restructureResultText) {
      const base =
        uploadFileName && uploadFileName.trim()
          ? `${downloadBaseName(uploadFileName)}(art)`
          : "Current article";
      doDownload(restructureResultText, format, base);
    }
  }, [
    pendingTranscriptionDownload,
    pendingTranslationDownload,
    pendingSummaryDownload,
    pendingArticleDownload,
    transcribeText,
    translateResult,
    summarizeResult,
    restructureResultText,
    uploadFileName,
    doDownload,
    downloadSource,
  ]);

  const handleDeleteTranscriptionItem = useCallback(async (item: TranscriptionListItem) => {
    try {
      await deleteTranscription(item.id, { signal: apiAbortRef.current?.signal });
      setTranscribeHistoryItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch {
      // Error already user-facing from deleteTranscription; keep list unchanged
    }
  }, []);

  const handleDeleteTranslationItem = useCallback(async (item: TranslationListItem) => {
    try {
      await deleteTranslation(item.id, { signal: apiAbortRef.current?.signal });
      setTranslateHistoryItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch {
      // Error from deleteTranslation; keep list unchanged
    }
  }, []);

  const handleDeleteSummaryItem = useCallback(async (item: SummaryListItem) => {
    try {
      await deleteSummary(item.id, { signal: apiAbortRef.current?.signal });
      setSummarizeHistoryItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch {
      // Error from deleteSummary; keep list unchanged
    }
  }, []);

  const handleDeleteArticleItem = useCallback(async (item: ArticleListItem) => {
    try {
      await deleteArticle(item.id, { signal: apiAbortRef.current?.signal });
      setRestructureHistoryItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch {
      // Error from deleteArticle; keep list unchanged
    }
  }, []);

  const addTranslationToHistory = useCallback(
    async (display_name: string, text: string) => {
      try {
        const saved = await saveTranslation(display_name, text, { signal: apiAbortRef.current?.signal });
        setTranslateHistoryItems((prev) => [saved, ...prev]);
      } catch {
        // Best-effort: list will not show this entry; user still has result in textarea
      }
    },
    []
  );

  const handleTranslate = useCallback(async () => {
    const useSegments = transcribeSegments && transcribeSegments.length > 0;
    const hasInput = useSegments || (transcribeText != null && transcribeText.trim() !== "");
    if (!hasInput || isTranslating) return;
    setTranslateError(null);
    setTranslateResult(null);
    setIsTranslating(true);
    try {
      const targetLang = translateOption === "en-cn" ? "zh" : "en";
      const res = await translate(
        useSegments ? transcribeSegments : transcribeText!.trim(),
        targetLang,
        {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine,
        }
      );
      setTranslateResult(res.text);
      addTranslationToHistory(uploadFileName || "Current transcript", res.text);
    } catch (e) {
      setTranslateResult(null);
      setTranslateError(e instanceof Error ? e.message : "Translation failed");
    } finally {
      setIsTranslating(false);
    }
  }, [transcribeText, transcribeSegments, translateOption, isTranslating, uploadFileName, addTranslationToHistory, selectedEngine]);

  const runTranslateFromHistoryItem = useCallback(
    async (item: TranscriptionListItem, direction: "en-cn" | "cn-en") => {
      if (isTranslating) return;
      setTranslateResult(null);
      setTranslateError(null);
      setIsTranslating(true);
      try {
        const detail = await getTranscription(item.id, { signal: apiAbortRef.current?.signal });
        const targetLang = direction === "en-cn" ? "zh" : "en";

        // Prefer segmented translation when segments were persisted in transcription meta.
        const rawSegments = (detail.meta as any)?.segments;
        const segments: string[] | null = Array.isArray(rawSegments)
          ? rawSegments
              .map((s: unknown) => (typeof s === "string" ? s.trim() : ""))
              .filter((s: string) => s.length > 0)
          : null;

        const hasSegments = segments != null && segments.length > 0;
        const text = detail.text?.trim() || "";
        if (!hasSegments && !text) {
          throw new Error("Empty transcript text");
        }

        const res = await translate(hasSegments ? segments! : text, targetLang, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine,
        });
        setTranslateResult(res.text);
        addTranslationToHistory(item.display_name, res.text);
      } catch (e) {
        setTranslateResult(null);
        setTranslateError(e instanceof Error ? e.message : "Translation failed");
      } finally {
        setIsTranslating(false);
      }
    },
    [isTranslating, addTranslationToHistory, selectedEngine]
  );

  const addSummaryToHistory = useCallback(
    async (display_name: string, text: string) => {
      try {
        await saveSummary(display_name, text, { signal: apiAbortRef.current?.signal });
        const data = await listSummaries({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal });
        setSummarizeHistoryItems(data);
      } catch {
        // Error from saveSummary; list unchanged
      }
    },
    []
  );

  const runSummarizeFromTranscriptionItem = useCallback(
    async (item: TranscriptionListItem) => {
      if (isSummarizing) return;
      setSummarizeError(null);
      setSummarizeResult(null);
      setIsSummarizing(true);
      setSummarizeSource("transcript");
      try {
        const detail = await getTranscription(item.id, { signal: apiAbortRef.current?.signal });
        const text = detail.text?.trim();
        if (!text) {
          setSummarizeResult(null);
          setSummarizeError("Empty transcript text");
          return;
        }
        const res = await summarize(text, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine === "local" ? "local" : "api",
        });
        setSummarizeResult(res.text);
        const baseName = stripDisplayNameExtension(item.display_name) || "Transcript";
        await addSummaryToHistory(`${baseName}(sum-transcript)`, res.text);
      } catch (e) {
        setSummarizeResult(null);
        setSummarizeError(e instanceof Error ? e.message : "Summary failed");
      } finally {
        setIsSummarizing(false);
      }
    },
    [isSummarizing, selectedEngine, addSummaryToHistory]
  );

  const runSummarizeFromTranslationItem = useCallback(
    async (item: TranslationListItem) => {
      if (isSummarizing) return;
      setSummarizeError(null);
      setSummarizeResult(null);
      setIsSummarizing(true);
      setSummarizeSource("translation");
      try {
        const detail = await getTranslation(item.id, { signal: apiAbortRef.current?.signal });
        const text = detail.text?.trim();
        if (!text) {
          setSummarizeResult(null);
          setSummarizeError("Empty translation text");
          return;
        }
        const res = await summarize(text, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine === "local" ? "local" : "api",
        });
        setSummarizeResult(res.text);
        const baseName = stripDisplayNameExtension(item.display_name) || "Translation";
        await addSummaryToHistory(`${baseName}(sum-translation)`, res.text);
      } catch (e) {
        setSummarizeResult(null);
        setSummarizeError(e instanceof Error ? e.message : "Summary failed");
      } finally {
        setIsSummarizing(false);
      }
    },
    [isSummarizing, selectedEngine, addSummaryToHistory]
  );

  const handleTranslateDirectionChoose = useCallback(
    (direction: "en-cn" | "cn-en") => {
      const item = pendingTranslateFromHistoryItem;
      setPendingTranslateFromHistoryItem(null);
      setTranslateOption(direction);
      if (item) runTranslateFromHistoryItem(item, direction);
    },
    [pendingTranslateFromHistoryItem, runTranslateFromHistoryItem]
  );

  const handleSummarize = useCallback(async () => {
    const transcript = transcribeText?.trim() || "";
    const translation = translateResult?.trim() || "";
    if ((!transcript && !translation) || isSummarizing) return;
    setSummarizeError(null);
    setSummarizeResult(null);
    setIsSummarizing(true);
    try {
      const baseName = uploadFileName || "Current";

      // 单独来源：只生成一个总结文件
      if (summarizeSource === "transcript") {
        if (!transcript) {
          setSummarizeResult(null);
          setSummarizeError("No transcript to summarize");
          return;
        }
        const res = await summarize(transcript, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine === "local" ? "local" : "api",
        });
        setSummarizeResult(res.text);
        await addSummaryToHistory(`${baseName}(sum-transcript)`, res.text);
        return;
      }
      if (summarizeSource === "translation") {
        if (!translation) {
          setSummarizeResult(null);
          setSummarizeError("No translation to summarize");
          return;
        }
        const res = await summarize(translation, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine === "local" ? "local" : "api",
        });
        setSummarizeResult(res.text);
        await addSummaryToHistory(`${baseName}(sum-translation)`, res.text);
        return;
      }

      // summarizeSource === "all": 生成两个 summary 结果文件
      if (!transcript && !translation) {
        setSummarizeResult(null);
        setSummarizeError("No text to summarize");
        return;
      }

      if (transcript && translation) {
        const [resTranscript, resTranslation] = await Promise.all([
          summarize(transcript, {
            signal: apiAbortRef.current?.signal,
            engine: selectedEngine === "local" ? "local" : "api",
          }),
          summarize(translation, {
            signal: apiAbortRef.current?.signal,
            engine: selectedEngine === "local" ? "local" : "api",
          }),
        ]);
        const combined =
          `Transcript summary:\n${resTranscript.text}\n\n` +
          `Translation summary:\n${resTranslation.text}`;
        setSummarizeResult(combined);
        await addSummaryToHistory(`${baseName}(sum-transcript)`, resTranscript.text);
        await addSummaryToHistory(`${baseName}(sum-translation)`, resTranslation.text);
        return;
      }

      // all 但只存在一类文本时，退化为单独来源逻辑
      if (transcript) {
        const res = await summarize(transcript, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine === "local" ? "local" : "api",
        });
        setSummarizeResult(res.text);
        await addSummaryToHistory(`${baseName}(sum-transcript)`, res.text);
      } else if (translation) {
        const res = await summarize(translation, {
          signal: apiAbortRef.current?.signal,
          engine: selectedEngine === "local" ? "local" : "api",
        });
        setSummarizeResult(res.text);
        await addSummaryToHistory(`${baseName}(sum-translation)`, res.text);
      }
    } catch (e) {
      setSummarizeResult(null);
      setSummarizeError(e instanceof Error ? e.message : "Summary failed");
    } finally {
      setIsSummarizing(false);
    }
  }, [transcribeText, translateResult, summarizeSource, isSummarizing, uploadFileName, addSummaryToHistory]);

  const handleRestructure = useCallback(
    async () => {
      if (isRestructuring || restructureSelectedCount === 0) return;
      setIsRestructuring(true);
      try {
        const summaryTranscriptParts: string[] = [];
        const summaryTranslationParts: string[] = [];
        let transcriptText: string | null = null;
        let translationText: string | null = null;

        // Summaries: include up to 2 selected, in the order they were selected.
        if (restructureSelectedSummaryIds.length) {
          const selectedSummaries = restructureSelectedSummaryIds
            .slice(0, 2)
            .map((sid) => summarizeHistoryItems.find((x) => x.id === sid))
            .filter((x): x is SummaryListItem => Boolean(x));
          if (selectedSummaries.length) {
            const details = await Promise.all(
              selectedSummaries.map((item) =>
                getSummary(item.id, { signal: apiAbortRef.current?.signal }),
              ),
            );
            details.forEach((d, idx) => {
              const item = selectedSummaries[idx];
              const text = d.text?.trim();
              if (!text) return;
              const name = item.display_name.toLowerCase();
              if (name.endsWith("(sum-transcript)")) {
                summaryTranscriptParts.push(text);
              } else if (name.endsWith("(sum-translation)")) {
                summaryTranslationParts.push(text);
              } else {
                // Fallback：未标明类型的 summary 归到 summaryTranscript
                summaryTranscriptParts.push(text);
              }
            });
          }
        }

        // Transcript
        let articleBaseName: string | null = null;
        if (restructureSelectedTranscriptionIds.length) {
          const tid = restructureSelectedTranscriptionIds[0];
          const tItem = transcribeHistoryItems.find((x) => x.id === tid) || null;
          if (tItem) {
            const detail = await getTranscription(tid, { signal: apiAbortRef.current?.signal });
            const text = detail.text?.trim();
            if (text) transcriptText = text;
            const base = stripDisplayNameExtension(tItem.display_name).replace(/\(raw\)$/i, "").trim();
            if (base) articleBaseName = `${base}(art)`;
          }
        }

        // Translation
        if (restructureSelectedTranslationIds.length) {
          const trid = restructureSelectedTranslationIds[0];
          const trItem = translateHistoryItems.find((x) => x.id === trid) || null;
          if (trItem) {
            const detail = await getTranslation(trid, { signal: apiAbortRef.current?.signal });
            const text = detail.text?.trim();
            if (text) translationText = text;
            if (!articleBaseName) {
              const base = stripDisplayNameExtension(trItem.display_name).replace(/\(trans\)$/i, "").trim();
              if (base) articleBaseName = `${base}(art)`;
            }
          }
        }

        const sections: string[] = [];
        sections.push(
          `summary：\n${
            summaryTranscriptParts.length ? summaryTranscriptParts.join("\n\n") : "none"
          }`,
        );
        sections.push(
          `摘要：\n${
            summaryTranslationParts.length ? summaryTranslationParts.join("\n\n") : "暂无"
          }`,
        );
        sections.push(`transcript：\n${transcriptText || "none"}`);
        sections.push(`翻译：\n${translationText || "暂无"}`);

        const combinedText = sections.join("\n\n\n").trim();
        if (!combinedText) return;

        setRestructureResultText(combinedText);
        // Clear current file selections and label after a successful restructure
        setRestructureSelectedTranscriptionIds([]);
        setRestructureSelectedTranslationIds([]);
        setRestructureSelectedSummaryIds([]);
        setRestructureResultFilesLabel("");

        const saved = await saveArticle(articleBaseName || "", combinedText, {
          signal: apiAbortRef.current?.signal,
        });
        setRestructureHistoryItems((prev) => [saved, ...prev]);
        setRestructureHistoryOpen(true);
      } catch {
        // Best-effort: if restructure fails, do nothing visible; user can retry.
      } finally {
        setIsRestructuring(false);
      }
    },
    [
      isRestructuring,
      restructureSelectedCount,
      restructureSelectedSummaryIds,
      restructureSelectedTranscriptionIds,
      restructureSelectedTranslationIds,
      summarizeHistoryItems,
      transcribeHistoryItems,
      translateHistoryItems,
      apiAbortRef,
      saveArticle,
    ],
  );

  const handleRetryFailedChunks = useCallback(
    async () => {
      if (!failedChunkIds?.length || !transcribeSegments || !failedChunkIndices?.length || isTranscribing) return;
      setTranscribeError(null);
      setTranscribeChunkProgress(null);
      transcribeAbortRef.current?.abort();
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      setIsTranscribing(true);
      try {
        const result = await transcribeByUploadIdsStream(
          failedChunkIds,
          (current, total, filename) => setTranscribeChunkProgress({ current, total, filename }),
          {
            cleanupFailed: false,
            language: langOption,
            cleanUp: cleanOption === "yes",
            displayName: uploadFileName,
            engine: transcribeEngine,
            signal: controller.signal,
          }
        );
        const segs = result.text_segments;
        if (!segs || segs.length !== failedChunkIndices.length) {
          setTranscribeText(result.text);
          setTranscribeError("Retry returned unexpected format; showing raw text.");
        } else {
          const merged = [...transcribeSegments];
          failedChunkIndices.forEach((idx, i) => {
            merged[idx] = segs[i];
          });
          setTranscribeText(merged.join("\n\n"));
        }
        setTranscribeSegments(null);
        setFailedChunkIds(null);
        setFailedChunkIndices(null);
      } catch (e) {
        if (e instanceof Error && e.name !== "AbortError") {
          setTranscribeError(e.message);
        }
      } finally {
        transcribeAbortRef.current = null;
        setIsTranscribing(false);
      }
    },
    [
      failedChunkIds,
      transcribeSegments,
      failedChunkIndices,
      isTranscribing,
      langOption,
      cleanOption,
      transcribeEngine,
    ]
  );

  const stepLogText = useMemo(
    () =>
      transcribeChunkProgress != null
        ? transcribeChunkProgress.filename
        : isTranscribing
          ? uploadFileName || "Transcribing…"
          : transcribeText != null
            ? (uploadFileName || "Task information")
            : "Task information",
    [transcribeChunkProgress, isTranscribing, uploadFileName, transcribeText]
  );

  /** Chunks: backend sends (current_1based, total) before each chunk; we show completed/total (0→total). Single file: 0/1 then 1/1. */
  const transcribeAddonCompleted = useMemo((): { completed: number; total: number } | null => {
    if (transcribeChunkProgress && transcribeChunkProgress.total > 0) {
      const { current, total } = transcribeChunkProgress;
      const completed = current === total && transcribeText != null ? total : Math.max(0, current - 1);
      return { completed, total };
    }
    if (isTranscribing && hasChunks && splitChunkIds?.length) return { completed: 0, total: splitChunkIds.length };
    if (isTranscribing && !hasChunks) return { completed: 0, total: 1 };
    if (!isTranscribing && transcribeText != null && !hasChunks) return { completed: 1, total: 1 };
    return null;
  }, [transcribeChunkProgress, isTranscribing, hasChunks, splitChunkIds, transcribeText]);

  /** Progress 0–100 for transcribe addon fill. null = no fill. */
  const transcribeAddonProgress = useMemo((): number | null => {
    const c = transcribeAddonCompleted;
    if (c && c.total > 0) return (c.completed / c.total) * 100;
    return null;
  }, [transcribeAddonCompleted]);

  const transcribeAddonText = useMemo(
    () =>
      transcribeAddonCompleted
        ? `${transcribeAddonCompleted.completed}/${transcribeAddonCompleted.total} chunks`
        : "chunks",
    [transcribeAddonCompleted]
  );

  const uploadButtonText = useMemo(
    () =>
      fileTooBig
        ? `>${DISPLAY_UPLOAD_MAX_MB}MB!!!`
        : isDeletingUpload
          ? "del..."
          : isUploading
            ? "cancel"
            : "upload",
    [fileTooBig, isDeletingUpload, isUploading]
  );

  return (
    <div className="app">
      <div className="main-wrapper">
        <header className="header">
          <img src="/logo-v2-porcelain3.png" alt="" className="logo" />
          <span className="brand-name">LHJCJJ.Tools</span>
          <a href="#" className="btn-signup">sign up</a>
          <a href="#" className="btn-login">log in</a>
          <p className="notice" title="Notices: 2026.02.23 Release Transcribe and Translate Tool v1.0.3">
            Notices: 2026.02.23 Release Transcribe and Translate Tool v1.0.3
          </p>
        </header>

        <div className="content-layout">
          <nav className="sub-nav">
            <a
              href="#"
              className={`sub-nav-home${subNavActive === "home" ? " sub-nav-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setSubNavActive("home"); }}
            >
              Home
            </a>
            <a
              href="#"
              className={`sub-nav-link${subNavActive === "get-info" ? " sub-nav-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setSubNavActive("get-info"); }}
            >
              Get Information
            </a>
            <a
              href="#"
              className={`sub-nav-link${subNavActive === "transcribe" ? " sub-nav-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setSubNavActive("transcribe"); }}
            >
              Transcribe and Translate
            </a>
          </nav>

          {/* Get Information and Transcribe and Translate are independent: do not change Transcribe and Translate's <main> content or business logic when editing Get Information. */}
          <main className="main">
            {subNavActive === "get-info" && (
              <>
                <div className="main-title-row">
                  <h1 className="main-title">Get Information</h1>
                </div>
                <div className="intro"><span className="intro-label">Introduction: </span><span className="intro-placeholder" title="placeholder">placeholder</span></div>
                <div className="steps steps-podcasts">
                  <section className="step">
                    <div className="step-head">
                      <img src={podcastsIcon} alt="" width={24} height={24} />
                      <span className="step-title">Podcasts</span>
                    </div>
                    <div className="step-body">
                      {podcastRows.map((row) => (
                        <div key={row.id} className="step-row">
                          <div className="step-inner">
                            <div className="step-podcast-name-wrap">
                              <input
                                type="text"
                                id={`step-podcast-name-input-${row.id}`}
                                name="podcast-name"
                                className={`step-input step-podcast-name-input${row.showValidationError && !row.name.trim() ? " podcast-input-error" : ""}`}
                                placeholder="Input a podcast name"
                                aria-label="Podcast name"
                                autoComplete="off"
                                value={row.name}
                                onChange={(e) => { setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, name: e.target.value, showValidationError: false } : r)); }}
                                disabled={row.inputsDisabled}
                              />
                              {hasNewEpisodesForFeed((row.rss || "").trim()) ? (
                                <span className="step-podcast-name-rss-icon" title="has new episodes" aria-hidden="true" style={{ marginRight: 4 }}>
                                  <img src={newsIcon} alt="" width={14} height={14} />
                                </span>
                              ) : null}
                              {(row.rss || "").trim() ? (
                                <span className="step-podcast-name-rss-icon" title="RSS has been fetched" aria-hidden="true">
                                  <img src={rssInlineIcon} alt="" />
                                </span>
                              ) : null}
                            </div>
                            <input
                              type="text"
                              id={`step-podcast-link-input-${row.id}`}
                              name="podcast-link"
                              className={`step-input step-podcast-link-input${row.showValidationError && !row.link.trim() ? " podcast-input-error" : ""}`}
                              placeholder="Input a podcast link"
                              aria-label="Podcast link"
                              autoComplete="off"
                              value={row.link}
                              onChange={(e) => { setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, link: e.target.value, showValidationError: false } : r)); }}
                              disabled={row.inputsDisabled}
                          />
                          </div>
                          <div className="step-podcast-actions">
                            <button type="button" className="step-podcast-save" aria-label={row.inputsDisabled ? "Edit podcast" : "Save podcast"} onClick={async () => { if (row.inputsDisabled) { setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, inputsDisabled: false } : r)); return; } const nameOk = row.name.trim() !== ""; const linkOk = row.link.trim() !== ""; if (!nameOk || !linkOk) { setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, showValidationError: true } : r)); return; } try { if (row.id.startsWith("new-")) { const res = await savePodcast(row.name, row.link); setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, id: res.id, inputsDisabled: true, showValidationError: false } : r)); } else { await updatePodcast(row.id, row.name, row.link); setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, inputsDisabled: true, showValidationError: false } : r)); } } catch (e) { alert(e instanceof Error ? e.message : "Save failed"); } }}>{row.inputsDisabled ? <img src={editIcon} alt="" className="step-podcast-save-icon" /> : <img src={saveIcon} alt="" className="step-podcast-save-icon" />}</button>
                            <button type="button" className="step-podcast-rss" aria-label="RSS" disabled={!row.inputsDisabled || !row.name.trim() || !row.link.trim()} onClick={async () => { const link = row.link.trim(); if (!link) { alert("Input podcast link first."); return; } try { const { feedUrl } = await getPodcastRss(link); await updatePodcastRss(row.id, feedUrl); setPodcastRows(prev => prev.map(r => r.id === row.id ? { ...r, rss: feedUrl } : r)); await navigator.clipboard.writeText(feedUrl); alert(`${feedUrl}\n\nRSS has been copied.`); } catch (e) { alert(e instanceof Error ? e.message : "Invalid Apple Podcasts link"); } }}><img src={rssIcon} alt="" className="step-podcast-rss-icon" /></button>
                            <button type="button" className="step-podcast-preview" aria-label="Preview podcast" disabled={!row.inputsDisabled || !row.name.trim() || !row.link.trim()} onClick={async () => { const link = row.link.trim(); if (!link) return; let feedUrl = (row.rss || "").trim(); if (!feedUrl) { try { const r = await getPodcastRss(link); feedUrl = r.feedUrl; } catch (e) { alert(e instanceof Error ? e.message : "Could not get RSS feed"); return; } } const cached = podcastPreviewCacheRef.current; const cacheValid = cached?.feedUrl === feedUrl && (Date.now() - (cached.cachedAt ?? 0)) < PODCAST_PREVIEW_CACHE_TTL_MS; if (cacheValid && cached) { setPodcastPreviewLinks(cached.links); setPodcastPreviewNewUrls(getStoredNewUrlsForFeed(feedUrl, cached.links.map((l) => l.url))); setPodcastPreviewOpen(true); setPodcastPreviewFeedUrl((row.rss || "").trim() ? feedUrl : ""); setPodcastPreviewSelectedIndices([]); setPodcastPreviewLoading(false); return; } setPodcastPreviewOpen(true); setPodcastPreviewFeedUrl((row.rss || "").trim() ? feedUrl : ""); setPodcastPreviewLoading(true); setPodcastPreviewLinks([]); setPodcastPreviewSelectedIndices([]); setPodcastPreviewNewUrls(new Set()); try { const links = await getPodcastFeedAudioLinks(feedUrl); const oldLinks = (podcastPreviewCacheRef.current?.feedUrl === feedUrl && podcastPreviewCacheRef.current?.links) ? podcastPreviewCacheRef.current.links : []; const newlyDetected = links.filter((l) => !oldLinks.some((o) => o.url === l.url)).map((l) => l.url); persistNewUrlsForFeed(feedUrl, newlyDetected); const currentUrls = links.map((l) => l.url); setPodcastPreviewLinks(links); setPodcastPreviewNewUrls(getStoredNewUrlsForFeed(feedUrl, currentUrls)); podcastPreviewCacheRef.current = { feedUrl, links, cachedAt: Date.now() }; } catch (e) { setPodcastPreviewLinks([]); podcastPreviewCacheRef.current = null; alert(e instanceof Error ? e.message : "Failed to fetch audio links"); } finally { setPodcastPreviewLoading(false); } }}>
                              <img src={previewIcon} alt="" className="step-podcast-preview-icon" />
                            </button>
                            <button type="button" className="step-podcast-delete" aria-label="Delete podcast" onClick={async () => { if (!row.id.startsWith("new-")) { try { await deletePodcast(row.id); } catch { /* ignore */ } } setPodcastRows(prev => prev.filter(r => r.id !== row.id)); }}><img src={deleteIcon} alt="" className="step-podcast-delete-icon" /></button>
                          </div>
                        </div>
                      ))}
                      <div className="step-row step-podcast-add-row">
                        <div className="step-podcast-add-row-spacer" aria-hidden="true" />
                        <div className="step-podcast-actions">
                          <span className="step-podcast-add-row-placeholder" aria-hidden="true" />
                          <button type="button" className="step-podcast-add" aria-label="Add podcast" onClick={() => setPodcastRows(prev => [...prev, { id: `new-${Date.now()}`, name: "", link: "", inputsDisabled: false, showValidationError: false }])}><img src={addIcon} alt="" className="step-podcast-add-icon" /></button>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </>
            )}
            {subNavActive === "home" && (
              <div className="main-home">
                <h1 className="main-title">Home</h1>
                <div className="intro"><span className="intro-label">Introduction: </span><span className="intro-placeholder" title="placeholder">placeholder</span></div>
              </div>
            )}
            {subNavActive === "transcribe" && (
              <>
            <div className="main-title-row">
              <h1 className="main-title">Transcribe and Translate</h1>
              <div className="engine-toggle" role="group" aria-label="Engine (transcription & translation)">
                <button
                  type="button"
                  className={`engine-option ${selectedEngine === "local" ? "is-active" : ""}`}
                  onClick={() => setSelectedEngine("local")}
                >
                  Local
                </button>
                <button
                  type="button"
                  className={`engine-option ${selectedEngine === "api" ? "is-active" : ""}`}
                  onClick={() => setSelectedEngine("api")}
                >
                  API
                </button>
              </div>
            </div>

            <div className="intro">
              <span className="intro-label">Introduction: </span>
              <span className="intro-placeholder" title="Transcribe .mp3、.mp4、.mpeg、.mpga、.m4a、.wav、.webm into .txt">Transcribe .mp3、.mp4、.mpeg、.mpga、.m4a、.wav、.webm into .txt</span>
            </div>

            <div className="steps steps-transcribe">
              <FileUpload
                inputRef={fileInputRef}
                fileName={uploadFileName}
                fileSizeAddon={fileSizeAddon}
                hasFile={hasFile}
                disabled={uploadStepDisabled}
                onFileChange={handleFileChange}
                onClear={handleClear}
                onBrowse={handleBrowse}
                uploadButtonDisabled={!hasFile || fileTooBig || isDeletingUpload || isCancellingSplit || isUploaded || (isTranscribing && hasChunks)}
                uploadButtonText={uploadButtonText}
                onUploadOrCancel={handleUploadOrCancel}
                uploadProgress={uploadProgress}
                isUploading={isUploading}
              />

              <section className="step">
                <div className="step-head">
                  <span className="step-title">②    Split into chunks:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">If the audio file exceeds {DISPLAY_SPLIT_THRESHOLD_MB} MB, it must be split into smaller chunks.</p>
                      <div className="step-inner">
                        <span className="step-input-prefix">Each chunk is: </span>
                        <input
                          type="text"
                          id="step-chunk-input"
                          name="chunk-size"
                          className="step-input step-chunk-num"
                          placeholder="3"
                          aria-label="Chunk size in minutes"
                          value={chunkSizeInput}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/\D/g, "").slice(0, CHUNK_INPUT_MAX_LENGTH);
                            setChunkSizeInput(raw === "" ? "" : clampChunkInput(raw));
                          }}
                          onBlur={() => setChunkSizeInput(String(chunkSizeMin))}
                        />
                        <span className="step-input-suffix"> mins</span>
                        <span
                          className={`step-input-addon${chunksAddonProgress != null ? " step-input-addon--progress" : ""}`}
                          style={chunksAddonProgress != null ? ({ "--progress": chunksAddonProgress } as React.CSSProperties) : undefined}
                        >
                          {isSplitting && splitProgress
                            ? `${splitProgress.current}/${splitProgress.current === 0 && segmentCount != null ? segmentCount : splitProgress.total} chunks`
                            : hasChunks && splitChunkIds
                              ? `${splitChunkIds.length}/${splitChunkIds.length} chunks`
                              : isUploaded && uploadDurationSeconds == null
                                ? "… chunks"
                                : segmentCount != null
                                  ? `0/${segmentCount} chunks`
                                  : "chunks"}
                        </span>
                      </div>
                    </div>
                    <button type="button" className="step-split-split" disabled={splitStepDisabled} onClick={handleSplit}>
                      {isCancellingSplit ? "del…" : isSplitting ? "cancel" : "split"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="step">
                <div className="step-head">
                  <span className="step-title">③    Choose languages:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">Select the language spoken in the audio file for better results, or let us auto-detect it.</p>
                      <div className="step-inner">
                        <div className="step-lang-toggle" role="group" aria-label="Language">
                          <button type="button" className={`step-lang-option ${langOption === "auto" ? "is-active" : ""}`} onClick={() => setLangOption("auto")}>auto detect</button>
                          <button type="button" className={`step-lang-option ${langOption === "en" ? "is-active" : ""}`} onClick={() => setLangOption("en")}>English</button>
                          <button type="button" className={`step-lang-option ${langOption === "zh" ? "is-active" : ""}`} onClick={() => setLangOption("zh")}>Chinese</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="step">
                <div className="step-head">
                  <span className="step-title">④    Clean up transcripts:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">Cleans up filler words and basic grammar to improve readability.</p>
                      <div className="step-inner">
                        <div className="step-clean-toggle" role="group" aria-label="Clean up">
                          <button type="button" className={`step-clean-option ${cleanOption === "yes" ? "is-active" : ""}`} onClick={() => setCleanOption("yes")}>Yes</button>
                          <button type="button" className={`step-clean-option ${cleanOption === "no" ? "is-active" : ""}`} onClick={() => setCleanOption("no")}>No</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="step">
                <div className="step-head">
                  <span className="step-title">⑤    Transcribe:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">default</p>
                      <div className="step-inner">
                        <div role="log" className={`step-log${stepLogText === "Task information" ? " step-log-default" : ""}`} title={stepLogText !== "Task information" ? stepLogText : undefined}><span className="step-log-text">{stepLogText}</span></div>
                        <span
                          className={`step-input-addon${transcribeAddonProgress != null ? " step-input-addon--progress" : ""}`}
                          style={transcribeAddonProgress != null ? ({ "--progress": transcribeAddonProgress } as React.CSSProperties) : undefined}
                        >
                          {transcribeAddonText}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="step-transcribe-transcribe"
                      disabled={isTranscribing || isDeletingUpload || isUploading || isSplitting || (!failedChunkIds?.length && !canTranscribe)}
                      onClick={failedChunkIds?.length ? handleRetryFailedChunks : handleTranscribe}
                    >
                      {isTranscribing ? "transcribing…" : failedChunkIds?.length ? "retry failed" : "transcribe"}
                    </button>
                    <button
                      type="button"
                      className="step-transcribe-download"
                      disabled={!transcribeText}
                      onClick={() => {
                        setPendingTranscriptionDownload(null);
                        setDownloadSource("transcription");
                        setShowDownloadDialog(true);
                      }}
                    >
                      download
                    </button>
                  </div>
                </div>
                <TranscribeResult text={transcribeText} error={transcribeError} />
              </section>
            </div>

            <div className="history-files">
              <button type="button" className={`history-toggle${transcribeHistoryOpen ? " is-open" : ""}`} onClick={() => setTranscribeHistoryOpen((o) => !o)}>
                {transcribeHistoryOpen ? "Transcription history ↑" : "Transcription history ↓"}
              </button>
              {transcribeHistoryOpen && (
                <ul className="history-list">
                  {transcribeHistoryLoading ? (
                    <li className="history-list-empty">Loading…</li>
                  ) : transcribeHistoryItems.length === 0 ? (
                    <li className="history-list-empty">No transcripts yet</li>
                  ) : (
                    <>
                      {transcribeHistoryItems.map((transcriptionItem) => (
                        <li key={transcriptionItem.id} className="history-item">
                          <span
                            className="history-item-name"
                            title={transcriptionItem.display_name}
                          >
                            {transcriptionItem.display_name}
                          </span>
                          <span className="history-item-time">{formatCreatedAt(transcriptionItem.created_at)}</span>
                          <span className="history-item-actions">
                            <button
                              type="button"
                              className="history-item-translate"
                              disabled={isTranslating}
                              onClick={() => setPendingTranslateFromHistoryItem(transcriptionItem)}
                              title="translate"
                            >
                              <img src={translateIcon} alt="" width={24} height={24} />
                            </button>
                            <button
                              type="button"
                              className="history-item-summarize"
                              disabled={isSummarizing}
                              title="summarize"
                              onClick={() => setPendingSummarizeTranscriptionItem(transcriptionItem)}
                            >
                              <img src={summarizeIcon} alt="" width={24} height={24} />
                            </button>
                            <button
                              type="button"
                              className="history-item-preview"
                              title="preview"
                              onClick={async () => {
                                setPreviewOpen(true);
                                setPreviewTitle(stripDisplayNameExtension(transcriptionItem.display_name));
                                setPreviewText("");
                                setPreviewLoading(true);
                                try {
                                  const detail = await getTranscription(transcriptionItem.id, { signal: apiAbortRef.current?.signal });
                                  setPreviewText(detail.text);
                                } catch {
                                  setPreviewText("Failed to load.");
                                } finally {
                                  setPreviewLoading(false);
                                }
                              }}
                            >
                              <img src={previewIcon} alt="" width={24} height={24} />
                            </button>
                            <button
                              type="button"
                              className="history-item-download"
                              onClick={() => {
                                setPendingTranscriptionDownload(transcriptionItem);
                                setShowDownloadDialog(true);
                              }}
                              title="download"
                            >
                              <img src={downloadIcon} alt="" width={24} height={24} />
                            </button>
                            <button type="button" className="history-item-delete" disabled={isTranslating || isSummarizing} onClick={() => setPendingDeleteTranscriptionItem(transcriptionItem)} title="delete"><img src={deleteIcon} alt="" width={24} height={24} /></button>
                          </span>
                        </li>
                      ))}
                      {transcribeHistoryHasMore && (
                        <li className="history-list-load-more">
                          <button type="button" className="history-load-more-btn" disabled={transcribeHistoryLoadingMore} onClick={handleTranscribeHistoryLoadMore}>
                            {transcribeHistoryLoadingMore ? "Loading…" : "Load more"}
                          </button>
                        </li>
                      )}
                    </>
                  )}
                </ul>
              )}
            </div>

            <div className="steps step-translate">
              <section className="step">
                <div className="step-head">
                  <span className="step-title">⑥    Translate:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">Translate the transcript to another language.</p>
                      <div className="step-inner">
                        <div className="step-direction-toggle" role="group" aria-label="Translate">
                          <button type="button" className={`step-direction-option ${translateOption === "en-cn" ? "is-active" : ""}`} onClick={() => setTranslateOption("en-cn")}>en→cn</button>
                          <button type="button" className={`step-direction-option ${translateOption === "cn-en" ? "is-active" : ""}`} onClick={() => setTranslateOption("cn-en")}>cn→en</button>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="step-translate-translate"
                      disabled={!transcribeText?.trim() || isTranslating}
                      onClick={handleTranslate}
                    >
                      {isTranslating ? "translating…" : "translate"}
                    </button>
                    <button
                      type="button"
                      className="step-translate-download"
                      disabled={!translateResult}
                      onClick={() => {
                        setDownloadSource("translation");
                        setShowDownloadDialog(true);
                      }}
                    >
                      download
                    </button>
                  </div>
                </div>
                <div className="step-body">
                  {translateError && <p className="step-error" role="alert">{translateError}</p>}
                  <textarea readOnly className="step-translate-result" rows={8} value={translateResult ?? ""} />
                </div>
              </section>
            </div>

            <div className="history-files">
              <button type="button" className={`history-toggle${translateHistoryOpen ? " is-open" : ""}`} onClick={() => setTranslateHistoryOpen((o) => !o)}>
                {translateHistoryOpen ? "Translation history ↑" : "Translation history ↓"}
              </button>
              {translateHistoryOpen && (
                <ul className="history-list">
                  {translateHistoryItems.length === 0 ? (
                    <li className="history-list-empty">No translations yet</li>
                  ) : (
                    translateHistoryItems.map((translationItem) => (
                      <li key={translationItem.id} className="history-item">
                        <span
                          className="history-item-name"
                          title={translationItem.display_name}
                        >
                          {translationItem.display_name}
                        </span>
                        <span className="history-item-time">{formatCreatedAt(translationItem.created_at)}</span>
                        <span className="history-item-actions">
                          <button
                            type="button"
                            className="history-item-summarize"
                            disabled={isSummarizing}
                            title="summarize"
                            onClick={() => setPendingSummarizeTranslationItem(translationItem)}
                          >
                            <img src={summarizeIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-preview"
                            title="preview"
                            onClick={async () => {
                              setPreviewOpen(true);
                              setPreviewTitle(stripDisplayNameExtension(translationItem.display_name));
                              setPreviewText("");
                              setPreviewLoading(true);
                              try {
                                const detail = await getTranslation(translationItem.id, { signal: apiAbortRef.current?.signal });
                                setPreviewText(detail.text);
                              } catch {
                                setPreviewText("Failed to load.");
                              } finally {
                                setPreviewLoading(false);
                              }
                            }}
                          >
                            <img src={previewIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-download"
                            title="download"
                            onClick={() => {
                              setPendingTranscriptionDownload(null);
                              setPendingTranslationDownload(translationItem);
                              setShowDownloadDialog(true);
                            }}
                          >
                            <img src={downloadIcon} alt="" width={24} height={24} />
                          </button>
                          <button type="button" className="history-item-delete" disabled={isSummarizing} title="delete" onClick={() => { setPendingDeleteTranscriptionItem(null); setPendingDeleteTranslationItem(translationItem); }}><img src={deleteIcon} alt="" width={24} height={24} /></button>
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>

            <div className="steps step-summarize">
              <section className="step">
                <div className="step-head">
                  <span className="step-title">⑦    Summarize:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">Summarize the transcript and translation.</p>
                      <div className="step-inner">
                        <div className="step-source-toggle" role="group" aria-label="Summarize">
                          <button type="button" className={`step-source-option ${summarizeSource === "all" ? "is-active" : ""}`} onClick={() => setSummarizeSource("all")}>all</button>
                          <button type="button" className={`step-source-option ${summarizeSource === "transcript" ? "is-active" : ""}`} onClick={() => setSummarizeSource("transcript")}>Transcript</button>
                          <button type="button" className={`step-source-option ${summarizeSource === "translation" ? "is-active" : ""}`} onClick={() => setSummarizeSource("translation")}>Translation</button>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="step-summarize-summarize"
                      disabled={(!transcribeText?.trim() && !translateResult?.trim()) || isSummarizing}
                      onClick={handleSummarize}
                    >
                      {isSummarizing ? "summarizing…" : "summarize"}
                    </button>
                    <button
                      type="button"
                      className="step-summarize-download"
                      disabled={!summarizeResult}
                      onClick={() => {
                        setDownloadSource("summary");
                        setShowDownloadDialog(true);
                      }}
                    >
                      download
                    </button>
                  </div>
                </div>
                <div className="step-body">
                  {summarizeError && <p className="step-error" role="alert">{summarizeError}</p>}
                  <textarea readOnly className="step-summarize-result" rows={8} value={summarizeResult ?? ""} />
                </div>
              </section>
            </div>

            <div className="history-files">
              <button type="button" className={`history-toggle${summarizeHistoryOpen ? " is-open" : ""}`} onClick={() => setSummarizeHistoryOpen((o) => !o)}>
                {summarizeHistoryOpen ? "Summary history ↑" : "Summary history ↓"}
              </button>
              {summarizeHistoryOpen && (
                <ul className="history-list">
                  {summarizeHistoryItems.length === 0 ? (
                    <li className="history-list-empty">No summaries yet</li>
                  ) : (
                    summarizeHistoryItems.map((summaryItem) => (
                      <li key={summaryItem.id} className="history-item">
                        <span
                          className="history-item-name"
                          title={summaryItem.display_name}
                        >
                          {summaryItem.display_name}
                        </span>
                        <span className="history-item-time">{formatCreatedAt(summaryItem.created_at)}</span>
                        <span className="history-item-actions">
                          <button
                            type="button"
                            className="history-item-preview"
                            title="preview"
                            onClick={async () => {
                              setPreviewOpen(true);
                              setPreviewTitle(stripDisplayNameExtension(summaryItem.display_name));
                              setPreviewText("");
                              setPreviewLoading(true);
                              try {
                                const detail = await getSummary(summaryItem.id, { signal: apiAbortRef.current?.signal });
                                setPreviewText(detail.text);
                              } catch {
                                setPreviewText("Failed to load.");
                              } finally {
                                setPreviewLoading(false);
                              }
                            }}
                          >
                            <img src={previewIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-download"
                            title="download"
                            onClick={() => {
                              setPendingTranscriptionDownload(null);
                              setPendingTranslationDownload(null);
                              setPendingSummaryDownload(summaryItem);
                              setShowDownloadDialog(true);
                            }}
                          >
                            <img src={downloadIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-delete"
                            title="delete"
                            onClick={() => {
                              setPendingDeleteTranscriptionItem(null);
                              setPendingDeleteTranslationItem(null);
                              setPendingDeleteSummaryItem(summaryItem);
                            }}
                          >
                            <img src={deleteIcon} alt="" width={24} height={24} />
                          </button>
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>

            <div className="steps step-restructure">
              <section className="step">
                <div className="step-head">
                  <span className="step-title">⑧    Restructure:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">Restructure the transcript, translation and summary.</p>
                      <div className="step-inner">
                        <input
                          type="text"
                          id="step-restructure-input"
                          name="result-file"
                          className={`step-input${restructureResultFilesLabel ? " step-input-has-file" : ""}`}
                          placeholder="Click to choose result files"
                          aria-label="Selected result file names"
                          value={restructureResultFilesLabel}
                          title={restructureResultFilesLabel || undefined}
                          readOnly
                          onClick={() => setRestructureDialogOpen(true)}
                        />
                        {restructureSelectedCount > 0 && (
                          <button
                            type="button"
                            className="step-upload-clear"
                            onClick={() => {
                              setRestructureSelectedTranscriptionIds([]);
                              setRestructureSelectedTranslationIds([]);
                              setRestructureSelectedSummaryIds([]);
                              setRestructureResultFilesLabel("");
                            }}
                            aria-label="Clear selected result files"
                          >
                            ×
                          </button>
                        )}
                        <span className="step-input-addon">
                          {restructureSelectedCount > 0 ? (
                            <>
                              <span
                                className={restructureSelectedCount >= 3 ? "step-input-addon-strong" : ""}
                              >
                                {restructureSelectedCount}
                              </span>
                              {"\u00A0files"}
                            </>
                          ) : (
                            "files"
                          )}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="step-restructure-restructure"
                      disabled={
                        isRestructuring ||
                        restructureSelectedCount === 0 ||
                        !restructureResultFilesLabel
                      }
                      onClick={handleRestructure}
                    >
                      restructure
                    </button>
                    <button
                      type="button"
                      className="step-restructure-download"
                      disabled={!restructureResultText}
                      onClick={() => {
                        setDownloadSource("restructure");
                        setShowDownloadDialog(true);
                      }}
                    >
                      download
                    </button>
                  </div>
                </div>
                <div className="step-body">
                  <textarea
                    readOnly
                    className="step-restructure-result"
                    rows={8}
                    value={restructureResultText}
                  />
                </div>
              </section>
            </div>

            <div className="history-files">
              <button
                type="button"
                className={`history-toggle${restructureHistoryOpen ? " is-open" : ""}`}
                onClick={() => setRestructureHistoryOpen((o) => !o)}
              >
                {restructureHistoryOpen ? "Article history ↑" : "Article history ↓"}
              </button>
              {restructureHistoryOpen && (
                <ul className="history-list">
                  {restructureHistoryItems.length === 0 ? (
                    <li className="history-list-empty">No articles yet</li>
                  ) : (
                    restructureHistoryItems.map((item) => (
                      <li key={item.id} className="history-item">
                        <span
                          className="history-item-name"
                          title={item.display_name}
                        >
                          {item.display_name}
                        </span>
                        <span className="history-item-time">
                          {formatCreatedAt(item.created_at)}
                        </span>
                        <span className="history-item-actions">
                          <button
                            type="button"
                            className="history-item-wechat"
                            title="Push to Notion"
                            onClick={() => {
                              setPendingNotionArticleItem(item);
                            }}
                          >
                            <img src={notionIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-preview"
                            title="preview"
                            onClick={async () => {
                              setPreviewOpen(true);
                              setPreviewTitle(stripDisplayNameExtension(item.display_name));
                              setPreviewText("");
                              setPreviewLoading(true);
                              try {
                                const detail = await getArticle(item.id, { signal: apiAbortRef.current?.signal });
                                setPreviewText(detail.text);
                              } catch {
                                setPreviewText("Failed to load.");
                              } finally {
                                setPreviewLoading(false);
                              }
                            }}
                          >
                            <img src={previewIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-download"
                            title="download"
                            onClick={() => {
                              setPendingArticleDownload(item);
                              setShowDownloadDialog(true);
                            }}
                          >
                            <img src={downloadIcon} alt="" width={24} height={24} />
                          </button>
                          <button
                            type="button"
                            className="history-item-delete"
                            title="delete"
                            onClick={() => setPendingDeleteArticleItem(item)}
                          >
                            <img src={deleteIcon} alt="" width={24} height={24} />
                          </button>
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </div>
              </>
            )}
          </main>
        </div>
        <footer className="footer">
          <a href="https://www.lhjcjj.com" target="_blank" rel="noopener noreferrer" className="footer-link">
            <img src="/logo-v2-porcelain3.png" alt="" className="footer-link-icon" width={12} height={12} />
            www.lhjcjj.com
          </a>
        </footer>
      </div>

      {confirmCancelType !== null && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
          <div className="confirm-dialog">
            <p id="confirm-dialog-title" className="confirm-text">
              {confirmCancelType === "upload" ? "Cancel upload?" : "Cancel split?"}
            </p>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn confirm-btn-yes" onClick={handleConfirmCancel}>
                Yes
              </button>
              <button type="button" className="confirm-btn confirm-btn-no" onClick={() => setConfirmCancelType(null)}>
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {(pendingDeleteTranscriptionItem !== null ||
        pendingDeleteTranslationItem !== null ||
        pendingDeleteSummaryItem !== null ||
        pendingDeleteArticleItem !== null ||
        pendingNotionArticleItem !== null) && (
        <div
          className="confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
        >
          <div className="confirm-dialog">
            <p id="delete-confirm-title" className="confirm-text">
              {pendingNotionArticleItem !== null ? "Do you want to push to Notion?" : "Do you want to delete?"}
            </p>
            {pendingNotionArticleItem?.notion_url && (
              <p className="confirm-text" style={{ marginTop: 8, fontSize: "0.9em" }}>
                Last pushed:{" "}
                <a
                  href={pendingNotionArticleItem.notion_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open
                </a>
              </p>
            )}
            <div className="confirm-actions">
              {pendingNotionArticleItem !== null ? (
                <>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-yes"
                    onClick={async () => {
                      const item = pendingNotionArticleItem;
                      setPendingNotionArticleItem(null);
                      try {
                        const res = await exportArticleToNotion(item.id, "main", {
                          signal: apiAbortRef.current?.signal,
                        });
                        if (res.notion_url) {
                          window.open(res.notion_url, "_blank", "noopener,noreferrer");
                        }
                        listArticles({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
                          .then(setRestructureHistoryItems)
                          .catch(() => {});
                      } catch (err) {
                        // eslint-disable-next-line no-alert
                        alert(
                          err instanceof Error ? err.message : "Failed to export article to Notion"
                        );
                      }
                    }}
                  >
                    Main
                  </button>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-yes"
                    onClick={async () => {
                      const item = pendingNotionArticleItem;
                      setPendingNotionArticleItem(null);
                      try {
                        const res = await exportArticleToNotion(item.id, "alt", {
                          signal: apiAbortRef.current?.signal,
                        });
                        if (res.notion_url) {
                          window.open(res.notion_url, "_blank", "noopener,noreferrer");
                        }
                        listArticles({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
                          .then(setRestructureHistoryItems)
                          .catch(() => {});
                      } catch (err) {
                        // eslint-disable-next-line no-alert
                        alert(
                          err instanceof Error ? err.message : "Failed to export article to Notion"
                        );
                      }
                    }}
                  >
                    Alt
                  </button>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-no"
                    onClick={() => {
                      setPendingNotionArticleItem(null);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-yes"
                    onClick={async () => {
                      if (pendingDeleteTranscriptionItem !== null) {
                        await handleDeleteTranscriptionItem(pendingDeleteTranscriptionItem);
                        setPendingDeleteTranscriptionItem(null);
                      }
                      if (pendingDeleteTranslationItem !== null) {
                        await handleDeleteTranslationItem(pendingDeleteTranslationItem);
                        setPendingDeleteTranslationItem(null);
                      }
                      if (pendingDeleteSummaryItem !== null) {
                        await handleDeleteSummaryItem(pendingDeleteSummaryItem);
                        setPendingDeleteSummaryItem(null);
                      }
                      if (pendingDeleteArticleItem !== null) {
                        await handleDeleteArticleItem(pendingDeleteArticleItem);
                        setPendingDeleteArticleItem(null);
                      }
                    }}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-no"
                    onClick={() => {
                      setPendingDeleteTranscriptionItem(null);
                      setPendingDeleteTranslationItem(null);
                      setPendingDeleteSummaryItem(null);
                      setPendingDeleteArticleItem(null);
                    }}
                  >
                    No
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="preview-dialog-title" onClick={() => setPreviewOpen(false)}>
          <div className="confirm-dialog confirm-dialog-preview" onClick={(e) => e.stopPropagation()}>
            <p id="preview-dialog-title" className="confirm-text">{previewTitle}</p>
            <div className="preview-dialog-body">
              {previewLoading ? (
                <p className="preview-loading">Loading…</p>
              ) : (
                <textarea readOnly className="preview-textarea" rows={16} value={previewText} />
              )}
            </div>
            <div className="confirm-actions" style={{ marginTop: 12 }}>
              <button type="button" className="confirm-btn confirm-btn-no" onClick={() => setPreviewOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {podcastPreviewOpen && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="podcast-preview-dialog-title" onClick={() => { setPodcastPreviewOpen(false); if (!isUploading) setUploadingEpisodeUrl(null); }}>
          <div className="confirm-dialog confirm-dialog-preview confirm-dialog-preview-episodes" onClick={(e) => e.stopPropagation()}>
            <p id="podcast-preview-dialog-title" className="confirm-text">
              Podcast audio/video links
              {podcastPreviewFeedUrl ? (
                <span className="confirm-text-rss">{podcastPreviewFeedUrl}</span>
              ) : null}
            </p>
            <div className="preview-dialog-body">
              {podcastPreviewLoading ? (
                <p className="preview-loading">Loading…</p>
              ) : podcastPreviewLinks.length === 0 ? (
                <p className="preview-loading">No audio links found.</p>
              ) : (
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
                  <strong style={{ color: "var(--primary)", fontFamily: "Verdana, sans-serif", height: 24, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
                    Episodes
                  </strong>
                  <div
                    style={{
                      marginTop: 24,
                      flex: "1 1 0",
                      minHeight: 240,
                      maxHeight: 600,
                      overflowY: "auto",
                      overflowX: "hidden",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: 0,
                    }}
                  >
                    <ul className="episode-list" style={{ listStyle: "none", margin: 0, padding: 0, minWidth: 0 }}>
                      {podcastPreviewLinks.map((a, idx) => (
                        <li key={idx} className="history-item" style={{ borderBottom: "1px dotted var(--border)", paddingLeft: 12, paddingRight: 12, minWidth: 0 }}>
                          <label
                            className="episode-row"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              width: "100%",
                              minWidth: 0,
                              cursor: "pointer",
                            }}
                          >
                            {/* checkbox + title: flex, truncate */}
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                flex: "1 1 0",
                                minWidth: 0,
                              }}
                            >
                              <input
                                type="checkbox"
                                className="restructure-checkbox"
                                style={{ marginRight: 8 }}
                                checked={podcastPreviewSelectedIndices.includes(idx)}
                                onChange={(e) => {
                                  if (e.target.checked) setPodcastPreviewSelectedIndices((prev) => [...prev, idx].sort((x, y) => x - y));
                                  else setPodcastPreviewSelectedIndices((prev) => prev.filter((i) => i !== idx));
                                }}
                              />
                              <span className="history-item-name" title={a.title ?? a.url}>
                                {a.title ?? "-"}
                              </span>
                              {a.duration_seconds != null && (
                                <span className="history-item-time" style={{ marginLeft: 8, flexShrink: 0 }} title="Duration">
                                  {formatDuration(a.duration_seconds)}
                                </span>
                              )}
                              {a.length_bytes != null && a.length_bytes > 0 && (
                                <span className="history-item-time" style={{ marginLeft: 8, flexShrink: 0 }} title="File size">
                                  {formatFileSize(a.length_bytes)}
                                </span>
                              )}
                              {podcastPreviewNewUrls.has(a.url) && (
                                <img src={newsIcon} alt="" className="podcast-preview-new-icon" width={16} height={16} style={{ marginLeft: 6, flexShrink: 0 }} title="New episode" />
                              )}
                            </span>
                            {/* time: same level, middle */}
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                flex: "0 1 140px",
                                minWidth: 0,
                                justifyContent: "flex-end",
                              }}
                            >
                              <span className="history-item-time">{formatPubDate(a.pub_date)}</span>
                              <span
                                className={`episode-upload-progress${isUploading && uploadingEpisodeUrl === a.url && uploadProgress != null ? " episode-upload-progress--active" : ""}${!isUploading && isEpisodeUploadValid(a.url) ? " episode-upload-progress--uploaded" : ""}`}
                                style={{
                                  width: 72,
                                  height: 24,
                                  marginLeft: 8,
                                  flexShrink: 0,
                                  ...(isUploading && uploadingEpisodeUrl === a.url && uploadProgress != null
                                    ? ({ "--episode-progress": uploadProgress } as React.CSSProperties)
                                    : {}),
                                }}
                                title={isUploading && uploadingEpisodeUrl === a.url ? `Upload ${uploadProgress ?? 0}%` : isEpisodeUploadValid(a.url) ? "Uploaded" : undefined}
                              >
                                {isUploading && uploadingEpisodeUrl === a.url && uploadProgress != null
                                  ? `${uploadProgress}%`
                                  : isEpisodeUploadValid(a.url)
                                    ? "uploaded"
                                    : null}
                              </span>
                            </span>
                            {/* download + upload + split + transcribe + translate + link: fixed width, no shrink */}
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                flex: "0 0 276px",
                                gap: 12,
                                marginRight: 8,
                              }}
                            >
                              <button
                                type="button"
                                className="history-item-download"
                                title="download"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  downloadPodcastEpisodeAudio(
                                    a.url,
                                    podcastEpisodeDownloadName(a.title ?? undefined, a.url),
                                  );
                                }}
                              >
                                <img src={downloadIcon} alt="" width={24} height={24} />
                              </button>
                              <button
                                type="button"
                                className="history-item-upload"
                                title="upload"
                                disabled={isUploading || isEpisodeUploadValid(a.url)}
                                onClick={async (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const name = (a.title ?? "episode").trim() || "episode";
                                  try {
                                    await uploadFromUrlToTranscribe(a.url, name, a.length_bytes ?? undefined);
                                  } catch (err) {
                                    reportError("Failed to upload episode audio", err);
                                    alert(err instanceof Error ? err.message : "Upload failed");
                                  }
                                }}
                              >
                                <img src={uploadIcon} alt="" width={24} height={24} />
                              </button>
                              <button
                                type="button"
                                className="history-item-split"
                                title="split"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  // TODO: wire to split flow for this episode (a.url, a.title)
                                }}
                              >
                                <img src={splitIcon} alt="" width={24} height={24} />
                              </button>
                              <button
                                type="button"
                                className="history-item-transcribe"
                                title="transcribe"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  // TODO: wire to transcribe flow for this episode (a.url, a.title)
                                }}
                              >
                                <img src={transcribeIcon} alt="" width={24} height={24} />
                              </button>
                              <button
                                type="button"
                                className="history-item-translate"
                                title="translate"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  // TODO: wire to translate flow for this episode (a.url, a.title)
                                }}
                              >
                                <img src={translateIcon} alt="" width={24} height={24} />
                              </button>
                              <button
                                type="button"
                                className="history-item-summarize"
                                title="summarize"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  // TODO: wire to summarize flow for this episode (a.url, a.title)
                                }}
                              >
                                <img src={summarizeIcon} alt="" width={24} height={24} />
                              </button>
                              <button
                                type="button"
                                className="history-item-notion"
                                title="Push to Notion"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  // TODO: wire to push-to-notion flow for this episode (a.url, a.title)
                                }}
                              >
                                <img src={notionIcon} alt="" width={24} height={24} />
                              </button>
                              <a
                                href={a.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="history-item-download"
                                title={a.url}
                                onClick={(e) => e.stopPropagation()}
                                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                              >
                                <img src={linkIcon} alt="" width={24} height={24} />
                              </a>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <div className="confirm-actions" style={{ marginTop: 12 }}>
              {!podcastPreviewLoading && podcastPreviewLinks.length > 0 && (
                <>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-yes"
                    onClick={() => {
                      const lines = podcastPreviewLinks.filter((_, i) => podcastPreviewSelectedIndices.includes(i)).map((a) => `${formatPubDate(a.pub_date)}  ${a.title ?? "-"}  ${a.url}`);
                      navigator.clipboard.writeText(lines.join("\n"));
                      alert(lines.length ? "Copied." : "No selection.");
                    }}
                  >
                    Copy selected
                  </button>
                  <button
                    type="button"
                    className="confirm-btn confirm-btn-yes"
                    onClick={() => {
                      navigator.clipboard.writeText(podcastPreviewLinks.map((a) => `${formatPubDate(a.pub_date)}  ${a.title ?? "-"}  ${a.url}`).join("\n"));
                      alert("Copied.");
                    }}
                  >
                    Copy all
                  </button>
                </>
              )}
              <button type="button" className="confirm-btn confirm-btn-no" onClick={() => { setPodcastPreviewOpen(false); if (!isUploading) setUploadingEpisodeUrl(null); }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingSummarizeTranscriptionItem !== null && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="summarize-confirm-title">
          <div className="confirm-dialog">
            <p id="summarize-confirm-title" className="confirm-text">Do you want to summarize the transcript?</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-btn confirm-btn-yes"
                onClick={async () => {
                  const item = pendingSummarizeTranscriptionItem;
                  setPendingSummarizeTranscriptionItem(null);
                  if (item) {
                    await runSummarizeFromTranscriptionItem(item);
                  }
                }}
              >
                Yes
              </button>
              <button
                type="button"
                className="confirm-btn confirm-btn-no"
                onClick={() => setPendingSummarizeTranscriptionItem(null)}
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingSummarizeTranslationItem !== null && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="summarize-translation-confirm-title">
          <div className="confirm-dialog">
            <p id="summarize-translation-confirm-title" className="confirm-text">Do you want to summarize the translation?</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-btn confirm-btn-yes"
                onClick={async () => {
                  const item = pendingSummarizeTranslationItem;
                  setPendingSummarizeTranslationItem(null);
                  if (item) {
                    await runSummarizeFromTranslationItem(item);
                  }
                }}
              >
                Yes
              </button>
              <button
                type="button"
                className="confirm-btn confirm-btn-no"
                onClick={() => setPendingSummarizeTranslationItem(null)}
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}

      {showDownloadDialog && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="download-dialog-title">
          <div className="confirm-dialog">
            <p id="download-dialog-title" className="confirm-text">Choose file type.</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn confirm-btn-yes" onClick={() => handleDownloadDialogChoose("pdf")}>
                PDF
              </button>
              <button type="button" className="confirm-btn confirm-btn-yes" onClick={() => handleDownloadDialogChoose("txt")}>
                TXT
              </button>
              <button
                type="button"
                className="confirm-btn confirm-btn-no"
                onClick={() => {
                  setShowDownloadDialog(false);
                  setPendingTranscriptionDownload(null);
                  setPendingTranslationDownload(null);
                  setPendingSummaryDownload(null);
                  setPendingArticleDownload(null);
                  setDownloadSource(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingTranslateFromHistoryItem !== null && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="translate-direction-dialog-title">
          <div className="confirm-dialog">
            <p id="translate-direction-dialog-title" className="confirm-text">Choose translation direction.</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn confirm-btn-yes" onClick={() => handleTranslateDirectionChoose("en-cn")}>
                en→cn
              </button>
              <button type="button" className="confirm-btn confirm-btn-yes" onClick={() => handleTranslateDirectionChoose("cn-en")}>
                cn→en
              </button>
              <button type="button" className="confirm-btn confirm-btn-no" onClick={() => setPendingTranslateFromHistoryItem(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {restructureDialogOpen && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="restructure-dialog-title">
          <div className="confirm-dialog confirm-dialog-restructure">
            <p id="restructure-dialog-title" className="confirm-text">Choose result files (each type can have only one selected file).</p>
            <div className="preview-dialog-body">
              <div className="step-body" style={{ maxHeight: 360, minHeight: 0 }}>
                <div
                  className="step-inner"
                  style={{ display: "flex", flexDirection: "row", gap: 12, height: "100%" }}
                >
                {/* Transcriptions column */}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
                  <strong
                    style={{
                      color: "var(--primary)",
                      fontFamily: "Verdana, sans-serif",
                      height: 24,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "100%",
                    }}
                  >
                    Transcriptions
                  </strong>
                  {transcribeHistoryItems.length === 0 ? (
                    <span
                      className="history-list-empty"
                      style={{ padding: 0, height: 24, display: "flex", alignItems: "center" }}
                    >
                      No transcripts yet
                    </span>
                  ) : (
                    <div
                      style={{
                        marginTop: 12,
                        maxHeight: 600,
                        overflowY: "auto",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: 0,
                      }}
                    >
                      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {transcribeHistoryItems.map((item) => (
                          <li
                            key={item.id}
                            className="history-item"
                            style={{ borderBottom: "1px dotted var(--border)", paddingLeft: 12, paddingRight: 12 }}
                          >
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                width: "100%",
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="checkbox"
                                className="restructure-checkbox"
                                style={{ marginRight: 8 }}
                                checked={restructureSelectedTranscriptionIds.includes(item.id)}
                                onChange={(e) =>
                                  setRestructureSelectedTranscriptionIds((prev) =>
                                    e.target.checked ? [item.id] : prev.filter((id) => id !== item.id),
                                  )
                                }
                              />
                              <span
                                className="history-item-name"
                                title={stripDisplayNameExtension(item.display_name)}
                              >
                                {stripDisplayNameExtension(item.display_name)}
                              </span>
                              <span className="history-item-time">
                                {formatCreatedAt(item.created_at)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Translations column */}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
                  <strong
                    style={{
                      color: "var(--primary)",
                      fontFamily: "Verdana, sans-serif",
                      height: 24,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "100%",
                    }}
                  >
                    Translations
                  </strong>
                  {translateHistoryItems.length === 0 ? (
                    <span
                      className="history-list-empty"
                      style={{ padding: 0, height: 24, display: "flex", alignItems: "center" }}
                    >
                      No translations yet
                    </span>
                  ) : (
                    <div
                      style={{
                        marginTop: 12,
                        maxHeight: 600,
                        overflowY: "auto",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: 0,
                      }}
                    >
                      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {translateHistoryItems.map((item) => (
                          <li
                            key={item.id}
                            className="history-item"
                            style={{ borderBottom: "1px dotted var(--border)", paddingLeft: 12, paddingRight: 12 }}
                          >
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                width: "100%",
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="checkbox"
                                className="restructure-checkbox"
                                style={{ marginRight: 8 }}
                                checked={restructureSelectedTranslationIds.includes(item.id)}
                                onChange={(e) =>
                                  setRestructureSelectedTranslationIds((prev) =>
                                    e.target.checked ? [item.id] : prev.filter((id) => id !== item.id),
                                  )
                                }
                              />
                              <span
                                className="history-item-name"
                                title={stripDisplayNameExtension(item.display_name)}
                              >
                                {stripDisplayNameExtension(item.display_name)}
                              </span>
                              <span className="history-item-time">
                                {formatCreatedAt(item.created_at)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Summaries column */}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
                  <strong
                    style={{
                      color: "var(--primary)",
                      fontFamily: "Verdana, sans-serif",
                      height: 24,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "100%",
                    }}
                  >
                    Summaries
                  </strong>
                  {summarizeHistoryItems.length === 0 ? (
                    <span
                      className="history-list-empty"
                      style={{ padding: 0, height: 24, display: "flex", alignItems: "center" }}
                    >
                      No summaries yet
                    </span>
                  ) : (
                    <div
                      style={{
                        marginTop: 12,
                        maxHeight: 600,
                        overflowY: "auto",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: 0,
                      }}
                    >
                      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {summarizeHistoryItems.map((item) => (
                          <li
                            key={item.id}
                            className="history-item"
                            style={{ borderBottom: "1px dotted var(--border)", paddingLeft: 12, paddingRight: 12 }}
                          >
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                width: "100%",
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="checkbox"
                                className="restructure-checkbox"
                                style={{ marginRight: 8 }}
                                checked={restructureSelectedSummaryIds.includes(item.id)}
                                onChange={(e) =>
                                  setRestructureSelectedSummaryIds((prev) => {
                                    if (e.target.checked) {
                                      if (prev.includes(item.id)) return prev;
                                      if (prev.length >= 2) return prev; // max 2 summaries
                                      return [...prev, item.id];
                                    }
                                    return prev.filter((id) => id !== item.id);
                                  })
                                }
                              />
                              <span
                                className="history-item-name"
                                title={stripDisplayNameExtension(item.display_name)}
                              >
                                {stripDisplayNameExtension(item.display_name)}
                              </span>
                              <span className="history-item-time">
                                {formatCreatedAt(item.created_at)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
              </div>
            </div>
            <div className="confirm-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="confirm-btn confirm-btn-yes"
                onClick={() => {
                  const names: string[] = [];
                  if (restructureSelectedTranscriptionIds.length) {
                    const item = transcribeHistoryItems.find(
                      (x) => x.id === restructureSelectedTranscriptionIds[0],
                    );
                    if (item) names.push(stripDisplayNameExtension(item.display_name));
                  }
                  if (restructureSelectedTranslationIds.length) {
                    const item = translateHistoryItems.find(
                      (x) => x.id === restructureSelectedTranslationIds[0],
                    );
                    if (item) names.push(stripDisplayNameExtension(item.display_name));
                  }
                  if (restructureSelectedSummaryIds.length) {
                    restructureSelectedSummaryIds.slice(0, 2).forEach((sid) => {
                      const item = summarizeHistoryItems.find((x) => x.id === sid);
                      if (item) names.push(stripDisplayNameExtension(item.display_name));
                    });
                  }
                  setRestructureResultFilesLabel(names.join(", "));
                  setRestructureDialogOpen(false);
                }}
              >
                Confirm
              </button>
              <button
                type="button"
                className="confirm-btn confirm-btn-no"
                onClick={() => setRestructureDialogOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
