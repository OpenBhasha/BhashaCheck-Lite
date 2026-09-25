# Setup

## 1. Run it

No installs, no server, no Python. Any static file server works:

```bash
git clone https://github.com/OpenBhasha/BhashaCheck-Lite.git
cd BhashaCheck-Lite
npx serve web
```

Open the URL it prints.

## 2. Use it

Upload audio -> **Upload an SRT** (if you already have a transcript) or
**Continue manually** (runs voice-activity detection in your browser to seed
segments) -> type RSML into each segment -> **Export SRT**.

Everything is saved in the browser's IndexedDB, so a reload never loses
progress. There's no account and nothing is uploaded anywhere.

---

## Deploy to Netlify

1. Push this repo to your own GitHub (or use it directly).
2. In Netlify: **Add new site -> Import an existing project**, pick the repo.
3. Build settings: leave the build command empty, publish directory `web`.
   (A `netlify.toml` at the repo root already sets this, so Netlify usually
   picks it up without asking.)
4. Deploy. That's the whole thing - no environment variables, no functions,
   no server to keep running.

---

## Looking for the ML backend version?

Music removal (Demucs), server-side VAD, speaker diarization (pyannote), and
server-side transcription (Whisper and other ASR providers) live on the
`full-stack` branch of this repo, which keeps its own `server/` FastAPI
service. This `main` branch is the static-only rebuild and intentionally
doesn't have any of that.
