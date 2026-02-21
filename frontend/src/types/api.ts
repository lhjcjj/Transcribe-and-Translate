export interface TranscribeResponse {
  text: string;
}

export interface TranslateRequest {
  text: string;
  target_lang: string;
}

export interface TranslateResponse {
  text: string;
}
