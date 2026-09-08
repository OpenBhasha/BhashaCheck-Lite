"""IndicConformer (AI4Bharat, https://github.com/AI4Bharat/IndicConformerASR)
for Indic-language transcription. Ported from
``ml-service/app/services/transcription/indic_conformer_provider.py``.

Wired but inert until ``INDIC_CONFORMER_MODEL_PATH`` (a local ``.nemo``
checkpoint) is set AND ``nemo_toolkit[asr]`` is installed. The checkpoints
carry their own model-card terms - verify before production use.
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


def _deps_ok() -> bool:
    try:
        import nemo.collections.asr  # noqa: F401

        return True
    except Exception:
        return False


def _load():
    global _model
    if _model is None:
        import nemo.collections.asr as nemo_asr

        _model = nemo_asr.models.EncDecCTCModel.restore_from(
            settings.indic_conformer_model_path
        )
        if settings.device == "cuda":
            _model = _model.cuda()
        _model.eval()
    return _model


class IndicConformerProvider(TranscriptionProvider):
    id = "indic_conformer"
    label = "IndicConformer (local, AI4Bharat)"
    kind = "local"

    def available(self) -> bool:
        return bool(settings.indic_conformer_model_path) and _deps_ok()

    def note(self) -> str:
        if not settings.indic_conformer_model_path:
            return "set INDIC_CONFORMER_MODEL_PATH + install nemo_toolkit[asr]"
        if not _deps_ok():
            return "install nemo_toolkit[asr] to enable"
        return f"NeMo · {settings.indic_conformer_model_path}"

    def transcribe(self, wav_path: str, language: str | None) -> TranscriptionResult:
        if not settings.indic_conformer_model_path:
            raise NotConfiguredError(
                "IndicConformer is not configured. Set INDIC_CONFORMER_MODEL_PATH in "
                "v2/server/.env to a .nemo checkpoint, and install nemo_toolkit[asr]."
            )
        if not _deps_ok():
            raise NotConfiguredError(
                "IndicConformer needs NVIDIA NeMo: `pip install -r requirements-nemo.txt`."
            )

        model = _load()
        hypotheses = model.transcribe([wav_path])
        text = hypotheses[0] if hypotheses else ""
        if hasattr(text, "text"):
            text = text.text
        return TranscriptionResult(text=str(text).strip(), language=language)
