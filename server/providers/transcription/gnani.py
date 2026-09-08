"""Gnani.ai speech-to-text (cloud API, https://www.gnani.ai).

Wired but inert until ``GNANI_API_KEY`` is set. Gnani's ASR API shape varies
by account/deployment, so ``GNANI_API_URL`` is configurable and the request
below is a reasonable default (multipart file + bearer token). Adjust to match
your contract. The key can also be passed per-request from the browser.
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


class GnaniProvider(TranscriptionProvider):
    id = "gnani"
    label = "Gnani.ai (API)"
    kind = "api"

    def available(self) -> bool:
        return bool(settings.gnani_api_key)

    def note(self) -> str:
        return "cloud API - set GNANI_API_URL to match your contract"

    def transcribe(
        self, wav_path: str, language: str | None, api_key: str | None = None
    ) -> TranscriptionResult:
        key = api_key or settings.gnani_api_key
        if not key:
            raise NotConfiguredError(
                "Gnani needs an API key. Set GNANI_API_KEY (and GNANI_API_URL) in "
                "v2/server/.env, or paste a key into the Transcription config card."
            )

        try:
            with open(wav_path, "rb") as fh:
                resp = requests.post(
                    settings.gnani_api_url,
                    headers={"Authorization": f"Bearer {key}"},
                    files={"file": ("segment.wav", fh, "audio/wav")},
                    data={"language": language or "en", "format": "wav", "sample_rate": "16000"},
                    timeout=120,
                )
        except requests.RequestException as exc:
            raise RuntimeError(f"Gnani request failed: {exc}") from exc

        if resp.status_code in (401, 403):
            raise NotConfiguredError(f"Gnani rejected the API key (HTTP {resp.status_code}).")
        if resp.status_code >= 400:
            raise RuntimeError(f"Gnani error HTTP {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        # Try a few common response shapes.
        text = (
            data.get("transcript")
            or data.get("text")
            or (data.get("results") or [{}])[0].get("transcript")
            or ""
        )
        return TranscriptionResult(text=str(text).strip(), language=language)
