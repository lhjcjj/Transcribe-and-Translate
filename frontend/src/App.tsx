import { useEffect, useRef, useState } from "react";
import { cancelSplitStream, deleteUpload, getUploadDuration, transcribe, transcribeByUploadIdsStream, upload } from "./api/client";
import { useSplitFlow } from "./hooks/useSplitFlow";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB, match backend

function clampChunkInput(raw: string): string {
  if (raw === "") return "";
  const n = parseInt(raw, 10);
  if (n > 10) return "10";
  if (n < 1) return "1";
  return raw;
}

export default function App() {
  const [langOption, setLangOption] = useState<"auto" | "en" | "zh">("auto");
  const [cleanOption, setCleanOption] = useState<"yes" | "no">("yes");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [chunkSizeInput, setChunkSizeInput] = useState("5");
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!isSplitting) setIsCancellingSplit(false);
  }, [isSplitting]);

  const chunkSizeMin = Math.max(1, Math.min(10, parseInt(chunkSizeInput, 10) || 5));
  const clearUploadState = () => {
    setUploadId(null);
    setUploadDurationSeconds(null);
  };
  const clearFileSelection = () => {
    setUploadFileName("");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const { doSplit, isSplitting, splitProgress, splitAbortRef } = useSplitFlow(
    uploadId,
    chunkSizeMin,
    (chunks) => {
      setSplitChunkIds(chunks.map((c) => c.upload_id));
      clearUploadState();
    },
    clearUploadState
  );

  const hasFile = Boolean(uploadFileName);
  const isUploaded = Boolean(uploadId);
  const hasChunks = splitChunkIds != null && splitChunkIds.length > 0;
  const fileTooBig = selectedFile != null && selectedFile.size > MAX_UPLOAD_BYTES;
  const fileSizeMB = selectedFile
    ? Math.round(selectedFile.size / (1024 * 1024))
    : null;
  const fileOver25MB = fileSizeMB != null && fileSizeMB > 25;
  const uploadStepDisabled =
    isUploading || isDeletingUpload || isSplitting || isTranscribing || (isUploaded && uploadDurationSeconds == null);
  const splitStepDisabled =
    !isUploaded || isDeletingUpload || uploadDurationSeconds == null || (isTranscribing && !hasChunks);
  const canTranscribe = hasChunks || (isUploaded && !fileOver25MB);
  const segmentCount =
    uploadDurationSeconds != null && chunkSizeMin > 0
      ? Math.ceil(uploadDurationSeconds / (chunkSizeMin * 60))
      : null;
  const fileSizeAddonSuffix =
    selectedFile == null
      ? "MB:%"
      : isUploading && uploadProgress != null
        ? ` MB: ${uploadProgress}%`
        : isUploaded
          ? " MB: 100%"
          : " MB:%";
  const fileSizeAddon =
    fileSizeMB != null ? (
      <>
        {fileSizeMB > 100 ? (
          <strong>&gt;100</strong>
        ) : fileSizeMB > 25 ? (
          <strong>{fileSizeMB}</strong>
        ) : (
          fileSizeMB
        )}
        {fileSizeAddonSuffix}
      </>
    ) : (
      "MB:%"
    );

  const deleteUploadAndClearUploadState = async (idToDelete: string | null) => {
    if (idToDelete) {
      try {
        await deleteUpload(idToDelete);
      } catch {
        /* ignore (e.g. 404 = already gone) */
      }
    }
    clearUploadState();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (splitChunkIds?.length) {
      await Promise.allSettled(
        splitChunkIds.map((id) => deleteUpload(id))
      );
    }
    if (failedChunkIds?.length) {
      await Promise.allSettled(
        failedChunkIds.map((id) => deleteUpload(id))
      );
      setFailedChunkIds(null);
    }
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
  };

  const handleClear = async () => {
    if (splitChunkIds?.length) {
      await Promise.allSettled(splitChunkIds.map((id) => deleteUpload(id)));
    }
    if (failedChunkIds?.length) {
      await Promise.allSettled(failedChunkIds.map((id) => deleteUpload(id)));
      setFailedChunkIds(null);
    }
    await deleteUploadAndClearUploadState(uploadId);
    setSplitChunkIds(null);
    clearFileSelection();
  };

  const handleBrowse = () => {
    fileInputRef.current?.click();
  };

  const handleConfirmCancel = async () => {
    const type = confirmCancelType;
    setConfirmCancelType(null); // close dialog immediately so one click is enough
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
      cancelSplitStream().catch(() => {});
      splitAbortRef.current?.abort();
      clearUploadState();
    }
  };

  const handleUploadOrCancel = async () => {
    if (isUploading) {
      setConfirmCancelType("upload");
      return;
    }
    if (!selectedFile) return;
    if (failedChunkIds?.length) {
      await Promise.allSettled(failedChunkIds.map((id) => deleteUpload(id)));
      setFailedChunkIds(null);
      setFailedChunkIndices(null);
      setTranscribeSegments(null);
    }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const res = await upload(selectedFile, {
        signal: controller.signal,
        onProgress: (p) => setUploadProgress(p.percent),
      });
      setUploadId(res.upload_id);
      if (res.duration_seconds != null) {
        setUploadDurationSeconds(res.duration_seconds);
        setUploadProgress(100);
        setIsUploading(false);
        setUploadProgress(null);
      } else {
        setUploadProgress(99);
        const fetchDuration = async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const d = await getUploadDuration(res.upload_id);
              setUploadDurationSeconds(d.duration_seconds);
              return;
            } catch {
              if (attempt === 1) throw new Error("Failed to get duration");
            }
          }
        };
        fetchDuration()
          .then(() => {
            setUploadProgress(100);
            setIsUploading(false);
            setUploadProgress(null);
          })
          .catch(() => {
            setIsUploading(false);
            setUploadProgress(null);
          });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        // show or log error
      }
      setIsUploading(false);
      setUploadProgress(null);
    } finally {
      uploadAbortRef.current = null;
    }
  };

  const handleSplit = () => {
    if (isSplitting) {
      setConfirmCancelType("split");
      return;
    }
    doSplit();
  };

  const handleTranscribe = async () => {
    if (!canTranscribe || isTranscribing) return;
    if (hasChunks ? !splitChunkIds?.length : !selectedFile) return;
    setTranscribeError(null);
    setTranscribeText(null);
    setTranscribeSegments(null);
    setFailedChunkIds(null);
    setFailedChunkIndices(null);
    setTranscribeChunkProgress(null);
    setIsTranscribing(true);
    try {
      const result = hasChunks
        ? await transcribeByUploadIdsStream(
            splitChunkIds!,
            (current, total, filename) => setTranscribeChunkProgress({ current, total, filename }),
            {
              cleanupFailed: false,
              language: langOption,
              cleanUp: cleanOption === "yes",
            }
          )
        : await transcribe(selectedFile!, {
            language: langOption,
            cleanUp: cleanOption === "yes",
          });
      setTranscribeText(result.text);
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
      setTranscribeError((e as Error).message);
    } finally {
      setIsTranscribing(false);
      setTranscribeChunkProgress(null);
    }
  };

  const handleDownloadTranscribe = () => {
    if (!transcribeText) return;
    const blob = new Blob([transcribeText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRetryFailedChunks = async () => {
    if (!failedChunkIds?.length || !transcribeSegments || !failedChunkIndices?.length || isTranscribing) return;
    setTranscribeError(null);
    setTranscribeChunkProgress(null);
    setIsTranscribing(true);
    try {
      const result = await transcribeByUploadIdsStream(
        failedChunkIds,
        (current, total, filename) => setTranscribeChunkProgress({ current, total, filename }),
        {
          cleanupFailed: false,
          language: langOption,
          cleanUp: cleanOption === "yes",
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
      setTranscribeError((e as Error).message);
    } finally {
      setIsTranscribing(false);
      setTranscribeChunkProgress(null);
    }
  };

  const stepLogText =
    transcribeChunkProgress != null
      ? transcribeChunkProgress.filename
      : isTranscribing
        ? "Transcribing…"
        : "Tasks information";

  return (
    <div className="app">
      <div className="main-wrapper">
        <header className="header">
          <img src="/logo-v2-porcelain3.png" alt="" className="logo" />
          <span className="brand-name">LHJCJJ.Tools</span>
          <a href="#" className="btn-signup">sign up</a>
          <a href="#" className="btn-login">log in</a>
          <p className="notice">
            Notices: 2026.01.01 Release Transcribe and Translate Tool, transcribe audios to texts, and translate English to Chinese.
          </p>
        </header>

        <div className="content-layout">
          <nav className="sub-nav">
            <a href="#" className="sub-nav-link">Home</a>
            <a href="#" className="sub-nav-active">Transcribe and Translate</a>
          </nav>

          <main className="main">
            <h1 className="main-title">Transcribe and Translate</h1>

            <div className="intro">
              <span className="intro-label">Introduction：</span>
              <span className="intro-placeholder">………………………………………………………………………………………………………………………………………………………………………………………………</span>
            </div>

            <div className="steps">
              <section className="step">
                <div className="step-head">
                  <span className="step-title">①    Upload audio files:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">default</p>
                      <div className="step-inner">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac"
                          aria-hidden="true"
                          tabIndex={-1}
                          style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
                          onChange={handleFileChange}
                          disabled={uploadStepDisabled}
                        />
                        <input
                          type="text"
                          id="step-upload-input"
                          name="audio-file"
                          className={`step-input${uploadFileName ? " step-input-has-file" : ""}`}
                          placeholder="Select an audio file to upload"
                          readOnly
                          value={uploadFileName}
                          disabled={uploadStepDisabled}
                          aria-label="Selected audio file name"
                        />
                        {hasFile && !uploadStepDisabled ? (
                          <button
                            type="button"
                            className="step-upload-clear"
                            onClick={handleClear}
                            aria-label="Clear selected file"
                          >
                            ×
                          </button>
                        ) : null}
                        <span className="step-input-addon">{fileSizeAddon}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="step-upload-browse"
                      onClick={handleBrowse}
                      disabled={uploadStepDisabled}
                    >
                      browse
                    </button>
                    <button
                      type="button"
                      className="step-upload-upload"
                      disabled={!hasFile || isUploaded || fileTooBig || isDeletingUpload || hasChunks}
                      onClick={handleUploadOrCancel}
                    >
                      {fileTooBig
                        ? ">100MB!!!"
                        : isDeletingUpload
                          ? "del..."
                          : isUploading
                            ? "cancel"
                            : "upload"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="step">
                <div className="step-head">
                  <span className="step-title">②    Split into chunks:</span>
                  <div className="step-row">
                    <div className="step-wrap">
                      <p className="step-desc">If the audio file exceeds 25 MB, it must be split into smaller chunks.</p>
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
                            const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                            setChunkSizeInput(raw === "" ? "" : clampChunkInput(raw));
                          }}
                          onBlur={() => setChunkSizeInput(String(chunkSizeMin))}
                        />
                        <span className="step-input-suffix"> mins</span>
                        <span className="step-input-addon">
                          {isSplitting && splitProgress
                            ? `${splitProgress.current}/${splitProgress.current === 0 && segmentCount != null ? segmentCount : splitProgress.total} chunks`
                            : hasChunks
                              ? `${splitChunkIds!.length}/${splitChunkIds!.length} chunks`
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
                        <div role="log" className={`step-log${stepLogText === "Tasks information" ? " step-log-default" : ""}`}><span className="step-log-text">{stepLogText}</span></div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="step-transcribe-transcribe"
                      disabled={isTranscribing || isDeletingUpload || (!failedChunkIds?.length && !canTranscribe)}
                      onClick={failedChunkIds?.length ? handleRetryFailedChunks : handleTranscribe}
                    >
                      {isTranscribing ? "transcribing…" : failedChunkIds?.length ? "retry failed" : "transcribe"}
                    </button>
                    <button type="button" className="step-transcribe-download" disabled={!transcribeText} onClick={handleDownloadTranscribe}>download</button>
                  </div>
                </div>
                <div className="step-body">
                  {transcribeError && <p className="step-error" role="alert">{transcribeError}</p>}
                  <textarea readOnly className="step-transcribe-result" value={transcribeText ?? ""} rows={8} />
                </div>
              </section>
            </div>

            <div className="history-files">
              <button type="button" className={`history-toggle${historyOpen ? " is-open" : ""}`} onClick={() => setHistoryOpen((o) => !o)}>
                {historyOpen ? "Transcription history ↑" : "Transcription history ↓"}
              </button>
              {historyOpen && (
                <ul className="history-list">
                  <li className="history-list-empty">No files yet</li>
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
    </div>
  );
}
