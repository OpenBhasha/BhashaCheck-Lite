# BhashaCheck - single-page RSML transcription workbench

A local, no-login, no-database tool: one HTML page + a thin stateless FastAPI
ML service. It walks you through

**upload → music removal → segmentation → (optional) diarization → per-segment
RSML transcription → SRT export**

Every transcript field is bound to the [`rsml`](https://www.npmjs.com/package/rsml)
library (`RSMLAnnotator`), with a live preview beside it. All progress is saved
in the browser's IndexedDB, so a reload never loses work.

```
v2/
  server/   FastAPI ML service (stateless endpoints; also serves the page)
  web/      the single-page app (index.html + ES modules, Bootstrap 5)
```

## Prerequisites

- **Python 3.11** (heavy first-run model downloads; CPU is fine, Demucs is slow on long files)
- **FFmpeg** + **ffprobe** on `PATH` - macOS `brew install ffmpeg`, Debian/Ubuntu `apt install ffmpeg`
- Internet on first page load (Bootstrap, `rsml`, CodeMirror, WaveSurfer load from jsDelivr; cached afterwards)

## Run

```bash
cd v2/server
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # optional: set HUGGINGFACE_TOKEN for diarization
uvicorn main:app --reload --port 8000
```

Open **http://localhost:8000/**. The FastAPI app serves the frontend at `/`
(same origin, no CORS setup needed). First run downloads the Whisper `small`
model and the Silero VAD model.

To host the page yourself instead, set `SERVE_WEB=false` and open
`v2/web/index.html` - it falls back to calling the API at `http://localhost:8000`.

## What works out of the box

| Stage | Engine | Notes |
|---|---|---|
| Music Removal | Demucs (`htdemucs`) | `--two-stems vocals` |
| Segmentation | Silero VAD | creates empty segments from speech spans |
| Diarization | pyannote community-1 | **needs** `HUGGINGFACE_TOKEN` + accepted model terms, else reported as "not configured" |
| Transcription | **Whisper (local)** | the one fully-working ASR provider |

## Extra ASR providers (wired but inert until configured)

They appear in the model dropdown and return a friendly *"not configured"*
banner until set up in `v2/server/.env`:

| Model | Enable with |
|---|---|
| Wav2Vec2 | `WAV2VEC2_MODEL=<hf-id-or-path>` + `pip install transformers` |
| Conformer | `CONFORMER_MODEL_PATH=<.nemo-or-name>` + `pip install -r requirements-nemo.txt` |
| IndicConformer | `INDIC_CONFORMER_MODEL_PATH=<.nemo>` + `pip install -r requirements-nemo.txt` |
| Sarvam AI | `SARVAM_API_KEY=<key>` (or paste a key into the Transcription card) |
| Gnani.ai | `GNANI_API_KEY=<key>` + `GNANI_API_URL=<your contract endpoint>` |

## API (all stateless, multipart in → JSON/WAV out)

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/health` | device, ffmpeg + diarization availability |
| GET | `/api/models` | ASR dropdown metadata + language list |
| POST | `/api/music-removal` | `file` → `audio/wav` (vocals) |
| POST | `/api/vad` | `file` → `{segments:[{start,end}], duration}` |
| POST | `/api/diarize` | `file` → `{turns:[{start,end,speaker}]}` |
| POST | `/api/transcribe` | `file`,`language`,`model`,`api_key` → `{text,confidence,language}` |

Handled failures and "not configured" cases return **HTTP 200** with
`{code, message}` so the UI shows a banner instead of a network error.

## Notes

- Per-segment transcription audio is sliced **in the browser** (decode once,
  encode a WAV per segment) so the source file is never re-uploaded per segment.
- The existing `../ml-service/` (Cloudinary + callbacks + Mongo) is untouched;
  v2 only reuses its provider logic behind simpler endpoints.
