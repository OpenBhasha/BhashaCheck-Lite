"""Silero VAD (MIT, https://github.com/snakers4/silero-vad) for binary
speech/non-speech segmentation. Ported from
``ml-service/app/services/vad/silero_provider.py``. Loaded once per process
via torch.hub and reused across requests.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

NAME = "silero-vad"

_model = None
_utils = None


def _load():
    global _model, _utils
    if _model is None:
        import torch

        _model, _utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            onnx=False,
        )
    return _model, _utils


def get_speech_spans(wav_path: str) -> list[tuple[float, float]]:
    """Return the speech spans (start, end) in seconds. Gaps are non-speech."""
    model, utils = _load()
    get_speech_timestamps, _, read_audio, *_ = utils

    wav = read_audio(wav_path, sampling_rate=16000)
    timestamps = get_speech_timestamps(
        wav, model, sampling_rate=16000, return_seconds=True
    )
    return [(float(t["start"]), float(t["end"])) for t in timestamps]
