// The editor screen: segment rows (each transcript field bound to a plain
// textarea + RSML live preview), an editable waveform with a free-moving
// playhead, per-segment playback, a per-segment "verified" flag, playback
// follow (auto-scroll + highlight), and SRT export.
//
// Large projects (hundreds of segments) stay responsive because the RSML
// preview binding is created only for rows near the viewport
// (IntersectionObserver + a backstop sweep) and torn down once they scroll
// far away. A collapsed row is just a bit of text.

import RSMLAnnotator from "https://cdn.jsdelivr.net/npm/rsml@3/rsml.esm.js";
import {
  getState,
  runtime,
  segId,
  showScreen,
  scheduleSave,
  saveNow,
  toast,
  escapeHtml,
} from "./main.js";
import * as api from "./api.js";
import * as wav from "./wav.js";
import * as wf from "./waveform.js";
import { buildSRT, downloadSRT } from "./srt.js";

const ACTIVATE_MARGIN = "600px"; // IntersectionObserver rootMargin
const ACTIVATE_DIST = 500; // px from the scroll viewport within which the sweep also activates
const KEEP_DIST = 1500; // px from the scroll viewport before a row is torn down
const MAX_ACTIVE = 24; // hard cap on live RSML preview bindings
const PLACEHOLDER = "(no transcript yet - click to edit, or use Transcribe)";

let mounted = false;
let rows = new Map(); // segId -> Row
let io = null;
let sweepTimer = null;
let keyHandler = null;
let activeId = null; // the one highlighted "active" segment (click / region / playback)
let lastAutoScroll = 0;

// Row = { seg, el, host, output, plainEl, textarea, annotator, active, els }

// --------------------------------------------------------------- mount ----

export async function mountEditor() {
  if (mounted) return;
  mounted = true;
  const s = getState();

  document.getElementById("editor-empty").hidden = s.segments.length > 0;
  wireChrome();
  wireWaveformControls();

  const list = document.getElementById("seg-list");
  list.innerHTML = "";
  rows.clear();
  s.segments.sort((a, b) => a.start - b.start);
  for (const seg of s.segments) list.appendChild(buildRow(seg));
  reindex();
  updateVerifyCount();

  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) activate(e.target.dataset.id, { focus: false });
    },
    { root: list, rootMargin: ACTIVATE_MARGIN }
  );
  for (const { el } of rows.values()) io.observe(el);

  await initWaveform();

  clearInterval(sweepTimer);
  sweepTimer = setInterval(sweep, 1200);

  keyHandler = (e) => {
    if (e.shiftKey && e.code === "Space") {
      e.preventDefault();
      if (wf.isReady()) wf.playPause();
    }
  };
  window.addEventListener("keydown", keyHandler);
}

export function unmountEditor() {
  if (!mounted) return;
  mounted = false;
  clearInterval(sweepTimer);
  if (keyHandler) window.removeEventListener("keydown", keyHandler);
  keyHandler = null;
  if (io) io.disconnect();
  io = null;
  activeId = null;
  for (const row of rows.values()) {
    syncOne(row);
    try {
      row.annotator && row.annotator.destroy && row.annotator.destroy();
    } catch {}
  }
  rows.clear();
  wf.destroy();
}

// --------------------------------------------------------- waveform ----

async function initWaveform() {
  const panel = document.getElementById("waveform-panel");
  const note = document.getElementById("waveform-note");
  if (!runtime.workingBlob || !wav.hasAudio()) {
    panel.hidden = true;
    note.hidden = false;
    return;
  }
  panel.hidden = false;
  note.hidden = true;
  try {
    await wf.initWaveform(document.getElementById("waveform"), runtime.workingBlob, {
      onRegionUpdate: (id, start, end) => {
        const seg = getState().segments.find((x) => x.id === id);
        if (!seg) return;
        seg.start = Math.max(0, start);
        seg.end = Math.max(seg.start + 0.02, end);
        refreshRowTimes(seg);
        scheduleSave();
      },
      onRegionClick: (id) => selectRow(id, false),
      onTime: onPlayhead,
      onView: () => updateScrubHead(),
      onPlayState: (playing) => {
        const b = document.getElementById("wf-play");
        if (b) b.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
        if (!playing) resetAllPlayButtons();
      },
      onSegmentEnd: (id) => setPlayButton(id, false),
    });
    wf.setZoom(getState().ui.zoom || 40);
    wf.setSpeed(getState().ui.speed || 1);
    wf.setRegions(getState().segments);
    updateScrubHead(0);
  } catch (err) {
    console.warn("waveform init failed", err);
    panel.hidden = true;
    note.hidden = false;
    note.textContent = "Waveform failed to load (needs internet for the WaveSurfer library on first run).";
  }
}

