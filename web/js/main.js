// App shell: state, persistence, screen routing, the upload screen, and
// rehydration on load. stages.js and editor.js import the helpers exported here.

import * as storage from "./storage.js";
import * as api from "./api.js";
import * as wav from "./wav.js";
import { parseSRT } from "./srt.js";
import { renderStages, wireStagesNav } from "./stages.js";
import { mountEditor, unmountEditor } from "./editor.js";

// ---------------------------------------------------------------- state ----

const newState = () => ({
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  audioMeta: null, // { name, type, size, duration, hasProcessed }
  stageStatus: { musicRemoval: "pending", segmentation: "pending", diarization: "pending" },
  transcription: { language: "", model: "whisper", apiKey: "" },
  segments: [], // { id, start, end, rsml, speaker, status, selected }
  ui: { screen: "upload", zoom: 40, speed: 1 },
});

let state = newState();

// Not persisted; rebuilt each session.
export const runtime = {
  workingBlob: null,
  originalBlob: null,
  models: [],
  languages: [],
  serviceOk: false,
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

  if (name === "stages") renderStages();
  if (name === "editor") await mountEditor();
  else unmountEditor();

  scheduleSave();
}

// ------------------------------------------------------- working audio ----

export async function setWorkingAudio(blob, { processed = false } = {}) {
  runtime.workingBlob = blob;
  await storage.putAudio(processed ? "processed" : "original", blob);
  if (!processed) runtime.originalBlob = blob;
  if (state.audioMeta) state.audioMeta.hasProcessed = processed || state.audioMeta.hasProcessed;
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
  state.audioMeta = { name: file.name, type: file.type, size: file.size, duration: 0, hasProcessed: false };
  await storage.deleteAudio("processed").catch(() => {});
  await setWorkingAudio(file, { processed: false });
  await saveNow();
  toast(`Loaded ${file.name}`, "success");
  showScreen("stages");
}

// SRT import happens AFTER audio, from the stages screen. It keeps the audio
// already loaded, fills the segments from the cues, marks every stage skipped,
// and jumps to the editor.
export async function importSrt(srtFile) {
  const text = await srtFile.text();
  const cues = parseSRT(text);
  if (!cues.length) {
    toast("No cues found in that .srt file.", "error");
    return;
  }
  state.stageStatus = { musicRemoval: "skipped", segmentation: "skipped", diarization: "skipped" };
  state.segments = cues.map((c) => ({
    id: segId(),
    start: c.start,
    end: c.end,
    rsml: c.text,
    speaker: null,
    status: c.text.trim() ? "done" : "empty",
    selected: false,
  }));
  await saveNow();
  toast(`Imported ${cues.length} segments from ${srtFile.name}`, "success");
  showScreen("editor");
}

export async function skipAllStages() {
  state.stageStatus = { musicRemoval: "skipped", segmentation: "skipped", diarization: "skipped" };
  await saveNow();
  showScreen("editor");
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

async function checkService() {
  const banner = document.getElementById("service-banner");
  try {
    const h = await api.health();
    runtime.serviceOk = true;
    if (!h.ffmpeg) {
      banner.hidden = false;
      banner.textContent = h.ffmpegMessage || "FFmpeg not found on the server PATH, so audio processing will fail.";
      banner.className = "service-banner warn";
    } else {
      banner.hidden = true;
    }
  } catch (err) {
    runtime.serviceOk = false;
    banner.hidden = false;
    banner.textContent = `ML service not reachable at ${api.apiBase()}. Start it with: cd v2/server && uvicorn main:app --port 8000`;
    banner.className = "service-banner error";
  }
  try {
    const m = await api.getModels();
    runtime.models = m.models || [];
    runtime.languages = m.languages || [];
  } catch {
    runtime.models = [{ id: "whisper", label: "Whisper (local)", kind: "local", available: true, note: "" }];
    runtime.languages = [{ code: "", label: "Auto-detect" }];
  }
}

async function rehydrate() {
  const saved = await storage.loadState();
  if (!saved) return false;
  state = Object.assign(newState(), saved);
  state.ui = Object.assign(newState().ui, saved.ui || {});

  if (state.audioMeta) {
    const blob =
      (state.audioMeta.hasProcessed && (await storage.getAudio("processed"))) ||
      (await storage.getAudio("original"));
    if (blob) {
      runtime.workingBlob = blob;
      runtime.originalBlob = (await storage.getAudio("original")) || blob;
      try {
        await wav.loadAudio(blob);
      } catch (err) {
        console.warn("decode on rehydrate failed", err);
      }
    }
  }
  return true;
}

async function boot() {
  wireUpload();
  wireHeader();
  wireStagesNav();
  await checkService();

  const had = await rehydrate();
  if (had && (state.segments.length || state.audioMeta)) {
    const saved = state.ui.screen;
    const target = saved && saved !== "upload" ? saved : state.segments.length ? "editor" : "stages";
    await showScreen(target);
    toast("Restored your previous session.", "info");
  } else {
    await showScreen("upload");
  }
}

document.addEventListener("DOMContentLoaded", boot);
