# BhashaCheck Lite - single-page RSML transcription workbench

A static, no-login, no-database, no-backend tool: one HTML page. It walks you
through

**upload audio -> import an SRT or run in-browser VAD to seed segments ->
per-segment RSML annotation -> SRT export**

Every transcript field is bound to the [`rsml`](https://www.npmjs.com/package/rsml)
library (`RSMLAnnotator`), with a live preview beside it. All progress is saved
in the browser's IndexedDB, so a reload never loses work.

```
web/   the whole app - index.html + ES modules, Bootstrap 5
```

There is no server. Everything - waveform, RSML editing, "continue manually"
segmentation, SRT import/export - runs client-side. That last one uses
[`@ricky0123/vad-web`](https://www.npmjs.com/package/@ricky0123/vad-web) (a
Silero VAD model running in-browser via ONNX Runtime Web/WASM), loaded from a
CDN on demand only when you click "Continue manually" - a plain SRT-import
project never downloads it.

## Run locally

Any static file server works - it just needs to serve `web/` at its root, e.g.:

```bash
npx serve web
```

Then open the URL it prints. (Opening `web/index.html` directly via `file://`
also mostly works, except IndexedDB persistence is unreliable under `file://`
in some browsers - a real local server is the reliable option.)

## Deploy to Netlify

Point Netlify at this repo with **publish directory `web`** and no build
command (a `netlify.toml` at the repo root already sets this, so "New site
from Git" picks it up automatically). That's it - static hosting, nothing to
configure server-side.

## Notes

- Internet is needed on first load for Bootstrap, `rsml`, CodeMirror, and
  WaveSurfer (all from jsDelivr, cached by the browser afterward), and again
  the first time you click "Continue manually" (the VAD model + ONNX runtime
  WASM, also cached afterward).
- No accounts, no server-side storage: a project lives entirely in the
  browser's IndexedDB for that origin. Clearing site data removes it.
- Looking for the version with a Python ML backend (Demucs music removal,
  server-side Whisper transcription, pyannote diarization)? See the
  `full-stack` branch of this repo.
