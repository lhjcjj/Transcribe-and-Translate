import { RefObject } from "react";

export interface FileUploadProps {
  inputRef: RefObject<HTMLInputElement>;
  fileName: string;
  fileSizeAddon: React.ReactNode;
  hasFile: boolean;
  disabled: boolean;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  onBrowse: () => void;
  uploadButtonDisabled: boolean;
  uploadButtonText: string;
  onUploadOrCancel: () => void;
  /** When set during upload, addon shows progress fill (0–100). */
  uploadProgress?: number | null;
  isUploading?: boolean;
}

export function FileUpload({
  inputRef,
  fileName,
  fileSizeAddon,
  hasFile,
  disabled,
  onFileChange,
  onClear,
  onBrowse,
  uploadButtonDisabled,
  uploadButtonText,
  onUploadOrCancel,
  uploadProgress = null,
  isUploading = false,
}: FileUploadProps) {
  const showProgress = isUploading && uploadProgress != null;
  return (
    <section className="step">
      <div className="step-head">
        <span className="step-title">①    Upload audio files:</span>
        <div className="step-row">
          <div className="step-wrap">
            <p className="step-desc">default</p>
            <div className="step-inner">
              <input
                ref={inputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac"
                aria-hidden="true"
                tabIndex={-1}
                style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
                onChange={onFileChange}
                disabled={disabled}
              />
              <input
                type="text"
                id="step-upload-input"
                name="audio-file"
                className={`step-input${fileName ? " step-input-has-file" : ""}`}
                placeholder="Select an audio file to upload"
                readOnly
                value={fileName}
                disabled={disabled}
                aria-label="Selected audio file name"
                title={fileName || undefined}
              />
              {hasFile && !disabled ? (
                <button
                  type="button"
                  className="step-upload-clear"
                  onClick={onClear}
                  aria-label="Clear selected file"
                >
                  ×
                </button>
              ) : null}
              <span
                className={`step-input-addon${showProgress ? " step-input-addon--progress" : ""}`}
                style={showProgress ? ({ "--progress": uploadProgress } as React.CSSProperties) : undefined}
              >
                {fileSizeAddon}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="step-upload-browse"
            onClick={onBrowse}
            disabled={disabled}
          >
            browse
          </button>
          <button
            type="button"
            className="step-upload-upload"
            disabled={uploadButtonDisabled}
            onClick={onUploadOrCancel}
          >
            {uploadButtonText}
          </button>
        </div>
      </div>
    </section>
  );
}
