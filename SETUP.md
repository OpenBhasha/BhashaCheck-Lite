# Setup

## 1. Prerequisites

- **Python 3.11**
- **FFmpeg** - `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Debian/Ubuntu)

## 2. Install and run

```bash
git clone https://github.com/OpenBhasha/BhashaCheck-Lite.git
cd BhashaCheck-Lite/server
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --port 8000
```

First run downloads Whisper + Silero VAD (~1 GB, one time).

## 3. Use it

Open **http://localhost:8000** -> upload audio -> run or skip each stage ->
click **Transcribe** on each segment -> **Export SRT**.

Everything is saved in the browser, so a reload never loses progress.

---

## Optional extras

### Diarization (who spoke when)

1. Create a token at <https://huggingface.co/settings/tokens>.
2. Accept the terms on `pyannote/speaker-diarization-community-1` and
   `pyannote/segmentation-3.0` (while logged in as that token's user).
3. Put it in `server/.env`:

   ```
   HUGGINGFACE_TOKEN=hf_xxxxxxxx
   ```

### Indic-Transcribe (Bodhan AI, 27 Indian languages)

Needs a GPU or plenty of RAM; ~5 GB model download.

```bash
pip install -r requirements-indic.txt
```

Accept the license at <https://huggingface.co/bodhan-ai/indic-transcribe-flex>,
set `HUGGINGFACE_TOKEN` in `server/.env`, then pick **Indic-Transcribe** as the
model on the Stages screen.

---

## Run on a server

Same commands. Then:

- Keep it running with **systemd** (or `tmux`/`screen` for a quick test).
- Put **nginx** in front for HTTPS, with `client_max_body_size 500m;` and
  `proxy_read_timeout 1800s;` (Demucs / diarization requests can run for minutes).
- Use **one** uvicorn worker - each worker loads its own copy of every model.

Serve the frontend elsewhere (Netlify, Pages, ...) by setting `SERVE_WEB=false`
in `server/.env` and opening `web/index.html`; it calls the API at
`http://localhost:8000` by default.
