export interface TranscribeResultProps {
  text: string | null;
  error?: string | null;
}

export function TranscribeResult({ text, error }: TranscribeResultProps) {
  return (
    <div className="step-body">
      {error && <p className="step-error" role="alert">{error}</p>}
      <textarea readOnly className="step-transcribe-result" value={text ?? ""} rows={8} />
    </div>
  );
}
