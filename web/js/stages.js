// The "stages" screen: Music Removal / Segmentation / Diarization cards, each
// with Start + Skip and a progress readout, plus the Transcription config card
// (which does not run here; per-segment transcription happens in the editor).

import {
  getState,
  runtime,
  segId,
  showScreen,
  scheduleSave,
  saveNow,
  toast,
  escapeHtml,
  setWorkingAudio,
  skipAllStages,
} from "./main.js";
import * as api from "./api.js";

const STAGES = [
  {
    key: "musicRemoval",
    title: "Music Removal",
    tag: "Demucs",
    desc: "Separate vocals from background music. Skip if the audio is already clean. On CPU this can take a few minutes.",
    needsAudio: true,
    run: runMusicRemoval,
  },
  {
    key: "segmentation",
    title: "Segmentation",
    tag: "VAD (Silero)",
    desc: "Detect speech spans and create empty segments. Skip to draw segments yourself on the waveform.",
    needsAudio: true,
    run: runSegmentation,
  },
  {
    key: "diarization",
    title: "Diarization",
    tag: "pyannote (optional)",
    desc: "Label who spoke when. Needs HUGGINGFACE_TOKEN on the server.",
    needsAudio: true,
    run: runDiarization,
  },
];

const PILL = {
  pending: ["Pending", "pill-pending"],
  running: ["Running", "pill-running"],
  done: ["Done", "pill-done"],
  skipped: ["Skipped", "pill-skipped"],
  error: ["Error", "pill-error"],
};

let busy = false;
const runStart = {}; // stage key -> epoch ms while running
let elapsedTimer = null;

export function renderStages() {
  const s = getState();
  const host = document.getElementById("stages-list");
  if (!host) return;
  const hasAudio = !!runtime.workingBlob;

  host.innerHTML = STAGES.map((st) => {
    const status = s.stageStatus[st.key] || "pending";
    const [label, cls] = PILL[status];
    const disabled = busy || (st.needsAudio && !hasAudio);
    const running = status === "running";
    const elapsed = running && runStart[st.key] ? Math.round((Date.now() - runStart[st.key]) / 1000) : 0;
    return `
      <div class="stage-card" data-key="${st.key}">
        <div class="stage-main">
          <div class="stage-head">
            <span class="stage-title">${escapeHtml(st.title)}</span>
            <span class="stage-tag">${escapeHtml(st.tag)}</span>
            <span class="pill ${cls}">${label}</span>
          </div>
          <p class="stage-desc">${escapeHtml(st.desc)}</p>
          <div class="stage-progress" ${running ? "" : "hidden"}>
            <div class="ind-bar"><div class="ind-fill"></div></div>
            <span class="stage-elapsed">running ${elapsed}s</span>
          </div>
        </div>
        <div class="stage-actions">
          <button class="btn btn-primary btn-sm" data-act="start" ${disabled ? "disabled" : ""}>
            ${running ? "Working" : status === "done" ? "Re-run" : "Start"}
          </button>
          <button class="btn btn-outline-secondary btn-sm" data-act="skip" ${busy ? "disabled" : ""}>Skip</button>
        </div>
      </div>`;
  }).join("");

  host.querySelectorAll(".stage-card").forEach((card) => {
    const key = card.dataset.key;
    const st = STAGES.find((x) => x.key === key);
    card.querySelector('[data-act="start"]').onclick = () => runStage(st);
    card.querySelector('[data-act="skip"]').onclick = () => skipStage(key);
  });

  if (!hasAudio) {
    host.insertAdjacentHTML(
      "afterbegin",
      `<p class="muted small mb-2"><i class="bi bi-info-circle"></i> No audio loaded. These stages need audio; you can still open the editor and work from an SRT.</p>`
    );
  }

  renderTranscriptionConfig();
}

function tickElapsed() {
  const s = getState();
  document.querySelectorAll(".stage-card").forEach((card) => {
    const key = card.dataset.key;
    if (s.stageStatus[key] === "running" && runStart[key]) {
      const el = card.querySelector(".stage-elapsed");
      if (el) el.textContent = `running ${Math.round((Date.now() - runStart[key]) / 1000)}s`;
    }
  });
}

