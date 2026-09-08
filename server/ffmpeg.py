"""Thin wrappers around the ffmpeg/ffprobe CLI.

Ported from ``ml-service/app/utils/ffmpeg.py``. FFmpeg is used only for
mechanical audio manipulation (resample, cut, format convert) - it never
decides timestamps. The ML models do that; this module just performs the cut.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass


class FfmpegMissing(RuntimeError):
    pass


def ensure_available() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise FfmpegMissing(
                f"'{tool}' was not found on PATH. Install FFmpeg "
                "(macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`)."
            )


@dataclass
class AudioInfo:
    duration_sec: float
    sample_rate: int
    channels: int
    format: str


def probe(path: str) -> AudioInfo:
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_format", "-show_streams",
            path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)
    audio_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "audio"), {}
    )
    return AudioInfo(
        duration_sec=float(data.get("format", {}).get("duration", 0.0)),
        sample_rate=int(audio_stream.get("sample_rate", 0) or 0),
        channels=int(audio_stream.get("channels", 0) or 0),
        format=data.get("format", {}).get("format_name", ""),
    )


def to_wav_mono_16k(input_path: str, output_path: str) -> None:
    """Normalize to the format local speech models expect: mono, 16 kHz, PCM WAV."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le",
            output_path,
        ],
        capture_output=True,
        check=True,
    )


def extract_segment(input_path: str, output_path: str, start_sec: float, end_sec: float) -> None:
    duration = max(end_sec - start_sec, 0.0)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", input_path,
            "-ss", f"{start_sec:.3f}",
            "-t", f"{duration:.3f}",
            "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le",
            output_path,
        ],
        capture_output=True,
        check=True,
    )
