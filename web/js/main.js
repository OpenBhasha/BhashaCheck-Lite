// App shell: state, persistence, screen routing, the upload/setup screens
// (upload audio, then import an SRT or run client-side VAD), and rehydration
// on load. editor.js imports the helpers exported here.

import * as storage from "./storage.js";
import * as wav from "./wav.js";
import { parseSRT } from "./srt.js";
import { mountEditor, unmountEditor } from "./editor.js";
import { renderRsmlSettings } from "./rsmlSettings.js";

// ---------------------------------------------------------------- state ----

const newState = () => ({
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  audioMeta: null, // { name, type, size, duration }
  segments: [], // { id, start, end, rsml, speaker, verified }
  ui: { screen: "upload", zoom: 40, speed: 1 },
  // null until the user customizes something in Settings -> RSML tags; a
  // straight snapshot of an RSMLAnnotator's own .opts otherwise (see
  // rsmlSettings.js). The library's own built-in defaults apply until then
  // — editor.js spreads this in as-is when constructing each segment's
  // annotator.
  rsmlConfig: null,
});

let state = newState();

// Not persisted; rebuilt each session.
export const runtime = {
  workingBlob: null,
};

export function getState() {
  return state;
}

export function segId() {
  return "s" + Math.random().toString(36).slice(2, 9);
}

// -------------------------------------------------------------- persist ----

let saveTimer = null;
const savedBadge = () => document.getElementById("save-indicator");

export function scheduleSave() {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

export async function saveNow() {
  clearTimeout(saveTimer);
  state.updatedAt = Date.now();
  try {
    await storage.saveState(state);
    const b = savedBadge();
    if (b) {
      b.textContent = "All changes saved";
      b.className = "save-indicator saved";
    }
  } catch (err) {
    console.warn("save failed", err);
    const b = savedBadge();
    if (b) {
      b.textContent = "Save failed";
      b.className = "save-indicator error";
    }
  }
}

function markDirty() {
  const b = savedBadge();
  if (b) {
    b.textContent = "Saving...";
    b.className = "save-indicator dirty";
  }
}

// --------------------------------------------------------------- toast ----

export function toast(message, kind = "info") {
  const area = document.getElementById("toast-area");
  if (!area) return;
  const el = document.createElement("div");
  el.className = `app-toast toast-${kind}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span><button aria-label="Dismiss">&times;</button>`;
  el.querySelector("button").onclick = () => el.remove();
  area.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 5000);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// -------------------------------------------------------------- router ----

export async function showScreen(name) {
  state.ui.screen = name;
  for (const s of document.querySelectorAll("main > section")) {
    s.hidden = s.id !== `screen-${name}`;
  }
  document.body.dataset.screen = name;

  if (name === "editor") await mountEditor();
  else unmountEditor();

  scheduleSave();
}

// ------------------------------------------------------- working audio ----

export async function setWorkingAudio(blob) {
  runtime.workingBlob = blob;
  await storage.putAudio("audio", blob);
  try {
    const info = await wav.loadAudio(blob);
    if (state.audioMeta) state.audioMeta.duration = info.duration;
  } catch (err) {
    console.warn("decodeAudioData failed", err);
    toast("Could not decode this audio in the browser, so waveform and slicing may not work.", "error");
  }
  scheduleSave();
}

// -------------------------------------------------------------- upload ----

function wireUpload() {
  const drop = document.getElementById("dropzone");
  const audioInput = document.getElementById("audio-input");
  const srtInput = document.getElementById("srt-input");

  const pickAudio = () => audioInput.click();
  drop.addEventListener("click", pickAudio);
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleAudioFile(f);
  });
  audioInput.addEventListener("change", () => {
    if (audioInput.files[0]) handleAudioFile(audioInput.files[0]);
    audioInput.value = "";
  });
  srtInput.addEventListener("change", () => {
    if (srtInput.files[0]) importSrt(srtInput.files[0]);
    srtInput.value = "";
  });
}

async function handleAudioFile(file) {
  state = newState();
  syncRsmlSettingsPanel(); // new project: reset the RSML-tags panel to it, not the old one
  state.audioMeta = { name: file.name, type: file.type, size: file.size, duration: 0 };
  await setWorkingAudio(file);
  await saveNow();
  toast(`Loaded ${file.name}`, "success");
  showScreen("setup");
}

