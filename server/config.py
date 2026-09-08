"""Environment-driven settings for the v2 ML service.

Deliberately tiny and stateless: no database URLs, no Cloudinary, no internal
service secret. Copy ``.env.example`` to ``.env`` and edit as needed.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

# Load v2/server/.env into the process environment before the os.environ
# lookups below are evaluated (they are dataclass field defaults, computed
# once at class-definition time).
load_dotenv()


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Where temp working files are created (one sub-dir per request, deleted after).
    work_dir: str = os.environ.get("ML_WORK_DIR", "/tmp/bhashacheck-v2")

    # "cpu" or "cuda".
    device: str = os.environ.get("ML_DEVICE", "cpu")

    # --- Models ---
    demucs_model: str = os.environ.get("DEMUCS_MODEL", "htdemucs")
    whisper_model: str = os.environ.get("WHISPER_MODEL", "small")
    pyannote_pipeline: str = os.environ.get(
        "PYANNOTE_PIPELINE", "pyannote/speaker-diarization-community-1"
    )
    huggingface_token: str = os.environ.get("HUGGINGFACE_TOKEN", "")

    # Optional local checkpoints - leave blank to keep the provider stubbed.
    wav2vec2_model: str = os.environ.get("WAV2VEC2_MODEL", "")
    conformer_model_path: str = os.environ.get("CONFORMER_MODEL_PATH", "")
    indic_conformer_model_path: str = os.environ.get("INDIC_CONFORMER_MODEL_PATH", "")

    # Bodhan AI Indic-Transcribe (gated HF model; needs HUGGINGFACE_TOKEN).
    # Use ...-core for higher accuracy, ...-flex for mixed / Romanised scripts.
    indic_transcribe_model: str = os.environ.get(
        "INDIC_TRANSCRIBE_MODEL", "bodhan-ai/indic-transcribe-flex"
    )

    # Optional cloud ASR - leave blank to keep the provider stubbed.
    sarvam_api_key: str = os.environ.get("SARVAM_API_KEY", "")
    sarvam_model: str = os.environ.get("SARVAM_MODEL", "saarika:v2")
    gnani_api_key: str = os.environ.get("GNANI_API_KEY", "")
    gnani_api_url: str = os.environ.get(
        "GNANI_API_URL", "https://asr.gnani.ai/api/v1/transcribe"
    )

    # Serve v2/web/ as static files from this app (same origin, no CORS dance).
    serve_web: bool = _bool("SERVE_WEB", True)

    indic_languages: tuple = field(default_factory=lambda: ("hi", "te", "ta", "kn", "ml", "bn", "gu", "mr", "pa", "or"))


settings = Settings()
