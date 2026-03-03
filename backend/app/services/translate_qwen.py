"""Local translation using Qwen (used when engine='local')."""

from __future__ import annotations

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, GenerationConfig

from app.config import QWEN_MODEL_DIR

_qwen_model: AutoModelForCausalLM | None = None
_qwen_tokenizer: AutoTokenizer | None = None


def _get_qwen_model() -> tuple[AutoModelForCausalLM, AutoTokenizer]:
    """Lazy-load Qwen model/tokenizer from local directory (QWEN_MODEL_DIR)."""
    global _qwen_model, _qwen_tokenizer
    if _qwen_model is not None and _qwen_tokenizer is not None:
        return _qwen_model, _qwen_tokenizer

    try:
        tokenizer = AutoTokenizer.from_pretrained(QWEN_MODEL_DIR, trust_remote_code=True)
        # Use CUDA if available; otherwise CPU to avoid MPS OOM on Mac (e.g. 3.4 GB limit).
        use_cuda = torch.cuda.is_available()
        model = AutoModelForCausalLM.from_pretrained(
            QWEN_MODEL_DIR,
            torch_dtype=torch.float16 if use_cuda else torch.float32,
            device_map="auto" if use_cuda else "cpu",
            trust_remote_code=True,
        )
    except Exception as exc:  # pragma: no cover - defensive, surfaces as ValueError
        raise ValueError(
            f"Failed to load Qwen model from '{QWEN_MODEL_DIR}'. "
            "Ensure transformers/torch are installed and the model directory is correct. "
            f"Original error: {exc!r}"
        ) from exc

    _qwen_model = model
    _qwen_tokenizer = tokenizer
    return model, tokenizer


def _split_into_chunks_by_paragraph(text: str, max_chars: int = 2000) -> list[str]:
    """按段落拆分长文本，尽量保证每段不超过 max_chars 字符。"""
    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for p in paragraphs:
        # +2 是预留换行分隔 "\n\n"
        add_len = len(p) + (2 if current else 0)
        if current and current_len + add_len > max_chars:
            chunks.append("\n\n".join(current))
            current = [p]
            current_len = len(p)
        else:
            current.append(p)
            current_len += add_len

    if current:
        chunks.append("\n\n".join(current))
    return chunks


def translate_qwen(text: str, target_lang: str) -> str:
    """Translate text to target_lang using local Qwen model."""
    model, tokenizer = _get_qwen_model()
    prompt = (
        f"Translate the following text to {target_lang}. "
        "Translate accurately; keep the same meaning and formatting (paragraphs, line breaks). "
        "Output ONLY the translation. Do not add explanations, definitions, or any other text. "
        "Do not repeat this instruction in the output.\n\n"
        f"{text}"
    )
    inputs = tokenizer(prompt, return_tensors="pt")
    inputs = {k: v.to(model.device) for k, v in inputs.items()}
    # Greedy decoding with repetition penalty to avoid loops/hallucination (e.g. repeating ROI phrases).
    gen_config = GenerationConfig.from_pretrained(QWEN_MODEL_DIR)
    gen_config.do_sample = False
    gen_config.max_new_tokens = 512
    gen_config.temperature = None
    gen_config.top_p = None
    gen_config.top_k = None
    gen_config.repetition_penalty = 1.2
    with torch.no_grad():
        output_ids = model.generate(**inputs, generation_config=gen_config)
    # Decode only the newly generated tokens (after the input prompt) so we get just the translation.
    input_length = inputs["input_ids"].shape[1]
    new_token_ids = output_ids[0][input_length:]
    translated = tokenizer.decode(new_token_ids, skip_special_tokens=True).strip()
    if not translated:
        raise ValueError("Empty translation response from local Qwen model")
    return translated


def translate_qwen_long(text: str, target_lang: str) -> str:
    """支持长文本的翻译：先拆段再逐段调用 Qwen。"""
    chunks = _split_into_chunks_by_paragraph(text, max_chars=2000)
    translated_parts: list[str] = []
    for chunk in chunks:
        translated = translate_qwen(chunk, target_lang)
        translated_parts.append(translated)
    # 用空行拼接，基本保持段落结构
    return "\n\n".join(translated_parts)

