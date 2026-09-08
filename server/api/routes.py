"""Stateless HTTP endpoints for the v2 single-page app.

Each request: save the upload to a fresh temp dir, normalise to mono/16k WAV,
run one model, return JSON (or WAV bytes for music removal), delete the temp
dir. Nothing is kept between requests.

Provider "not configured" situations and handled failures return **HTTP 200**
with ``{"code": "not_configured" | "error", "message": "..."}`` so the browser
can show a friendly banner instead of treating it as a network error.
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
import uuid
from contextlib import contextmanager

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

import ffmpeg
from config import settings
from providers import diarization, music_removal, vad
from providers.transcription.base import NotConfiguredError
from providers.transcription.registry import get_provider, list_models

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

LANGUAGES = [
    {"code": "", "label": "Auto-detect"},
    {"code": "en", "label": "English"},
    {"code": "hi", "label": "Hindi"},
    {"code": "te", "label": "Telugu"},
    {"code": "ta", "label": "Tamil"},
    {"code": "kn", "label": "Kannada"},
    {"code": "ml", "label": "Malayalam"},
    {"code": "bn", "label": "Bengali"},
    {"code": "gu", "label": "Gujarati"},
    {"code": "mr", "label": "Marathi"},
    {"code": "pa", "label": "Punjabi"},
    {"code": "or", "label": "Odia"},
    {"code": "ur", "label": "Urdu"},
]


def _friendly(exc: Exception, code: str = "error") -> JSONResponse:
    if isinstance(exc, NotConfiguredError):
        code = "not_configured"
    return JSONResponse({"code": code, "message": str(exc)})


@contextmanager
def _workdir():
    path = os.path.join(settings.work_dir, f"req-{uuid.uuid4().hex[:10]}")
    os.makedirs(path, exist_ok=True)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


async def _save_and_normalize(upload: UploadFile, work_dir: str) -> str:
    """Write the upload to disk and return a normalised mono/16k WAV path."""
    raw_path = os.path.join(work_dir, "upload" + (os.path.splitext(upload.filename or "")[1] or ".bin"))
    with open(raw_path, "wb") as fh:
        while chunk := await upload.read(1024 * 1024):
            fh.write(chunk)

    norm_path = os.path.join(work_dir, "normalized.wav")
    await run_in_threadpool(ffmpeg.to_wav_mono_16k, raw_path, norm_path)
    return norm_path


@router.get("/health")
async def health() -> dict:
    ffmpeg_ok = True
    ffmpeg_msg = ""
    try:
        ffmpeg.ensure_available()
    except ffmpeg.FfmpegMissing as exc:
        ffmpeg_ok, ffmpeg_msg = False, str(exc)
    return {
        "status": "ok",
        "device": settings.device,
        "ffmpeg": ffmpeg_ok,
        "ffmpegMessage": ffmpeg_msg,
        "diarizationConfigured": diarization.is_configured(),
        "demucsModel": settings.demucs_model,
        "whisperModel": settings.whisper_model,
    }


@router.get("/models")
async def models() -> dict:
    return {"models": list_models(), "languages": LANGUAGES}


@router.post("/music-removal")
async def music_removal_route(file: UploadFile = File(...)):
    try:
        ffmpeg.ensure_available()
    except ffmpeg.FfmpegMissing as exc:
        return _friendly(exc, "not_configured")

    try:
        with _workdir() as work_dir:
            norm_path = await _save_and_normalize(file, work_dir)
            vocals_path = await run_in_threadpool(
                music_removal.separate_vocals, norm_path, work_dir
            )
            with open(vocals_path, "rb") as fh:
                data = fh.read()
        return Response(
            content=data,
            media_type="audio/wav",
            headers={
                "X-Model-Used": music_removal.NAME,
                "Content-Disposition": 'inline; filename="vocals.wav"',
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("music-removal failed")
        return _friendly(exc)


@router.post("/vad")
async def vad_route(file: UploadFile = File(...)):
    try:
        ffmpeg.ensure_available()
    except ffmpeg.FfmpegMissing as exc:
        return _friendly(exc, "not_configured")

    try:
        with _workdir() as work_dir:
            norm_path = await _save_and_normalize(file, work_dir)
            spans = await run_in_threadpool(vad.get_speech_spans, norm_path)
            info = await run_in_threadpool(ffmpeg.probe, norm_path)
        return {
            "model": vad.NAME,
            "duration": info.duration_sec,
            "segments": [{"start": round(s, 3), "end": round(e, 3)} for s, e in spans],
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("vad failed")
        return _friendly(exc)


@router.post("/diarize")
async def diarize_route(file: UploadFile = File(...)):
    try:
        ffmpeg.ensure_available()
    except ffmpeg.FfmpegMissing as exc:
        return _friendly(exc, "not_configured")

    try:
        with _workdir() as work_dir:
            norm_path = await _save_and_normalize(file, work_dir)
            turns = await run_in_threadpool(diarization.diarize, norm_path)
        return {"model": diarization.NAME, "turns": turns}
    except Exception as exc:  # noqa: BLE001
        logger.exception("diarize failed")
        return _friendly(exc)


@router.post("/transcribe")
async def transcribe_route(
    file: UploadFile = File(...),
    language: str = Form(""),
    model: str = Form("whisper"),
    api_key: str = Form(""),
):
    try:
        ffmpeg.ensure_available()
    except ffmpeg.FfmpegMissing as exc:
        return _friendly(exc, "not_configured")

    try:
        provider = get_provider(model)
        with _workdir() as work_dir:
            norm_path = await _save_and_normalize(file, work_dir)

            kwargs = {}
            # API providers accept a per-request key from the Transcription card.
            if getattr(provider, "kind", "") == "api" and api_key:
                kwargs["api_key"] = api_key

            result = await run_in_threadpool(
                lambda: provider.transcribe(norm_path, language or None, **kwargs)
            )
        return {
            "text": result.text,
            "confidence": result.confidence,
            "language": result.language,
            "model": provider.id,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("transcribe failed")
        return _friendly(exc)
