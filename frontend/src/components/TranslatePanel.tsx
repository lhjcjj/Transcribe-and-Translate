interface TranslatePanelProps {
  targetLang: string;
  onTargetLangChange: (v: string) => void;
  translatedText: string;
  onTranslate: () => void;
  translating?: boolean;
  onCopy: () => void;
  onDownload: () => void;
}

const COMMON_LANGS = [
  { value: "English", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "ja", label: "日本語" },
  { value: "Spanish", label: "Spanish" },
  { value: "French", label: "French" },
];

export function TranslatePanel({
  targetLang,
  onTargetLangChange,
  translatedText,
  onTranslate,
  translating,
  onCopy,
  onDownload,
}: TranslatePanelProps) {
  return (
    <div className="section">
      <label className="label">Target language</label>
      <select
        value={targetLang}
        onChange={(e) => onTargetLangChange(e.target.value)}
        style={{
          width: "100%",
          padding: "0.5rem",
          borderRadius: "6px",
          border: "1px solid #ccc",
          background: "#fff",
          color: "#000",
          marginBottom: "0.5rem",
        }}
      >
        {COMMON_LANGS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button type="button" onClick={onTranslate} disabled={translating} style={{ marginBottom: "0.75rem" }}>
        {translating ? "Translating…" : "Translate"}
      </button>
      <label className="label">Translation</label>
      <textarea readOnly value={translatedText} style={{ minHeight: "100px" }} />
      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={onCopy} disabled={!translatedText}>
          Copy
        </button>
        <button type="button" onClick={onDownload} disabled={!translatedText}>
          Download .txt
        </button>
      </div>
    </div>
  );
}
