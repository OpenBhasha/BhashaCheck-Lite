"""Maps a model id (as chosen in the browser dropdown) to a provider instance,
and exposes the dropdown metadata for ``GET /api/models``.
"""
from __future__ import annotations

from providers.transcription.base import NotConfiguredError, TranscriptionProvider
from providers.transcription.conformer import ConformerProvider
from providers.transcription.gnani import GnaniProvider
from providers.transcription.indic_conformer import IndicConformerProvider
from providers.transcription.sarvam import SarvamProvider
from providers.transcription.wav2vec2 import Wav2Vec2Provider
from providers.transcription.whisper_asr import WhisperProvider

_PROVIDERS: list[TranscriptionProvider] = [
    WhisperProvider(),
    Wav2Vec2Provider(),
    ConformerProvider(),
    IndicConformerProvider(),
    SarvamProvider(),
    GnaniProvider(),
]

_BY_ID = {p.id: p for p in _PROVIDERS}

DEFAULT_ID = "whisper"


def get_provider(model_id: str | None) -> TranscriptionProvider:
    provider = _BY_ID.get(model_id or DEFAULT_ID)
    if provider is None:
        raise NotConfiguredError(f"Unknown transcription model '{model_id}'.")
    return provider


def list_models() -> list[dict]:
    out = []
    for p in _PROVIDERS:
        try:
            available = bool(p.available())
        except Exception:  # noqa: BLE001 - availability probing must never 500
            available = False
        out.append(
            {
                "id": p.id,
                "label": p.label,
                "kind": p.kind,
                "available": available,
                "note": p.note(),
            }
        )
    return out
