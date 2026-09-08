"""Demucs (MIT, https://github.com/facebookresearch/demucs) run in two-stem
mode to extract a vocals-only track. Ported from
``ml-service/app/services/music_removal/demucs_provider.py``.

Demucs is a music source-separation model first and foremost - it is not
guaranteed to cleanly remove every kind of background music. If it fails or
produces no usable output, ``separate_vocals`` raises so the caller can fall
back to the original audio.
"""
from __future__ import annotations

import glob
import logging
import os
import subprocess
import sys

from config import settings

logger = logging.getLogger(__name__)

NAME = "demucs"


def separate_vocals(input_wav_path: str, work_dir: str) -> str:
    """Return the filesystem path to a vocals-only WAV file."""
    model = settings.demucs_model
    out_dir = os.path.join(work_dir, "demucs_out")
    os.makedirs(out_dir, exist_ok=True)

    # sys.executable, not a bare "python": the service commonly runs from a
    # venv whose bin dir isn't on the subprocess PATH (and macOS has only
    # "python3"), so "python" resolves to nothing.
    cmd = [
        sys.executable, "-m", "demucs.separate",
        "-n", model,
        "--two-stems", "vocals",
        "-o", out_dir,
        "-d", settings.device,
        input_wav_path,
    ]
    logger.info("Running Demucs: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Demucs failed (exit {result.returncode}): {result.stderr[-2000:]}")

    matches = glob.glob(os.path.join(out_dir, model, "*", "vocals.wav"))
    if not matches:
        raise RuntimeError("Demucs completed but no vocals.wav output was found")
    return matches[0]