function renderTranscriptionConfig() {
  const s = getState();
  const host = document.getElementById("transcription-config");
  if (!host) return;

  const langOpts = (runtime.languages || [{ code: "", label: "Auto-detect" }])
    .map((l) => `<option value="${l.code}" ${s.transcription.language === l.code ? "selected" : ""}>${escapeHtml(l.label)}</option>`)
    .join("");

  const models = runtime.models.length
    ? runtime.models
    : [{ id: "whisper", label: "Whisper (local)", kind: "local", available: true, note: "" }];
  const modelOpts = models
    .map((m) => {
      const suffix = m.available ? "" : " (not configured)";
      return `<option value="${m.id}" data-kind="${m.kind}" ${s.transcription.model === m.id ? "selected" : ""} title="${escapeHtml(m.note || "")}">${escapeHtml(m.label)}${suffix}</option>`;
    })
    .join("");

  const selected = models.find((m) => m.id === s.transcription.model);
  const showKey = selected && selected.kind === "api";

  host.innerHTML = `
    <div class="row g-3">
      <div class="col-sm-4">
        <label class="form-label">Language</label>
        <select class="form-select form-select-sm" id="tc-language">${langOpts}</select>
      </div>
      <div class="col-sm-5">
        <label class="form-label">Model</label>
        <select class="form-select form-select-sm" id="tc-model">${modelOpts}</select>
        <div class="form-text">${escapeHtml((selected && selected.note) || "")}</div>
      </div>
      <div class="col-sm-3" ${showKey ? "" : "hidden"} id="tc-key-wrap">
        <label class="form-label">API key</label>
        <input type="password" class="form-control form-control-sm" id="tc-key" placeholder="paste key" value="${escapeHtml(s.transcription.apiKey || "")}" />
      </div>
    </div>`;

  host.querySelector("#tc-language").onchange = (e) => {
    s.transcription.language = e.target.value;
    scheduleSave();
  };
  host.querySelector("#tc-model").onchange = (e) => {
    s.transcription.model = e.target.value;
    renderTranscriptionConfig();
    scheduleSave();
  };
  const key = host.querySelector("#tc-key");
  if (key)
    key.oninput = (e) => {
      s.transcription.apiKey = e.target.value;
      scheduleSave();
    };
}

async function runStage(st) {
  if (busy) return;
  const s = getState();
  if (st.key === "segmentation" && s.segments.some((x) => (x.rsml || "").trim())) {
    if (!confirm("Re-running segmentation replaces the current segments and their transcripts. Continue?")) return;
  }
  busy = true;
  s.stageStatus[st.key] = "running";
  runStart[st.key] = Date.now();
  renderStages();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 1000);
  try {
    await st.run();
    s.stageStatus[st.key] = "done";
    await saveNow();
  } catch (err) {
    s.stageStatus[st.key] = "error";
    const msg = err && err.code === "not_configured" ? err.message : `${st.title} failed: ${err.message || err}`;
    toast(msg, err && err.code === "not_configured" ? "warn" : "error");
  } finally {
    busy = false;
    delete runStart[st.key];
    clearInterval(elapsedTimer);
    renderStages();
  }
}

function skipStage(key) {
  const s = getState();
  s.stageStatus[key] = "skipped";
  scheduleSave();
  renderStages();
}

async function runMusicRemoval() {
  const vocals = await api.musicRemoval(runtime.originalBlob || runtime.workingBlob);
  await setWorkingAudio(vocals, { processed: true });
  toast("Vocals extracted. Later stages will use the cleaned audio.", "success");
}

async function runSegmentation() {
  const res = await api.vad(runtime.workingBlob);
  const s = getState();
  s.segments = (res.segments || []).map((seg) => ({
    id: segId(),
    start: seg.start,
    end: seg.end,
    rsml: "",
    speaker: null,
    status: "empty",
    selected: false,
  }));
  toast(`Found ${s.segments.length} speech segments.`, "success");
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

async function runDiarization() {
  const res = await api.diarize(runtime.workingBlob);
  const turns = res.turns || [];
  const s = getState();
  if (!turns.length) {
    toast("Diarization returned no speaker turns.", "warn");
    return;
  }
  if (s.segments.length) {
    for (const seg of s.segments) {
      let best = null;
      let bestOv = 0;
      for (const t of turns) {
        const ov = overlap(seg.start, seg.end, t.start, t.end);
        if (ov > bestOv) {
          bestOv = ov;
          best = t;
        }
      }
      seg.speaker = best ? best.speaker : seg.speaker;
    }
    toast("Assigned speaker labels to existing segments.", "success");
  } else {
    s.segments = turns.map((t) => ({
      id: segId(),
      start: t.start,
      end: t.end,
      rsml: "",
      speaker: t.speaker,
      status: "empty",
      selected: false,
    }));
    toast(`Created ${s.segments.length} segments from speaker turns.`, "success");
  }
}

// Wire the stages-screen chrome once, on boot.
export function wireStagesNav() {
  const open = document.getElementById("open-editor-btn");
  if (open) open.onclick = () => showScreen("editor");

  const back = document.getElementById("stages-back-btn");
  if (back)
    back.onclick = () => {
      if (confirm("Go back to upload? Your current work stays saved and you can restore it.")) showScreen("upload");
    };

  const srtBtn = document.getElementById("stages-upload-srt");
  if (srtBtn) srtBtn.onclick = () => document.getElementById("srt-input").click();

  const skipAll = document.getElementById("stages-skip-all");
  if (skipAll)
    skipAll.onclick = () => {
      if (confirm("Skip all processing stages and open the editor with no segments?")) skipAllStages();
    };
}
