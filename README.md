# BhashaCheck Lite - single-page RSML transcription workbench

A static, no-login, no-database, no-backend tool: one HTML page. It walks you
through

**upload audio -> import an RSML/SRT file or run in-browser VAD to seed
segments -> per-segment RSML annotation -> RSML export (or plain SRT)**

Every transcript field is bound to the [`rsml`](https://www.npmjs.com/package/rsml)
library (`RSMLAnnotator`), with a live preview beside it. All progress is saved
in the browser's IndexedDB, so a reload never loses work.

```
web/   the whole app - index.html + ES modules, Bootstrap 5
```

There is no server. Everything - waveform, RSML editing, "continue manually"
segmentation, RSML/SRT import/export - runs client-side. That last one uses
[`@ricky0123/vad-web`](https://www.npmjs.com/package/@ricky0123/vad-web) (a
Silero VAD model running in-browser via ONNX Runtime Web/WASM), loaded from a
CDN on demand only when you click "Continue manually" - an import-based
project never downloads it.

## File formats

**RSML (`.rsml`)** is the primary format for export and import: an SRT with
extras. Every cue is still an index, a timestamp line and the text, so anything
that reads SRT still finds the transcript in it. On top of that it carries:

- a **metadata line** under each cue's timestamps - that segment's own facts
  only: `primary=1|verified=0|flagged=0|note=` (which speaker, verified,
  flagged, note);
- a **config block** at the very end of the file - not a cue, no index or
  timestamps - introduced by a `# BhashaCheck config` comment line:

```
# BhashaCheck config
[settings]
default_language = te

[speakers]
1 = male, te

[tags]
hesitations = @umm, @uhh
disfluencySpans = filler, repetition

[entities]
GPE = Geo Political Entity

[languages]
hi = Hindi
te = Telugu
```

The config is the project's settings plus its complete tag set. The tag set is
the *effective* one - the `rsml` library's built-in defaults plus whatever was
customized in Settings -> RSML tags - not just the customizations. `[tags]`
holds the self-explanatory sets (hesitations, paralinguistic sounds, fillers,
prosody, ...), which need no legend. Every set written as a code or id
(entities, languages, dialects, domains, accents) is its own section of
`code = description` lines - the legend - e.g. entities `GPE` -> `Geo Political
Entity`, languages `hi` -> `Hindi`. `[settings]` and `[speakers]` hold the
default code-mixing language and the speaker roster (gender + native language
code, decoded by `[languages]`). Anything the config defines is never repeated
per cue.

**SRT (`.srt`)** is the plain, standard option: index, timestamps, text, and
nothing else (the text is the raw RSML markup). It is lossy by nature - no
speaker, flags, notes or config survive it.

**Importing** takes either, from the one import control on the setup screen. An
`.rsml` file restores everything: the segments with their speaker / verified /
flagged / note, and the config - the default code-mixing language, the speaker
roster, and every tag set the file lists (a listed tag set replaces the
project's; one the file doesn't mention is left alone). The config block is cut
off before the cues are read, so it is never a transcript segment. A plain SRT
just seeds the segments. If a hand-edited file's tag set is invalid (say, one
tag registered under two categories), the import still brings in the segments
but leaves the project's own settings and tag set untouched, and says so. Files
exported by earlier builds of this app (SRTs with per-cue `speakers=` fields,
or with the config written as an extra last cue) still import.

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