function onPlayhead(t) {
  const clock = document.getElementById("wf-clock");
  if (clock) clock.textContent = fmtClock(t);
  updateScrubHead(t);
  followPlayback(t);
}

// Position the scrub-strip handle to match the WaveSurfer cursor. The strip
// spans the *visible* time window, so this holds at any zoom / scroll offset;
// the handle hides when the cursor is scrolled out of view.
function updateScrubHead(t) {
  const head = document.getElementById("wf-scrub-head");
  if (!head) return;
  const { start, end } = wf.getView();
  const span = end - start;
  if (span <= 0) {
    head.hidden = true;
    return;
  }
  const cur = t == null ? wf.getCurrentTime() : t;
  const f = (cur - start) / span;
  if (f < -0.001 || f > 1.001) {
    head.hidden = true;
    return;
  }
  head.hidden = false;
  head.style.left = `${Math.min(100, Math.max(0, f * 100))}%`;
}

// The single "active segment" highlight. Set by a click anywhere in a row, a
// click on its waveform region, or playback moving into it.
function setActive(id, { scroll = false, seek = false } = {}) {
  if (!rows.has(id)) return;
  if (id !== activeId) {
    activeId = id;
    for (const [rid, r] of rows) r.el.classList.toggle("is-active", rid === id);
    if (wf.isReady()) wf.highlightRegion(id);
    wf.isReady() && wf.setLoop(document.getElementById("wf-loop")?.classList.contains("active") ? id : null);
  }
  const rec = rows.get(id);
  if (seek && wf.isReady()) {
    const seg = getState().segments.find((x) => x.id === id);
    if (seg) wf.seekTo(seg.start);
  }
  if (scroll) {
    const listEl = document.getElementById("seg-list");
    const ae = document.activeElement;
    const editing = listEl.contains(ae) && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT");
    const now = performance.now();
    if (!editing && now - lastAutoScroll > 350) {
      const rb = rec.el.getBoundingClientRect();
      const lb = listEl.getBoundingClientRect();
      if (rb.top < lb.top || rb.bottom > lb.bottom) {
        rec.el.scrollIntoView({ block: "center", behavior: "smooth" });
        lastAutoScroll = now;
      }
    }
  }
}

// While audio plays, keep the segment under the playhead active and in view.
function followPlayback(t) {
  const segs = getState().segments;
  for (const seg of segs) {
    if (t >= seg.start && t < seg.end) {
      if (seg.id !== activeId) setActive(seg.id, { scroll: wf.isPlaying() });
      return;
    }
  }
  // in a gap between segments: leave the current active row as-is
}

// -------------------------------------------------------------- rows ----

