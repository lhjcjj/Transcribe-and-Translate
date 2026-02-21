interface TranscribeResultProps {
  text: string;
}

export function TranscribeResult({ text }: TranscribeResultProps) {
  return (
    <div className="section">
      <label className="label">Transcription</label>
      <textarea readOnly value={text} style={{ minHeight: "120px" }} />
    </div>
  );
}
