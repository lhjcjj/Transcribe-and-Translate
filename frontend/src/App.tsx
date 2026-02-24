import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import {
  cancelSplitStream,
  deleteTranscription,
  deleteUpload,
  getTranscription,
  getUploadConfig,
  getUploadDuration,
  listTranscriptions,
  transcribe,
  transcribeByUploadIdsStream,
  upload,
  TranscribeApiResult,
  TranscribeEngine,
  TranscriptionListItem,
} from "./api/client";
import { FileUpload } from "./components/FileUpload";
import { TranscribeResult } from "./components/TranscribeResult";
import { useSplitFlow } from "./hooks/useSplitFlow";

/** UI display threshold (MB): show split hint when file exceeds this. Actual limit from API. */
const DISPLAY_SPLIT_THRESHOLD_MB = 25;
/** UI display cap (MB): show ">N MB" when file exceeds this. Actual limit from API. */
const DISPLAY_UPLOAD_MAX_MB = 100;

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
  const [historyOpen, setHistoryOpen] = useState(true);
  const [uploadFileName, setUploadFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
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
  const [pendingHistoryDownload, setPendingHistoryDownload] = useState<TranscriptionListItem | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<TranscriptionListItem | null>(null);
  const [historyItems, setHistoryItems] = useState<TranscriptionListItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const apiAbortRef = useRef<AbortController | null>(null);
  const configAbortRef = useRef<AbortController | null>(null);
  const durationAbortRef = useRef<AbortController | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const uploadGenerationRef = useRef(0);
  const downloadRevokeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);
  const [transcribeEngine, setTranscribeEngine] = useState<TranscribeEngine>("faster_whisper");

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
    };
  }, []);

  const HISTORY_PAGE_SIZE = 50;

  useEffect(() => {
    if (!historyOpen) return;
    setHistoryLoading(true);
    setHistoryHasMore(true);
    listTranscriptions({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => {
        setHistoryItems(data);
        setHistoryHasMore(data.length >= HISTORY_PAGE_SIZE);
      })
      .catch(() => setHistoryItems([]))
      .finally(() => setHistoryLoading(false));
  }, [historyOpen]);

  // After a successful transcribe, refresh history list if panel is open so the new item appears.
  useEffect(() => {
    if (!historyOpen || !transcribeText) return;
    listTranscriptions({ limit: HISTORY_PAGE_SIZE, offset: 0, signal: apiAbortRef.current?.signal })
      .then((data) => {
        setHistoryItems(data);
        setHistoryHasMore(data.length >= HISTORY_PAGE_SIZE);
      })
      .catch(() => {});
  }, [historyOpen, transcribeText]);

  const handleHistoryLoadMore = useCallback(() => {
    if (historyLoadingMore || !historyHasMore) return;
    setHistoryLoadingMore(true);
    listTranscriptions({
      limit: HISTORY_PAGE_SIZE,
      offset: historyItems.length,
      signal: apiAbortRef.current?.signal,
    })
      .then((data) => {
        setHistoryItems((prev) => [...prev, ...data]);
        setHistoryHasMore(data.length >= HISTORY_PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setHistoryLoadingMore(false));
  }, [historyLoadingMore, historyHasMore, historyItems.length]);

  useEffect(() => {
    const controller = new AbortController();
    configAbortRef.current = controller;
    getUploadConfig({ signal: controller.signal })
      .then((c) => setMaxUploadBytes(c.max_upload_bytes))
      .catch((err) => {
        console.error("Failed to load upload config");
        // Only in dev; production build does not expose stack.
        if (import.meta.env.DEV && err) console.error(err);
      })
      .finally(() => {
        configAbortRef.current = null;
      });
  }, []);

  const chunkSizeMin = useMemo(
    () =>
      Math.max(
        CHUNK_SIZE_MIN,
        Math.min(CHUNK_SIZE_MAX, parseInt(chunkSizeDebounced, 10) || 5)
      ),
    [chunkSizeDebounced]
  );
  const clearUploadState = useCallback(() => {
    setUploadId(null);
    setUploadDurationSeconds(null);
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
  const { doSplit, isSplitting, splitProgress, splitAbortRef } = useSplitFlow(
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
    () => (selectedFile ? Math.round(selectedFile.size / (1024 * 1024)) : null),
    [selectedFile]
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
      !isUploaded ||
      isDeletingUpload ||
      uploadDurationSeconds == null ||
      (isTranscribing && !hasChunks),
    [isUploaded, isDeletingUpload, uploadDurationSeconds, isTranscribing, hasChunks]
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
      selectedFile == null
        ? "MB:%"
        : isUploading && uploadProgress != null
          ? ` MB: ${uploadProgress}%`
          : isUploaded
            ? " MB: 100%"
            : " MB:%",
    [selectedFile, isUploading, uploadProgress, isUploaded]
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
          {fileSizeAddonSuffix}
        </>
      ) : (
        "MB:%"
      ),
    [fileSizeMB, fileSizeAddonSuffix]
  );

  const deleteUploadAndClearUploadState = useCallback(
    async (idToDelete: string | null) => {
      if (idToDelete) {
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
          console.error("Cancel split request failed");
          if (import.meta.env.DEV && err) console.error(err);
        } finally {
          splitAbortRef.current?.abort();
          clearUploadState();
          const elapsed = Date.now() - startAt;
          const delay = Math.max(0, minDelDisplayMs - elapsed);
          if (delay > 0) {
            setTimeout(() => setIsCancellingSplit(false), delay);
          } else {
            setIsCancellingSplit(false);
          }
        }
      }
    },
    [confirmCancelType, uploadId, deleteUploadAndClearUploadState, clearFileSelection, clearUploadState]
  );

  const handleUploadOrCancel = useCallback(
    async () => {
      if (isUploading) {
        setConfirmCancelType("upload");
        return;
      }
      if (!selectedFile) return;
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
        const res = await upload(selectedFile, {
          signal: controller.signal,
          onProgress: (p) => setUploadProgress(p.percent),
        });
        setUploadId(res.upload_id);
        setIsCancellingSplit(false);
        if (res.duration_seconds != null) {
          setUploadDurationSeconds(res.duration_seconds);
          setUploadProgress(100);
          setIsUploading(false);
          setUploadProgress(null);
        } else {
          setUploadProgress(99);
          const controller = new AbortController();
          durationAbortRef.current = controller;
          const fetchDuration = async () => {
            for (let attempt = 0; attempt < DURATION_FETCH_MAX_ATTEMPTS; attempt++) {
              try {
                const d = await getUploadDuration(res.upload_id, {
                  signal: controller.signal,
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
          console.error("Upload failed");
          if (import.meta.env.DEV) console.error(err); // dev only; production does not expose stack
        }
        setIsUploading(false);
        setUploadProgress(null);
      } finally {
        uploadAbortRef.current = null;
      }
    },
    [isUploading, selectedFile, splitChunkIds, failedChunkIds]
  );

  const handleSplit = useCallback(() => {
    if (isSplitting) {
      setConfirmCancelType("split");
      return;
    }
    doSplit();
  }, [isSplitting, doSplit]);

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
        if (result.failed_chunk_ids?.length && result.text_segments && result.failed_chunk_indices?.length) {
          setTranscribeSegments(result.text_segments);
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

  const handleDownloadTranscribe = useCallback((format: "txt" | "pdf") => {
    if (!transcribeText) return;
    doDownload(transcribeText, format, downloadBaseName(uploadFileName));
  }, [transcribeText, uploadFileName, doDownload]);

  const handleDownloadDialogChoose = useCallback(async (format: "pdf" | "txt") => {
    const item = pendingHistoryDownload;
    setShowDownloadDialog(false);
    setPendingHistoryDownload(null);
    if (item) {
      try {
        const detail = await getTranscription(item.id, { signal: apiAbortRef.current?.signal });
        doDownload(detail.text, format, item.display_name);
      } catch {
        // Error from getTranscription; dialog already closed
      }
      return;
    }
    if (transcribeText) doDownload(transcribeText, format, downloadBaseName(uploadFileName));
  }, [pendingHistoryDownload, transcribeText, uploadFileName, doDownload]);

  const handleHistoryDelete = useCallback(async (item: TranscriptionListItem) => {
    try {
      await deleteTranscription(item.id, { signal: apiAbortRef.current?.signal });
      setHistoryItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch {
      // Error already user-facing from deleteTranscription; keep list unchanged
    }
  }, []);

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
            ? (uploadFileName || transcribeChunkProgress?.filename || "Task information")
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
            <a href="#" className="sub-nav-link">Home</a>
            <a href="#" className="sub-nav-active">Transcribe and Translate</a>
          </nav>

          <main className="main">
            <div className="main-title-row">
              <h1 className="main-title">Transcribe and Translate</h1>
              <div className="engine-toggle" role="group" aria-label="Transcription engine">
                <button
                  type="button"
                  className={`engine-option ${transcribeEngine === "faster_whisper" ? "is-active" : ""}`}
                  onClick={() => setTranscribeEngine("faster_whisper")}
                >
                  Local
                </button>
                <button
                  type="button"
                  className={`engine-option ${transcribeEngine === "openai" ? "is-active" : ""}`}
                  onClick={() => setTranscribeEngine("openai")}
                >
                  OpenAI
                </button>
              </div>
            </div>

            <div className="intro">
              <span className="intro-label">Introduction: </span>
              <span className="intro-placeholder" title="Transcribe .mp3、.mp4、.mpeg、.mpga、.m4a、.wav、.webm into .txt">Transcribe .mp3、.mp4、.mpeg、.mpga、.m4a、.wav、.webm into .txt</span>
            </div>

            <div className="steps">
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
                          placeholder="5"
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
                    <button type="button" className="step-transcribe-download" disabled={!transcribeText} onClick={() => { setPendingHistoryDownload(null); setShowDownloadDialog(true); }}>download</button>
                  </div>
                </div>
                <TranscribeResult text={transcribeText} error={transcribeError} />
              </section>
            </div>

            <div className="history-files">
              <button type="button" className={`history-toggle${historyOpen ? " is-open" : ""}`} onClick={() => setHistoryOpen((o) => !o)}>
                {historyOpen ? "Transcription history ↑" : "Transcription history ↓"}
              </button>
              {historyOpen && (
                <ul className="history-list">
                  {historyLoading ? (
                    <li className="history-list-empty">Loading…</li>
                  ) : historyItems.length === 0 ? (
                    <li className="history-list-empty">No files yet</li>
                  ) : (
                    <>
                      {historyItems.map((item) => (
                        <li key={item.id} className="history-item">
                          <span className="history-item-name" title={item.display_name}>{item.display_name}</span>
                          <span className="history-item-time">{formatCreatedAt(item.created_at)}</span>
                          <span className="history-item-actions">
                            <button type="button" className="history-item-download" onClick={() => { setPendingHistoryDownload(item); setShowDownloadDialog(true); }}>download</button>
                            <button type="button" className="history-item-delete" onClick={() => setPendingDeleteItem(item)}>delete</button>
                          </span>
                        </li>
                      ))}
                      {historyHasMore && (
                        <li className="history-list-load-more">
                          <button type="button" className="history-load-more-btn" disabled={historyLoadingMore} onClick={handleHistoryLoadMore}>
                            {historyLoadingMore ? "Loading…" : "Load more"}
                          </button>
                        </li>
                      )}
                    </>
                  )}
                </ul>
              )}
            </div>
          </main>
        </div>
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

      {pendingDeleteItem !== null && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
          <div className="confirm-dialog">
            <p id="delete-confirm-title" className="confirm-text">Do you want to delete?</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-btn confirm-btn-yes"
                onClick={async () => {
                  await handleHistoryDelete(pendingDeleteItem);
                  setPendingDeleteItem(null);
                }}
              >
                Yes
              </button>
              <button type="button" className="confirm-btn confirm-btn-no" onClick={() => setPendingDeleteItem(null)}>
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
              <button type="button" className="confirm-btn confirm-btn-no" onClick={() => { setShowDownloadDialog(false); setPendingHistoryDownload(null); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