// SRT import happens AFTER audio, from the setup screen. It keeps the audio
// already loaded, fills the segments from the cues, and jumps to the editor.
export async function importSrt(srtFile) {
  const text = await srtFile.text();
  const cues = parseSRT(text);
  if (!cues.length) {
    toast("No cues found in that .srt file.", "error");
    return;
  }
  state.segments = cues.map((c) => ({
    id: segId(),
    start: c.start,
    end: c.end,
    rsml: c.text,
    speaker: null,
    verified: false,
  }));
  await saveNow();
  toast(`Imported ${cues.length} segments from ${srtFile.name}`, "success");
  showScreen("editor");
}

// Lazy-loaded on first use so a plain SRT-import project never pays for the
// VAD/ONNX-runtime download. vad-web's bundle is a UMD build that expects a
// global `ort` to already exist (it does NOT bundle onnxruntime-web itself),
// so onnxruntime-web's own global build has to load first, in order; only
// then does bundle.min.js set the global `vad`.
let vadLoadPromise = null;
const VAD_WEB_VERSION = "0.0.31";
const ORT_VERSION = "1.22.0";
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}
function loadVadLib() {
  if (window.vad) return Promise.resolve();
  if (vadLoadPromise) return vadLoadPromise;
  vadLoadPromise = (async () => {
    if (!window.ort) await loadScript(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`);
    await loadScript(`https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/bundle.min.js`);
  })();
  return vadLoadPromise;
}

// "Skip" on the setup screen: runs a browser-side Silero VAD pass (via
// @ricky0123/vad-web's NonRealTimeVAD, no server involved) over the already-
// decoded audio to seed segments automatically, then opens the editor either
// way — on any failure (no network for the CDN model on first use, browser
// unsupported, etc.) it still opens the editor with zero segments so the
// user can draw them by hand (drag on the waveform, or the "+" between
// segments once there's at least one).
export async function runManualVad() {
  const btn = document.getElementById("setup-skip-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Analyzing audio...";
  }
  try {
    const samples = wav.getMonoSamples();
    if (!samples) throw new Error("no audio loaded");
    await loadVadLib();
    const detector = await window.vad.NonRealTimeVAD.new({
      baseAssetPath: `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`,
      onnxWASMBasePath: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`,
      // vad-web's default redemptionMs (500) is 5x the old server-side VAD's
      // min_silence_duration_ms (100, the Python silero-vad package's own
      // default, which the removed server/providers/vad.py just ran
      // unmodified) - ordinary inter-sentence pauses are often well under
      // 500ms, so the 500ms default was merging most of them into a handful
      // of huge segments instead of splitting on each pause. 100 here
      // restores the old segmentation granularity; every other option
      // already matches the Python defaults (threshold/minSpeechMs/
      // preSpeechPadMs all line up already).
      redemptionMs: 100,
    });
    const spans = [];
    for await (const { start, end } of detector.run(samples.data, samples.sampleRate)) {
      spans.push({ start: start / 1000, end: end / 1000 });
    }
    spans.sort((a, b) => a.start - b.start);
    state.segments = spans.map((sp) => ({
      id: segId(),
      start: sp.start,
      end: sp.end,
      rsml: "",
      speaker: null,
      verified: false,
    }));
    await saveNow();
    toast(
      spans.length ? `Found ${spans.length} speech segments.` : "No speech detected - drag on the waveform to add one.",
      spans.length ? "success" : "info"
    );
  } catch (err) {
    console.warn("client-side VAD failed", err);
    toast(`Automatic segmentation failed (${err.message || err}). Opening the editor - drag on the waveform to add segments.`, "warn");
  } finally {
    showScreen("editor");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Skip";
    }
  }
}

function wireSetupNav() {
  const back = document.getElementById("setup-back-btn");
  if (back)
    back.onclick = () => {
      if (confirm("Go back to upload? Your current work stays saved and you can restore it.")) showScreen("upload");
    };

  const drop = document.getElementById("srt-dropzone");
  const srtInput = document.getElementById("srt-input");
  if (drop && srtInput) {
    drop.addEventListener("click", () => srtInput.click());
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (f) importSrt(f);
    });
  }

  const skipBtn = document.getElementById("setup-skip-btn");
  if (skipBtn) skipBtn.onclick = runManualVad;
}

