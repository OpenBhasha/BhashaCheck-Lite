from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


class NotConfiguredError(RuntimeError):
    """Raised when a provider is selected but its model path / API key is not
    set. Surfaced to the browser as an HTTP 200 ``{code: "not_configured"}``
    so the UI shows a friendly banner instead of a hard failure.
    """


@dataclass
class TranscriptionResult:
    text: str
    confidence: float | None = None
    language: str | None = None


class TranscriptionProvider(ABC):
    """Transcribes one already-cut audio segment at a time. Providers never
    decide segment boundaries - those come from the browser.
    """

    id: str
    label: str
    kind: str  # "local" | "api"

    def available(self) -> bool:
        """Whether this provider can run right now (deps present, key set)."""
        return True

    def note(self) -> str:
        """Short hint shown next to the model in the UI dropdown."""
        return ""

    @abstractmethod
    def transcribe(self, wav_path: str, language: str | None) -> TranscriptionResult:
        raise NotImplementedError
