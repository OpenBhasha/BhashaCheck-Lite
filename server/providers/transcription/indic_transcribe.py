"""Indic-Transcribe (Bodhan AI + AI4Bharat, https://huggingface.co/bodhan-ai).

A ~1B-parameter "Indic Canary" ASR model (NeMo-trained, shipped with its own
standalone inference wrapper) covering 27 Indian languages + Indian English,
including Romanised / mixed-script input on the ``flex`` variant.

The model repo is **gated**: accept the Indic Open Model License at
https://huggingface.co/bodhan-ai/indic-transcribe-flex and set
``HUGGINGFACE_TOKEN`` in ``v2/server/.env``. Pick the variant with
``INDIC_TRANSCRIBE_MODEL`` (``bodhan-ai/indic-transcribe-flex`` default, or
``bodhan-ai/indic-transcribe-core`` for the higher-accuracy version).

The custom inference code (``indic_transcribe.py``) ships inside the model
snapshot, so no ``nemo_toolkit`` is needed - just ``transformers`` +
``sentencepiece`` (see ``requirements-indic.txt``).
"""
from __future__ import annotations

import logging
import sys

from config import settings
from providers.transcription.base import (
    NotConfiguredError,
    TranscriptionProvider,
    TranscriptionResult,
)

logger = logging.getLogger(__name__)

_asr = None


def _deps_ok() -> bool:
    try:
        import huggingface_hub  # noqa: F401
        import sentencepiece  # noqa: F401
        import transformers  # noqa: F401

        return True
    except Exception:
        return False


def _load():
    global _asr
    if _asr is not None:
        return _asr

    from huggingface_hub import snapshot_download

    try:
        path = snapshot_download(
            settings.indic_transcribe_model,
            token=settings.huggingface_token or None,
        )
    except Exception as exc:  # noqa: BLE001
        raise NotConfiguredError(
            f"Could not download '{settings.indic_transcribe_model}'. This model is gated - "
            "accept the license at "
            f"https://huggingface.co/{settings.indic_transcribe_model} and set a valid "
            f"HUGGINGFACE_TOKEN in v2/server/.env. ({exc})"
        ) from exc

    # The inference wrapper (indic_transcribe.py) lives inside the snapshot.
    if path not in sys.path:
        sys.path.insert(0, path)
    try:
        from indic_transcribe import IndicTranscribe
    except Exception as exc:  # noqa: BLE001
        raise NotConfiguredError(
            "Downloaded the model but could not import its 'indic_transcribe' runtime. "
            "Install its deps: `pip install -r v2/server/requirements-indic.txt`. "
            f"({exc})"
        ) from exc

    model = IndicTranscribe.from_pretrained(path)
    if settings.device == "cuda" and hasattr(model, "to"):
        try:
            model.to("cuda")
        except Exception:  # noqa: BLE001
            pass
    _asr = model
    return _asr


class IndicTranscribeProvider(TranscriptionProvider):
    id = "indic_transcribe"
    label = "Indic-Transcribe (Bodhan AI)"
    kind = "local"

    def available(self) -> bool:
        return _deps_ok()

    def note(self) -> str:
        if not _deps_ok():
            return "pip install -r requirements-indic.txt, then accept the HF license"
        return f"{settings.indic_transcribe_model} - gated, needs HUGGINGFACE_TOKEN"

    def transcribe(self, wav_path: str, language: str | None) -> TranscriptionResult:
        if not _deps_ok():
            raise NotConfiguredError(
                "Indic-Transcribe needs `transformers` + `sentencepiece`: "
                "`pip install -r v2/server/requirements-indic.txt`."
            )

        asr = _load()
        lang = (language or "").strip() or "auto"
        try:
            result = asr(wav_path, lang=lang)
        except TypeError:
            # older/newer wrapper signatures
            result = asr(wav_path)

        text = result
        detected = language
        if isinstance(result, dict):
            text = result.get("text") or result.get("transcript") or ""
            detected = result.get("lang") or result.get("language") or language
        elif isinstance(result, (list, tuple)) and result:
            text = result[0]

        return TranscriptionResult(text=str(text).strip(), language=detected)