// ------------------------------------------------------- settings drawer ----

function wireHeader() {
  const drawer = document.getElementById("settings-drawer");
  const backdrop = document.getElementById("settings-backdrop");
  const open = () => {
    drawer.hidden = false;
    backdrop.hidden = false;
  };
  const close = () => {
    drawer.hidden = true;
    backdrop.hidden = true;
  };
  document.getElementById("open-settings").onclick = open;
  document.getElementById("close-settings").onclick = close;
  backdrop.onclick = close;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.hidden) close();
  });
  document.getElementById("drawer-startover").onclick = () => {
    if (confirm("Delete this project (segments, audio, progress) from the browser? This cannot be undone.")) resetAll();
  };
}

// -------------------------------------------------------- reset / boot ----

export async function resetAll() {
  await storage.clearAll();
  location.reload();
}

async function rehydrate() {
  const saved = await storage.loadState();
  if (!saved) return false;
  state = Object.assign(newState(), saved);
  state.ui = Object.assign(newState().ui, saved.ui || {});

  for (const seg of state.segments || []) {
    if (seg.verified == null) seg.verified = false;
  }

  // Migrate: state.rsmlConfig existed before this app switched to
  // rsml@3.2.0's native add()/remove(). The old code stored the "isolated
  // @-tag" categories as bare names; the library itself always stores them
  // "@"-prefixed, and a bare-named entry saved under the old shape won't
  // compare equal to anything the library's own add()/remove() produce.
  // Rather than trying to salvage it, discard it outright — the library's
  // own current defaults are strictly better than stale, wrongly-shaped
  // data (and this is a one-time migration: state.rsmlConfig is always
  // written back in the library's own normalized shape from here on).
  const ISOLATED_TAG_CATEGORIES = ["hesitations", "isolatedParalinguistics", "isolatedOther"];
  if (
    state.rsmlConfig &&
    ISOLATED_TAG_CATEGORIES.some((k) => (state.rsmlConfig[k] || []).some((tag) => !tag.startsWith("@")))
  ) {
    state.rsmlConfig = null;
  }

  if (state.audioMeta) {
    const blob = await storage.getAudio("audio");
    if (blob) {
      runtime.workingBlob = blob;
      try {
        await wav.loadAudio(blob);
      } catch (err) {
        console.warn("decode on rehydrate failed", err);
      }
    }
  }
  return true;
}

// Rebuilds the settings drawer's RSML-tags panel against whatever project
// is current right now. Called once at boot, and again any time `state` is
// wholesale-replaced (a new audio upload starts a fresh project) — without
// this, the panel's own internal RSMLAnnotator (see rsmlSettings.js) would
// keep showing/editing the *previous* project's vocabulary.
//
// applyToOpenRows is fetched via a dynamic import() rather than a static
// one, purely to avoid growing editor.js's existing cyclic import list (see
// rsmlSettings.js's header comment) — editor.js is already fully loaded by
// this point via the static import above, so this just reads a property
// off its already-resolved module namespace.
function syncRsmlSettingsPanel() {
  renderRsmlSettings(document.getElementById("rsml-tags-panel"), {
    getState,
    scheduleSave,
    toast,
    escapeHtml,
    applyToOpenRows: (...args) => import("./editor.js").then((m) => m.applyRsmlChange(...args)),
  });
}

async function boot() {
  wireUpload();
  wireHeader();
  wireSetupNav();

  const had = await rehydrate();
  // After rehydrate, since it may have replaced `state` wholesale — render
  // against the final object, not the pre-rehydrate placeholder.
  syncRsmlSettingsPanel();
  if (had && (state.segments.length || state.audioMeta)) {
    const saved = state.ui.screen === "stages" ? "setup" : state.ui.screen; // old name, pre-rename saves
    const target = saved && saved !== "upload" ? saved : state.segments.length ? "editor" : "setup";
    await showScreen(target);
    toast("Restored your previous session.", "info");
  } else {
    await showScreen("upload");
  }
}

// DOMContentLoaded may already have fired by the time this module (deferred,
// like all type="module" scripts) actually executes — a static <script>-tag
// listener registered after the fact would then just never run. Firing
// immediately when the document is already past "loading" covers that.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
