"""Conformer ASR via NVIDIA NeMo.

Wired but inert until ``CONFORMER_MODEL_PATH`` is set (a local ``.nemo``
checkpoint, or a pretrained NGC/HF model name such as
``stt_en_conformer_ctc_large``) AND ``nemo_toolkit[asr]`` is installed
(see ``requirements-nemo.txt``).
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

        path = settings.conformer_model_path
        if path.endswith(".nemo"):
            _model = nemo_asr.models.ASRModel.restore_from(path)
        else:
            _model = nemo_asr.models.ASRModel.from_pretrained(path)
        if settings.device == "cuda":
            _model = _model.cuda()
        _model.eval()
    return _model


class ConformerProvider(TranscriptionProvider):
    id = "conformer"
    label = "Conformer (local, NeMo)"
    kind = "local"

    def available(self) -> bool:
        return bool(settings.conformer_model_path) and _deps_ok()

    def note(self) -> str:
        if not settings.conformer_model_path:
            return "set CONFORMER_MODEL_PATH + install nemo_toolkit[asr]"
        if not _deps_ok():
            return "install nemo_toolkit[asr] to enable"
        return f"NeMo · {settings.conformer_model_path}"

    def transcribe(self, wav_path: str, language: str | None) -> TranscriptionResult:
        if not settings.conformer_model_path:
            raise NotConfiguredError(
                "Conformer is not configured. Set CONFORMER_MODEL_PATH in v2/server/.env "
                "to a .nemo checkpoint or a pretrained model name, and install "
                "nemo_toolkit[asr] (see v2/server/requirements-nemo.txt)."
            )
        if not _deps_ok():
            raise NotConfiguredError(
                "Conformer needs NVIDIA NeMo: `pip install -r requirements-nemo.txt`."
            )

        model = _load()
        hypotheses = model.transcribe([wav_path])
        text = hypotheses[0] if hypotheses else ""
        if hasattr(text, "text"):  # newer NeMo returns Hypothesis objects
            text = text.text
        return TranscriptionResult(text=str(text).strip(), language=language)
