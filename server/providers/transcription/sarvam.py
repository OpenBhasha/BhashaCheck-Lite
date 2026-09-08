"""Sarvam AI speech-to-text (cloud API, https://docs.sarvam.ai).

Wired but inert until ``SARVAM_API_KEY`` is set. The key can also be passed
per-request from the browser (the Transcription config card), which takes
precedence over the env var.
"""
from __future__ import annotations

import logging

import requests

from config import settings
from providers.transcription.base import (
    NotConfiguredError,
    TranscriptionProvider,
    TranscriptionResult,
)

logger = logging.getLogger(__name__)

API_URL = "https://api.sarvam.ai/speech-to-text"


class SarvamProvider(TranscriptionProvider):
    id = "sarvam"
    label = "Sarvam AI (API)"
    kind = "api"

    def available(self) -> bool:
        return bool(settings.sarvam_api_key)

    def note(self) -> str:
        return "cloud API - key from env or the Transcription card"

    def transcribe(
        self, wav_path: str, language: str | None, api_key: str | None = None
    ) -> TranscriptionResult:
        key = api_key or settings.sarvam_api_key
        if not key:
            raise NotConfiguredError(
                "Sarvam needs an API key. Set SARVAM_API_KEY in v2/server/.env, or paste "
                "a key into the Transcription config card."
            )

        # Sarvam expects a BCP-47-ish code like "hi-IN"; pass through a bare
        # 2-letter code as "<code>-IN", leave anything else untouched.
        lang_code = language or ""
        if len(lang_code) == 2:
            lang_code = f"{lang_code}-IN"

        try:
            with open(wav_path, "rb") as fh:
                resp = requests.post(
                    API_URL,
                    headers={"api-subscription-key": key},
                    files={"file": ("segment.wav", fh, "audio/wav")},
                    data={
                        "model": settings.sarvam_model,
                        "language_code": lang_code or "unknown",
                    },
                    timeout=120,
                )
        except requests.RequestException as exc:
            raise RuntimeError(f"Sarvam request failed: {exc}") from exc

        if resp.status_code == 401 or resp.status_code == 403:
            raise NotConfiguredError(f"Sarvam rejected the API key (HTTP {resp.status_code}).")
        if resp.status_code >= 400:
            raise RuntimeError(f"Sarvam error HTTP {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        return TranscriptionResult(
            text=(data.get("transcript") or "").strip(),
            language=data.get("language_code") or language,
        )
