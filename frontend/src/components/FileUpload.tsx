import { useRef } from "react";

const ACCEPT = "audio/mpeg,audio/mp3,audio/wav,audio/webm,audio/mp4,audio/x-m4a,audio/*";

interface FileUploadProps {
  onSelect: (file: File) => void;
  disabled?: boolean;
  loading?: boolean;
}

export function FileUpload({ onSelect, disabled, loading }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="section">
      <label className="label">Audio file</label>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onSelect(f);
          e.target.value = "";
        }}
        style={{ display: "none" }}
      />
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => inputRef.current?.click()}
      >
        {loading ? "Transcribing…" : "Choose file"}
      </button>
    </div>
  );
}
