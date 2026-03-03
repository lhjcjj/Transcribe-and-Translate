"""Local summarization using Qwen (same model as local translation)."""

from __future__ import annotations

import torch
from transformers import GenerationConfig

from app.services.translate_qwen import _get_qwen_model  # reuse loaded Qwen model/tokenizer
from app.config import QWEN_MODEL_DIR


def summarize_qwen(text: str) -> str:
    """Summarize text using local Qwen model."""
    text = (text or "").strip()
    if not text:
        return ""

    model, tokenizer = _get_qwen_model()
    prompt = (
        "Summarize the following content in the same language as the input. "
        "Be concise but cover the key ideas, arguments, and important numbers. "
        "Output ONLY the summary, no explanations or headings.\n\n"
        f"{text}"
    )
    inputs = tokenizer(prompt, return_tensors="pt")
    inputs = {k: v.to(model.device) for k, v in inputs.items()}

    gen_config = GenerationConfig.from_pretrained(QWEN_MODEL_DIR)
    gen_config.do_sample = False
    gen_config.max_new_tokens = 512
    gen_config.temperature = None
    gen_config.top_p = None
    gen_config.top_k = None
    gen_config.repetition_penalty = 1.2

    with torch.no_grad():
        output_ids = model.generate(**inputs, generation_config=gen_config)

    input_length = inputs["input_ids"].shape[1]
    new_token_ids = output_ids[0][input_length:]
    summary = tokenizer.decode(new_token_ids, skip_special_tokens=True).strip()
    if not summary:
        raise ValueError("Empty summary response from local Qwen model")
    return summary

