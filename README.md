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
[versions]
bhashacheck = 1.0.1
rsml = 3.3.3

[settings]
default_code_mixing_language = en

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

The config is what wrote the file (`[versions]` - the numbers shown here are just
an example), the project's settings, and its complete tag set. The tag set is
the *effective* one - the `rsml` library's built-in defaults plus whatever was
customized in Settings -> RSML tags - not just the customizations. `[tags]`
holds the self-explanatory sets (hesitations, paralinguistic sounds, fillers,
prosody, ...), which need no legend. Every set written as a code or id
(entities, languages, dialects, domains, accents) is its own section of
`code = description` lines - the legend - e.g. entities `GPE` -> `Geo Political
Entity`, languages `hi` -> `Hindi`. `[settings]` and `[speakers]` hold the
default code-mixing language and the speaker roster (gender + language code,
decoded by `[languages]`). A speaker's language is the one they speak in; the
code-mixing language is the one mixed in within it (e.g. English inside Telugu
speech). Anything the config defines is never repeated per cue.

**SRT (`.srt`)** is the plain, standard option: index, timestamps, text, and
nothing else (the text is the raw RSML markup). It is lossy by nature - no
speaker, flags, notes or config survive it.

**Importing** takes either, from the one import control on the setup screen. An
`.rsml` file restores everything: the segments with their speaker / verified /
flagged / note, and the config - the default code-mixing language, the speaker
roster, and every tag set the file lists. Whatever the file states **replaces**
the project's value, even when the project already has settings (so editing the
config block in an `.rsml` and importing it again takes effect): the roster
becomes exactly the file's roster, a listed tag set replaces the project's, and
the default language and accents are set to the file's. Anything the file doesn't
mention - a tag set it leaves out, or a roster when it has no `[speakers]` section
- is left alone. The config block is cut
off before the cues are read, so it is never a transcript segment. A plain SRT
just seeds the segments. If a hand-edited file's tag set is invalid (say, one
tag registered under two categories), the import still brings in the segments
but leaves the project's own settings and tag set untouched, and says so. Files
exported by earlier builds of this app (SRTs with per-cue `speakers=` fields,
or with the config written as an extra last cue) still import.

## Versioning

BhashaCheck uses semantic versioning (`MAJOR.MINOR.PATCH`); the current version
is shown beside the name in the header and under Settings -> About. It is a single
constant, `BHASHACHECK_VERSION` in `web/js/version.js`, and it **versions itself**:

- Every push to `main` that changes the app (`web/**`) is versioned by the deploy
  workflow (`.github/workflows/deploy-pages.yml`, using `scripts/bump-version.sh`).
  It raises the **patch** number, commits that as `chore(release): vX.Y.Z`, tags it
  `vX.Y.Z`, and then deploys that commit - so the deployed site always shows the
  version it was built from.
- **Minor and major** are yours to set: edit `BHASHACHECK_VERSION` yourself in your
  push (say to `1.1.0`). The workflow sees you changed it, keeps your number, and
  just tags it - it does not bump it again. Don't edit the patch number by hand.
- Re-running the workflow for a push that was already versioned does nothing
  extra, and a failed version step never blocks a deploy (the version job turns
  red; the site still ships).
- The release commit lands on `main` *after* your push, so run `git pull --rebase`
  before your next push. The workflow needs permission to push to `main` (it asks
  for `contents: write` itself; a branch-protection rule on `main` would stop it
  unless GitHub Actions is allowed to bypass it).

The **RSML version** is the version of the [`rsml`](https://www.npmjs.com/package/rsml)
library the app is running, and it follows npm's **latest release automatically**:
at startup the app asks the npm registry for `rsml`'s latest version and loads
that exact version from jsDelivr, so a new release reaches the app with no
change here. Every module gets the library from `web/js/rsmlLib.js`, which does
this. If the lookup or the load fails (offline, registry blocked or slow - it
waits at most 3 seconds - or the new version isn't on the CDN yet) it falls back
to the last version that loaded in this browser, then to a known-good version
(`FALLBACK_VERSION` in that file), so the app still starts and still works
offline once it has loaded before.

Following latest means a release can change behavior: `rsml` 3.3.4, for
example, changed the library's *default* tag set (no more `@silence` / `@pause`
defaults; `high-pitch` / `low-pitch` added). A project with a saved tag set keeps
it; one that has never customized its tags follows the library's defaults. If a
release breaks something, set `PINNED_VERSION` in `rsmlLib.js` to stop following
latest.

Every exported `.rsml` file records both in its `[versions]` section, so a
reader (a person, or a pipeline such as the aligner) can tell which version of
each produced it. Import does not act on it: the section is read past.

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
  WaveSurfer (all from jsDelivr, cached by the browser afterward - and each
  load also asks the npm registry which `rsml` version is latest, falling back to
  the cached one if it can't), and again
  the first time you click "Continue manually" (the VAD model + ONNX runtime
  WASM, also cached afterward).
- No accounts, no server-side storage: a project lives entirely in the
  browser's IndexedDB for that origin. Clearing site data removes it.
- Looking for the version with a Python ML backend (Demucs music removal,
  server-side Whisper transcription, pyannote diarization)? See the
  `full-stack` branch of this repo.