function buildRow(seg) {
  const row = document.createElement("div");
  row.className = "seg-row" + (seg.verified ? " verified" : "");
  row.dataset.id = seg.id;
  row.innerHTML = `
    <div class="seg-bar">
      <input type="checkbox" class="seg-check" ${seg.verified ? "checked" : ""} title="Mark this segment verified" />
      <span class="seg-idx">0</span>
      ${seg.speaker ? `<span class="seg-spk" title="from diarization">${escapeHtml(seg.speaker)}</span>` : ""}
      <div class="time-group" data-edge="start">${timeInputs(seg.start)}</div>
      <span class="time-sep">&rarr;</span>
      <div class="time-group" data-edge="end">${timeInputs(seg.end)}</div>
      <span class="seg-dur"></span>
      <span class="flex-spacer"></span>
      <select class="seg-lang" title="Language for this segment">${langOptions(seg.language || "")}</select>
      <button class="btn btn-sm btn-outline-primary seg-play" title="Play this segment"><i class="bi bi-play-fill"></i></button>
      <button class="btn btn-sm btn-primary seg-transcribe">Transcribe</button>
      <span class="seg-status" data-status="${seg.status || "empty"}"></span>
      <button class="btn btn-sm btn-link seg-add" title="Add segment after this one"><i class="bi bi-plus-lg"></i></button>
      <button class="btn btn-sm btn-link text-danger seg-del" title="Delete segment"><i class="bi bi-trash"></i></button>
    </div>
    <div class="seg-panes">
      <div class="seg-pane seg-editor">
        <div class="pane-label">RSML Transcription</div>
        <div class="rsml-host"></div>
      </div>
      <div class="seg-pane seg-preview">
        <div class="pane-label">Preview</div>
        <div class="rsml-output"></div>
      </div>
    </div>`;

  const els = {
    check: row.querySelector(".seg-check"),
    idx: row.querySelector(".seg-idx"),
    dur: row.querySelector(".seg-dur"),
    status: row.querySelector(".seg-status"),
    transcribe: row.querySelector(".seg-transcribe"),
    play: row.querySelector(".seg-play"),
    lang: row.querySelector(".seg-lang"),
    starts: row.querySelectorAll('.time-group[data-edge="start"] input'),
    ends: row.querySelectorAll('.time-group[data-edge="end"] input'),
  };
  const host = row.querySelector(".rsml-host");
  const output = row.querySelector(".rsml-output");
  const rec = { seg, el: row, host, output, plainEl: null, textarea: null, annotator: null, active: false, els };
  rows.set(seg.id, rec);

  setCollapsed(rec); // start collapsed; IntersectionObserver upgrades it

  els.check.onchange = () => {
    seg.verified = els.check.checked;
    row.classList.toggle("verified", seg.verified);
    updateVerifyCount();
    scheduleSave();
  };
  // A click anywhere in the row (bar, times, textarea, preview, buttons) marks
  // it the active segment. No scroll / no seek here, so editing is undisturbed.
  row.addEventListener("pointerdown", () => setActive(seg.id));
  // Clicking the empty part of the bar additionally jumps the playhead there.
  row.querySelector(".seg-bar").addEventListener("click", (e) => {
    if (e.target.closest("button, input, select, .time-group")) return;
    selectRow(seg.id, true);
  });
  els.lang.onchange = () => {
    seg.language = els.lang.value;
    scheduleSave();
  };
  els.play.onclick = () => {
    if (!wf.isReady()) return;
    wf.toggleSegment(seg.id, (playing) => setPlayButton(seg.id, playing));
  };
  row.querySelector(".seg-del").onclick = () => removeSegment(seg.id);
  row.querySelector(".seg-add").onclick = () => {
    const span = Math.max(1, seg.end - seg.start);
    addSegment(seg.end, wav.getDuration() ? Math.min(seg.end + span, wav.getDuration()) : seg.end + span);
  };
  els.transcribe.onclick = () => transcribeOne(seg.id);

  const onTimeInput = (edge) => {
    const inputs = edge === "start" ? els.starts : els.ends;
    let v = readTimeInputs(inputs);
    const dur = wav.getDuration() || Infinity;
    v = Math.max(0, Math.min(v, dur));
    if (edge === "start") seg.start = Math.min(v, seg.end - 0.02);
    else seg.end = Math.max(v, seg.start + 0.02);
    refreshRowTimes(seg);
    if (wf.isReady()) wf.updateRegion(seg.id, seg.start, seg.end);
    scheduleSave();
  };
  els.starts.forEach((i) => (i.onchange = () => onTimeInput("start")));
  els.ends.forEach((i) => (i.onchange = () => onTimeInput("end")));

  updateDur(seg);
  updateStatus(seg);
  return row;
}

function setCollapsed(rec) {
  const p = document.createElement("div");
  p.className = "rsml-plain";
  p.textContent = rec.seg.rsml || PLACEHOLDER;
  if (!rec.seg.rsml) p.classList.add("is-empty");
  p.onclick = () => activate(rec.seg.id, { focus: true });
  rec.host.innerHTML = "";
  rec.host.appendChild(p);
  rec.plainEl = p;
  rec.output.textContent = rec.seg.rsml || "";
}

