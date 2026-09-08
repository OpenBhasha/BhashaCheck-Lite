"""pyannote.audio (MIT toolkit; the pretrained pipeline has its own gated
model-card terms) for speaker diarization. Ported from
``ml-service/app/services/diarization/pyannote_provider.py``.

Uses ``pyannote/speaker-diarization-community-1`` by default, which requires
pyannote.audio>=4.0. Needs a Hugging Face token with access to the pipeline's
gated model card (and its dependency models, e.g. pyannote/segmentation-3.0).
"""
from __future__ import annotations

import logging

from config import settings
from providers.transcription.base import NotConfiguredError

logger = logging.getLogger(__name__)

NAME = "pyannote-community-1"

_pipeline = None


def is_configured() -> bool:
    return bool(settings.huggingface_token)


def _load():
    global _pipeline
    if _pipeline is None:
        from pyannote.audio import Pipeline

        loaded = Pipeline.from_pretrained(
            settings.pyannote_pipeline,
            token=settings.huggingface_token or None,
        )
        if loaded is None:
            # pyannote.audio does NOT raise on auth/access failure here - it
            # prints a warning and returns None. Turn that into a real error.
            raise NotConfiguredError(
                f"Pipeline.from_pretrained('{settings.pyannote_pipeline}') returned None. "
                "This usually means HUGGINGFACE_TOKEN is unset/invalid, or the gated "
                f"model terms for '{settings.pyannote_pipeline}' (and its dependencies, "
                "e.g. pyannote/segmentation-3.0) have not been accepted on huggingface.co "
                "for that token's account."
            )
        _pipeline = loaded
        if settings.device == "cuda":
            import torch

            _pipeline.to(torch.device("cuda"))
    return _pipeline


def _load_waveform(wav_path: str):
    """Read audio via soundfile into the {waveform, sample_rate} dict form
    pyannote.audio accepts directly, bypassing pyannote 4.x's torchcodec
    decode path (which needs a CUDA nvrtc lib absent on CPU-only hosts).
    """
    import soundfile as sf
    import torch

    data, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
    waveform = torch.from_numpy(data.T)  # (channel, time)
    return {"waveform": waveform, "sample_rate": sample_rate}


def diarize(wav_path: str) -> list[dict]:
    """Return [{start, end, speaker}] turns; may overlap in time."""
    if not is_configured():
        raise NotConfiguredError(
            "Diarization needs HUGGINGFACE_TOKEN set in v2/server/.env plus accepted "
            f"model terms for '{settings.pyannote_pipeline}' on huggingface.co."
        )

    pipeline = _load()
    result = pipeline(_load_waveform(wav_path))
    # pyannote.audio 4.x wraps the result in DiarizeOutput; the plain
    # Annotation (overlap preserved) lives on .speaker_diarization.
    diarization = result.speaker_diarization

    turns: list[dict] = []
    for turn, _track, speaker in diarization.itertracks(yield_label=True):
        turns.append(
            {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
        )
    turns.sort(key=lambda t: t["start"])
    return turns
