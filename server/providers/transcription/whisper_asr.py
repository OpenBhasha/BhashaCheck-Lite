"""OpenAI Whisper (code + weights both MIT, https://github.com/openai/whisper).
Ported from ``ml-service/app/services/transcription/whisper_provider.py``.
This is the one fully-working local provider in v2.
"""
from __future__ import annotations

import logging
import math

from config import settings
from providers.transcription.base import TranscriptionProvider, TranscriptionResult

logger = logging.getLogger(__name__)

_model = None


def _load():
    global _model
    if _model is None:
        import whisper

        _model = whisper.load_model(settings.whisper_model, device=settings.device)
    return _model


class WhisperProvider(TranscriptionProvider):
    id = "whisper"
    label = "Whisper (local)"
    kind = "local"

    def available(self) -> bool:
        try:
            import whisper  # noqa: F401

            return True
        except Exception:
            return False

    def note(self) -> str:
        return f"openai-whisper · model '{settings.whisper_model}' · {settings.device}"

    def transcribe(self, wav_path: str, language: str | None) -> TranscriptionResult:
        model = _load()
        result = model.transcribe(
            wav_path, language=language or None, fp16=settings.device == "cuda"
        )

        segments = result.get("segments") or []
        if segments:
            avg_logprob = sum(s.get("avg_logprob", 0.0) for s in segments) / len(segments)
            confidence = max(0.0, min(1.0, math.exp(avg_logprob)))
        else:
            confidence = None

        return TranscriptionResult(
            text=(result.get("text") or "").strip(),
            confidence=confidence,
            language=result.get("language") or language,
        )