function activate(id, { focus }) {
  const rec = rows.get(id);
  if (!rec) return;
  if (rec.active) {
    if (focus && rec.textarea) rec.textarea.focus();
    return;
  }
  enforceCap(id);

  const ta = document.createElement("textarea");
  ta.className = "rsml-textarea";
  ta.spellcheck = false;
  ta.value = rec.seg.rsml || "";
  rec.host.innerHTML = "";
  rec.host.appendChild(ta);
  rec.output.innerHTML = "";
  rec.plainEl = null;
  rec.textarea = ta;
  rec.active = true;
  rec.el.classList.add("cm-live");

  // Hand the textarea + output straight to the rsml library and let it do its
  // full thing (CodeMirror editor, syntax highlighting, autocomplete, inline
  // validation, live preview). If it throws, fall back to a plain textarea that
  // at least mirrors its text into the preview.
  try {
    rec.annotator = new RSMLAnnotator({ textarea: ta, output: rec.output });
  } catch (err) {
    console.warn("RSMLAnnotator failed, plain textarea fallback", err);
    rec.annotator = null;
    rec.output.textContent = ta.value;
    ta.addEventListener("input", () => {
      rec.seg.rsml = ta.value;
      rec.output.textContent = ta.value;
      scheduleSave();
    });
  }
  // Always mirror edits straight to state on input (belt and braces alongside
  // the sweep's getValue() poll).
  ta.addEventListener("input", () => {
    if (rec.seg.rsml !== ta.value) {
      rec.seg.rsml = ta.value;
      if (rec.seg.status === "empty" && ta.value.trim()) {
        rec.seg.status = "done";
        updateStatus(rec.seg);
      }
      scheduleSave();
    }
  });
  if (focus) ta.focus();
}

function deactivate(id) {
  const rec = rows.get(id);
  if (!rec || !rec.active) return;
  if (rec.el.contains(document.activeElement)) return; // don't yank a focused editor
  syncOne(rec);
  try {
    rec.annotator && rec.annotator.destroy && rec.annotator.destroy();
  } catch {}
  rec.annotator = null;
  rec.textarea = null;
  rec.active = false;
  rec.el.classList.remove("cm-live");
  setCollapsed(rec);
}

function enforceCap(keepId) {
  let actives = [...rows.values()].filter((r) => r.active);
  if (actives.length < MAX_ACTIVE) return;
  const list = document.getElementById("seg-list");
  const vr = list.getBoundingClientRect();
  const cands = actives
    .filter((r) => r.seg.id !== keepId && r.seg.id !== activeId && !r.el.contains(document.activeElement))
    .map((r) => ({ r, d: distFromViewport(r.el, vr) }))
    .sort((a, b) => b.d - a.d);
  while ([...rows.values()].filter((r) => r.active).length >= MAX_ACTIVE && cands.length) {
    deactivate(cands.shift().r.seg.id);
  }
}

function timeInputs(sec) {
  const { h, m, s, ms } = splitTime(sec);
  return (
    `<input type="number" min="0" max="99" value="${h}" aria-label="hours">` +
    `<span>:</span><input type="number" min="0" max="59" value="${pad2(m)}" aria-label="minutes">` +
    `<span>:</span><input type="number" min="0" max="59" value="${pad2(s)}" aria-label="seconds">` +
    `<span>.</span><input type="number" min="0" max="999" value="${pad3(ms)}" class="ms" aria-label="milliseconds">`
  );
}

function langOptions(selectedCode) {
  const langs = runtime.languages && runtime.languages.length ? runtime.languages : [{ code: "", label: "Auto" }];
  return langs
    .map(
      (l) =>
        `<option value="${escapeHtml(l.code)}"${l.code === (selectedCode || "") ? " selected" : ""}>${escapeHtml(
          l.code === "" ? "Auto" : l.label
        )}</option>`
    )
    .join("");
}

function readTimeInputs(inputs) {
  const [h, m, s, ms] = [...inputs].map((i) => parseInt(i.value || "0", 10) || 0);
  return h * 3600 + m * 60 + s + ms / 1000;
}

function refreshRowTimes(seg) {
  const r = rows.get(seg.id);
  if (!r) return;
  const setGroup = (inputs, sec) => {
    const { h, m, s, ms } = splitTime(sec);
    inputs[0].value = h;
    inputs[1].value = pad2(m);
    inputs[2].value = pad2(s);
    inputs[3].value = pad3(ms);
  };
  setGroup(r.els.starts, seg.start);
  setGroup(r.els.ends, seg.end);
  updateDur(seg);
}

function updateDur(seg) {
  const r = rows.get(seg.id);
  if (r) r.els.dur.textContent = `${(seg.end - seg.start).toFixed(2)}s`;
}

function updateStatus(seg) {
  const r = rows.get(seg.id);
  if (!r) return;
  const map = { empty: "", transcribing: "...", done: "✓", error: "!" };
  r.els.status.dataset.status = seg.status || "empty";
  r.els.status.textContent = map[seg.status || "empty"] || "";
  r.els.transcribe.disabled = seg.status === "transcribing" || !wav.hasAudio();
}

