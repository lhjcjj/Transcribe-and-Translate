import { useState } from "react";

export default function App() {
  const [langOption, setLangOption] = useState<"auto" | "en" | "zh">("auto");
  const [cleanOption, setCleanOption] = useState<"yes" | "no">("yes");
  const [historyOpen, setHistoryOpen] = useState(false);
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
                        <input type="text" id="step-upload-input" name="audio-file" className="step-input" placeholder="Select an audio file to upload" readOnly />
                        <span className="step-input-addon">MB:%</span>
                      </div>
                    </div>
                    <button type="button" className="step-upload-browse">browse</button>
                    <button type="button" className="step-upload-upload">upload</button>
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
                        <input type="text" id="step-chunk-input" name="chunk-size" className="step-input" placeholder="Each chunk is: 10 MB" readOnly />
                        <span className="step-input-addon">chunks</span>
                      </div>
                    </div>
                    <button type="button" className="step-split-split">split</button>
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
                        <div role="log" className="step-log">Tasks information</div>
                      </div>
                    </div>
                    <button type="button" className="step-transcribe-transcribe">transcribe</button>
                    <button type="button" className="step-transcribe-download">download</button>
                  </div>
                </div>
                <div className="step-body"></div>
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
    </div>
  );
}
