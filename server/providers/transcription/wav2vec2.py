"""Wav2Vec2 CTC via HuggingFace Transformers.

Wired but inert until ``WAV2VEC2_MODEL`` is set (a HF model id or local path,
e.g. ``facebook/wav2vec2-large-xlsr-53`` or an AI4Bharat IndicWav2Vec model)
AND ``transformers`` is installed (`pip install transformers`).
"""
from __future__ import annotations

import logging

from config import settings
from providers.transcription.base import (
    NotConfiguredError,
    TranscriptionProvider,
    TranscriptionResult,
)

logger = logging.getLogger(__name__)

_model = None
_processor = None


def _deps_ok() -> bool:
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import transformers  # noqa: F401

        return True
    except Exception:
        return False


def _load():
    global _model, _processor
    if _model is None:
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        _processor = Wav2Vec2Processor.from_pretrained(settings.wav2vec2_model)
        _model = Wav2Vec2ForCTC.from_pretrained(settings.wav2vec2_model)
        if settings.device == "cuda":
            _model = _model.cuda()
        _model.eval()
    return _model, _processor


class Wav2Vec2Provider(TranscriptionProvider):
    id = "wav2vec2"
    label = "Wav2Vec2 (local)"
    kind = "local"

    def available(self) -> bool:
        return bool(settings.wav2vec2_model) and _deps_ok()

    def note(self) -> str:
        if not settings.wav2vec2_model:
            return "set WAV2VEC2_MODEL + `pip install transformers`"
        if not _deps_ok():
            return "`pip install transformers` to enable"
        return f"transformers · {settings.wav2vec2_model}"

    def transcribe(self, wav_path: str, language: str | None) -> TranscriptionResult:
        if not settings.wav2vec2_model:
            raise NotConfiguredError(
                "Wav2Vec2 is not configured. Set WAV2VEC2_MODEL in v2/server/.env to a "
                "HuggingFace model id or local path, and `pip install transformers`."
            )
        if not _deps_ok():
            raise NotConfiguredError(
                "Wav2Vec2 needs the 'transformers' package: `pip install transformers`."
            )

        import torch
        import torchaudio

        model, processor = _load()
        speech, sr = torchaudio.load(wav_path)
        if sr != 16000:
            speech = torchaudio.functional.resample(speech, sr, 16000)
        speech = speech.mean(dim=0)  # mono

        inputs = processor(
            speech.numpy(), sampling_rate=16000, return_tensors="pt", padding=True
        )
        input_values = inputs.input_values
        if settings.device == "cuda":
            input_values = input_values.cuda()

        with torch.no_grad():
            logits = model(input_values).logits
        predicted_ids = torch.argmax(logits, dim=-1)
        text = processor.batch_decode(predicted_ids)[0]
        return TranscriptionResult(text=text.strip().lower(), language=language)