function setPlayButton(id, playing) {
  const r = rows.get(id);
  if (r) r.els.play.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
}

function resetAllPlayButtons() {
  const active = wf.playingSegment();
  for (const [id, r] of rows) {
    if (id === active) continue;
    r.els.play.innerHTML = '<i class="bi bi-play-fill"></i>';
  }
}

function reindex() {
  const s = getState();
  s.segments.forEach((seg, i) => {
    const r = rows.get(seg.id);
    if (r) r.els.idx.textContent = i + 1;
  });
  const n = document.getElementById("seg-count-n");
  if (n) n.textContent = s.segments.length;
}

// Full "go to this segment": highlight it, mount its editor, scroll it into
// view, and optionally move the playhead to its start.
function selectRow(id, seek) {
  activate(id, { focus: false });
  setActive(id, { scroll: true, seek });
}

// ---------------------------------------------------------- segments ----

function addSegment(start, end) {
  const s = getState();
  const dur = wav.getDuration() || end || start + 2;
  const seg = {
    id: segId(),
    start: Math.max(0, Math.min(start, dur)),
    end: Math.max(start + 0.02, Math.min(end, dur)),
    rsml: "",
    speaker: null,
    status: "empty",
    verified: false,
    language: document.getElementById("lang-bulk")?.value || "",
  };
  s.segments.push(seg);
  s.segments.sort((a, b) => a.start - b.start);
  const list = document.getElementById("seg-list");
  const rowEl = buildRow(seg);
  const nextSeg = s.segments[s.segments.indexOf(seg) + 1];
  if (nextSeg && rows.get(nextSeg.id)) list.insertBefore(rowEl, rows.get(nextSeg.id).el);
  else list.appendChild(rowEl);
  if (io) io.observe(rowEl);
  reindex();
  updateVerifyCount();
  document.getElementById("editor-empty").hidden = true;
  if (wf.isReady()) wf.setRegions(s.segments);
  scheduleSave();
  selectRow(seg.id, false);
}

function addSegmentAtPlayhead() {
  const t = wf.isReady() ? wf.getCurrentTime() : 0;
  const dur = wav.getDuration() || t + 2;
  addSegment(t, Math.min(t + 2, dur));
}

function removeSegment(id) {
  const s = getState();
  const r = rows.get(id);
  if (r) {
    try {
      r.annotator && r.annotator.destroy && r.annotator.destroy();
    } catch {}
    if (io) io.unobserve(r.el);
    r.el.remove();
    rows.delete(id);
  }
  if (activeId === id) activeId = null;
  s.segments = s.segments.filter((x) => x.id !== id);
  reindex();
  updateVerifyCount();
  document.getElementById("editor-empty").hidden = s.segments.length > 0;
  if (wf.isReady()) wf.setRegions(s.segments);
  scheduleSave();
}

// -------------------------------------------------------- transcribe ----

async function transcribeOne(id) {
  const s = getState();
  const seg = s.segments.find((x) => x.id === id);
  if (!seg) return;
  if (!wav.hasAudio()) {
    toast("No audio loaded, so this segment cannot be transcribed.", "error");
    return;
  }
  seg.status = "transcribing";
  updateStatus(seg);
  try {
    const clip = wav.sliceToWav(seg.start, seg.end);
    const res = await api.transcribe(clip, {
      language: seg.language || "",
      model: s.transcription.model,
      apiKey: s.transcription.apiKey,
    });
    const text = (res.text || "").trim();
    const r = rows.get(id);
    if (r && r.active && r.annotator && r.annotator.setValue) r.annotator.setValue(text);
    else if (r && r.active && r.textarea) r.textarea.value = text;
    else if (r && r.plainEl) {
      r.plainEl.textContent = text || PLACEHOLDER;
      r.plainEl.classList.toggle("is-empty", !text);
      r.output.textContent = text;
    }
    seg.rsml = text;
    seg.status = text ? "done" : "empty";
    scheduleSave();
  } catch (err) {
    seg.status = "error";
    const warn = err && err.code === "not_configured";
    toast(warn ? err.message : `Transcription failed: ${err.message || err}`, warn ? "warn" : "error");
  } finally {
    updateStatus(seg);
  }
}

async function transcribeAll() {
  const targets = getState().segments.filter((seg) => seg.status !== "done" && seg.status !== "transcribing");
  if (!targets.length) {
    toast("Every segment already has a transcript.", "info");
    return;
  }
  const bar = document.getElementById("transcribe-all-progress");
  bar.hidden = false;
  let done = 0;
  for (const seg of targets) {
    if (!mounted) break;
    await transcribeOne(seg.id);
    done++;
    bar.querySelector(".bar-fill").style.width = `${Math.round((done / targets.length) * 100)}%`;
    bar.querySelector(".bar-text").textContent = `${done}/${targets.length}`;
  }
  await saveNow();
  setTimeout(() => (bar.hidden = true), 1500);
}

// ------------------------------------------------------------- verified ----

function updateVerifyCount() {
  const s = getState();
  const n = s.segments.filter((x) => x.verified).length;
  const cnt = document.getElementById("verify-count");
  if (cnt) cnt.textContent = `${n} / ${s.segments.length}`;
  const all = document.getElementById("verify-all");
  if (all) {
    all.checked = n > 0 && n === s.segments.length;
    all.indeterminate = n > 0 && n < s.segments.length;
  }
}

function setAllVerified(v) {
  for (const seg of getState().segments) seg.verified = v;
  for (const r of rows.values()) {
    r.els.check.checked = v;
    r.el.classList.toggle("verified", v);
  }
  updateVerifyCount();
  scheduleSave();
}

function setAllLanguages(code) {
  for (const seg of getState().segments) seg.language = code;
  for (const r of rows.values()) if (r.els.lang) r.els.lang.value = code;
  scheduleSave();
}

// ------------------------------------------------------------- chrome ----

function wireChrome() {
  bind("editor-back-btn", () => showScreen("stages"));
  bind("add-seg-btn", addSegmentAtPlayhead);
  bind("transcribe-all-btn", transcribeAll);

  const all = document.getElementById("verify-all");
  if (all) all.onchange = () => setAllVerified(all.checked);

  const lb = document.getElementById("lang-bulk");
  if (lb) lb.innerHTML = langOptions(lb.value || "");
  bind("lang-apply", () => {
    const lb2 = document.getElementById("lang-bulk");
    if (lb2 && confirm(`Set the language of all ${getState().segments.length} segments to "${lb2.options[lb2.selectedIndex]?.text || "Auto"}"?`))
      setAllLanguages(lb2.value);
  });

  bind("export-srt-btn", () => {
    const s = getState();
    if (!s.segments.length) {
      toast("Nothing to export yet.", "info");
      return;
    }
    const name = (s.audioMeta && s.audioMeta.name) || "transcript";
    downloadSRT(name, buildSRT(s.segments));
  });
}

function wireWaveformControls() {
  bind("wf-play", () => wf.isReady() && wf.playPause());
  bind("wf-stop", () => wf.isReady() && wf.stop());

  const zoom = document.getElementById("wf-zoom");
  if (zoom) {
    zoom.value = String(getState().ui.zoom || 40);
    zoom.oninput = () => {
      getState().ui.zoom = parseInt(zoom.value, 10);
      if (wf.isReady()) wf.setZoom(getState().ui.zoom);
      updateScrubHead();
      scheduleSave();
    };
  }

  const spd = document.getElementById("set-speed");
  if (spd) {
    spd.value = String(getState().ui.speed || 1);
    spd.onchange = () => {
      getState().ui.speed = parseFloat(spd.value);
      if (wf.isReady()) wf.setSpeed(getState().ui.speed);
      scheduleSave();
    };
  }

  const loop = document.getElementById("wf-loop");
  if (loop)
    loop.onclick = () => {
      loop.classList.toggle("active");
      wf.setLoop(loop.classList.contains("active") ? activeId : null);
    };

  // Dedicated scrub strip: drag anywhere on it to move the playhead, never
  // touching segment regions. Dragging to (or past) an edge auto-pans the
  // waveform so one drag can scrub the whole clip. Uses on* properties so
  // re-mounting the editor does not stack listeners on this persistent element.
  const scrub = document.getElementById("wf-scrub");
  if (scrub) {
    let dragging = false;
    let lastX = 0;
    let edgeTimer = null;

    const fracAt = (clientX) => {
      const r = scrub.getBoundingClientRect();
      const w = scrub.clientWidth || 1; // content box, matches the handle % origin
      return (clientX - r.left - scrub.clientLeft) / w; // may be <0 or >1 past an edge
    };
    const apply = () => {
      if (wf.isReady()) wf.scrubTo(fracAt(lastX));
    };
    const stopEdge = () => {
      if (edgeTimer) clearInterval(edgeTimer);
      edgeTimer = null;
    };
    const startEdge = () => {
      stopEdge();
      edgeTimer = setInterval(() => {
        if (!dragging || !wf.isReady()) return;
        const f = fracAt(lastX);
        if (f <= 0.06) wf.scrubTo(Math.min(f - 0.06, -0.01));
        else if (f >= 0.94) wf.scrubTo(Math.max(f + 0.06, 1.01));
      }, 110);
    };

    scrub.onpointerdown = (e) => {
      dragging = true;
      lastX = e.clientX;
      try {
        scrub.setPointerCapture(e.pointerId);
      } catch {}
      apply();
      startEdge();
    };
    scrub.onpointermove = (e) => {
      if (!dragging) return;
      lastX = e.clientX;
      apply();
    };
    const end = (e) => {
      dragging = false;
      stopEdge();
      try {
        if (e && e.pointerId != null) scrub.releasePointerCapture(e.pointerId);
      } catch {}
    };
    scrub.onpointerup = end;
    scrub.onpointercancel = end;
    scrub.onlostpointercapture = end;
  }

  // Mouse wheel / trackpad over the waveform (or the scrub strip) scrolls it
  // horizontally. Only pans; the playhead stays put.
  const wheelPan = (e) => {
    if (!wf.isReady()) return;
    const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!raw) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (e.currentTarget.clientWidth || 400) : 1;
    e.preventDefault();
    wf.scrollByPixels(raw * unit * 0.5); // 0.5 = gentler than a 1:1 wheel
  };
  const wfEl = document.getElementById("waveform");
  if (wfEl) wfEl.onwheel = wheelPan;
  if (scrub) scrub.onwheel = wheelPan;
}

// --------------------------------------------------------- rsml sync ----

function syncOne(rec) {
  if (!rec.annotator || !rec.annotator.getValue) {
    // plain textarea (annotator missing) - read it directly
    if (rec.textarea && rec.textarea.value !== rec.seg.rsml) {
      rec.seg.rsml = rec.textarea.value;
      return true;
    }
    return false;
  }
  let v;
  try {
    v = rec.annotator.getValue();
  } catch {
    v = rec.textarea ? rec.textarea.value : undefined;
  }
  const seg = rec.seg;
  if (typeof v !== "string" || v === seg.rsml) return false;
  if (v === "" && seg.rsml && (rec.textarea?.value || "").trim()) return false;
  seg.rsml = v;
  if (seg.status === "empty" && v.trim()) seg.status = "done";
  updateStatus(seg);
  return true;
}

function distFromViewport(el, vr) {
  const b = el.getBoundingClientRect();
  if (b.bottom < vr.top) return vr.top - b.bottom;
  if (b.top > vr.bottom) return b.top - vr.bottom;
  return 0;
}

// Backstop to the IntersectionObserver: pulls edits out of live bindings, tears
// down rows that scrolled far away, activates rows that came near the viewport.
function sweep() {
  if (!mounted) return;
  const list = document.getElementById("seg-list");
  const vr = list.getBoundingClientRect();
  let changed = false;

  for (const rec of rows.values()) {
    if (rec.active && syncOne(rec)) changed = true;
  }
  for (const rec of rows.values()) {
    if (!rec.active) continue;
    if (rec.seg.id === activeId) continue;
    if (rec.el.contains(document.activeElement)) continue;
    if (distFromViewport(rec.el, vr) > KEEP_DIST) deactivate(rec.seg.id);
  }
  for (const rec of rows.values()) {
    if (rec.active) continue;
    if (distFromViewport(rec.el, vr) <= ACTIVATE_DIST) activate(rec.seg.id, { focus: false });
  }
  if (changed) scheduleSave();
}

// --------------------------------------------------------------- utils ----

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.onclick = fn;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad3(n) {
  return String(n).padStart(3, "0");
}
function splitTime(sec) {
  sec = Math.max(0, sec || 0);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  let whole = Math.floor(sec);
  if (ms === 1000) whole += 1;
  return { h: Math.floor(whole / 3600), m: Math.floor(whole / 60) % 60, s: whole % 60, ms: ms % 1000 };
}
function fmtClock(t) {
  const { m, s } = splitTime(t);
  return `${pad2(m)}:${pad2(s)}`;
}
