// The editor screen: segment rows (each transcript field bound to a plain
// textarea + RSML live preview), an editable waveform with a free-moving
// playhead, per-segment playback, a per-segment "verified" flag, playback
// follow (auto-scroll + highlight), and SRT export.
//
// Large projects (hundreds of segments) stay responsive because the RSML
// preview binding is created only for rows near the viewport
// (IntersectionObserver + a backstop sweep) and torn down once they scroll
// far away. A collapsed row is just a bit of text.

import RSMLAnnotator from "https://cdn.jsdelivr.net/npm/rsml@3.2.0/rsml.esm.js";
import {
  getState,
  runtime,
  segId,
  showScreen,
  scheduleSave,
  toast,
  escapeHtml,
} from "./main.js";
import * as wav from "./wav.js";
import * as wf from "./waveform.js";
import { buildSRT, downloadSRT } from "./srt.js";

const ACTIVATE_MARGIN = "600px"; // IntersectionObserver rootMargin
const ACTIVATE_DIST = 500; // px from the scroll viewport within which the sweep also activates
const KEEP_DIST = 1500; // px from the scroll viewport before a row is torn down
const MAX_ACTIVE = 24; // hard cap on live RSML preview bindings
const PLACEHOLDER = "(no transcript yet - click to edit)";

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
  list.appendChild(buildLeadingGap());
  s.segments.sort((a, b) => a.start - b.start);
  for (const seg of s.segments) {
    const rowEl = buildRow(seg);
    list.appendChild(rowEl);
    list.appendChild(rows.get(seg.id).gapEl);
  }
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

  keyHandler = handleShortcut;
  // Capture phase: a segment's CodeMirror instance has its own keymap and
  // sits between window and the event source, so a bubble-phase listener
  // could have combos like Tab silently eaten by CM6 before they reach us.
  // Capturing means we always see the keydown first and decide whether to
  // preventDefault() it ourselves, regardless of what currently has focus.
  window.addEventListener("keydown", keyHandler, true);
}

export function unmountEditor() {
  if (!mounted) return;
  mounted = false;
  clearInterval(sweepTimer);
  if (keyHandler) window.removeEventListener("keydown", keyHandler, true);
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
      onRegionCreate: (start, end) => addSegment(start, end),
      onTime: onPlayhead,
      onView: () => {
        updateScrubHead();
        updateScrubMarks();
      },
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
    updateScrubMarks();
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

// Draw a green band on the scrub strip for every verified segment that falls
// within the visible time window, so verified work stays visible while
// scrubbing even when the waveform itself is scrolled past it.
function updateScrubMarks() {
  const scrub = document.getElementById("wf-scrub");
  if (!scrub || !wf.isReady()) return;
  let marks = scrub.querySelector(".wf-scrub-marks");
  if (!marks) {
    marks = document.createElement("div");
    marks.className = "wf-scrub-marks";
    scrub.prepend(marks); // behind #wf-scrub-head, which comes after it in the DOM
  }
  const { start, end } = wf.getView();
  const span = end - start;
  if (span <= 0) {
    marks.replaceChildren();
    return;
  }
  const html = getState()
    .segments.filter((s) => s.verified)
    .map((s) => {
      const l = Math.max(0, Math.min(1, (s.start - start) / span));
      const r = Math.max(0, Math.min(1, (s.end - start) / span));
      if (r <= l) return "";
      return `<div class="wf-scrub-mark" style="left:${(l * 100).toFixed(3)}%;width:${((r - l) * 100).toFixed(3)}%"></div>`;
    })
    .join("");
  marks.innerHTML = html;
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
  const current = segs.find((s) => s.id === activeId);
  if (current && t >= current.start && t < current.end) return; // still inside the active segment — don't hop to an earlier overlapping one
  for (const seg of segs) {
    if (t >= seg.start && t < seg.end) {
      setActive(seg.id, { scroll: wf.isPlaying() });
      return;
    }
  }
  // in a gap between segments: leave the current active row as-is
}

// -------------------------------------------------------------- rows ----

// The one fixed "add a segment before the first one" control at the top of
// #seg-list (mirrors each row's own trailing .seg-gap, which inserts after
// it). It looks up the current first segment at click time rather than
// capturing one, since which segment is first can change underneath it.
function buildLeadingGap() {
  const wrap = document.createElement("div");
  wrap.className = "seg-gap";
  wrap.innerHTML = '<button class="seg-gap-btn" title="Add segment before the first one"><i class="bi bi-plus-lg"></i></button>';
  wrap.querySelector("button").onclick = () => {
    const first = getState().segments[0];
    if (first) {
      const span = Math.max(1, first.end - first.start);
      addSegment(Math.max(0, first.start - span), first.start);
    } else {
      const t = wf.isReady() ? wf.getCurrentTime() : 0;
      const dur = wav.getDuration() || t + 2;
      addSegment(t, Math.min(t + 2, dur));
    }
  };
  return wrap;
}

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
      <button class="btn btn-sm btn-outline-primary seg-play" title="Play this segment"><i class="bi bi-play-fill"></i></button>
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
      <div class="panes-resize" title="Drag to resize"></div>
    </div>`;

  const els = {
    check: row.querySelector(".seg-check"),
    idx: row.querySelector(".seg-idx"),
    dur: row.querySelector(".seg-dur"),
    play: row.querySelector(".seg-play"),
    starts: row.querySelectorAll('.time-group[data-edge="start"] input'),
    ends: row.querySelectorAll('.time-group[data-edge="end"] input'),
  };
  const host = row.querySelector(".rsml-host");
  const output = row.querySelector(".rsml-output");
  // A small "add segment after this one" control rendered as its own sibling
  // in #seg-list, between this row and the next, rather than a button
  // inline in the row's own toolbar.
  const gapEl = document.createElement("div");
  gapEl.className = "seg-gap";
  gapEl.innerHTML = '<button class="seg-gap-btn" title="Add segment after this one"><i class="bi bi-plus-lg"></i></button>';
  gapEl.querySelector("button").onclick = () => {
    const span = Math.max(1, seg.end - seg.start);
    addSegment(seg.end, wav.getDuration() ? Math.min(seg.end + span, wav.getDuration()) : seg.end + span);
  };
  const rec = { seg, el: row, host, output, gapEl, plainEl: null, textarea: null, annotator: null, active: false, els };
  rows.set(seg.id, rec);

  setCollapsed(rec); // start collapsed; IntersectionObserver upgrades it

  // One shared puller resizes both the transcription editor and the preview
  // together (a --panes-h custom property both panes read their height from),
  // instead of each pane growing independently to its own content.
  const panesEl = row.querySelector(".seg-panes");
  const resizer = row.querySelector(".panes-resize");
  const PANES_MIN_H = 96;
  const PANES_MAX_H = 800;
  let resizeStartY = 0;
  let resizeStartH = 0;
  resizer.onpointerdown = (e) => {
    e.preventDefault();
    resizeStartY = e.clientY;
    resizeStartH = host.getBoundingClientRect().height || 320;
    resizer.classList.add("dragging");
    try {
      resizer.setPointerCapture(e.pointerId);
    } catch {}
  };
  resizer.onpointermove = (e) => {
    if (!resizer.hasPointerCapture || !resizer.hasPointerCapture(e.pointerId)) return;
    const h = Math.max(PANES_MIN_H, Math.min(PANES_MAX_H, resizeStartH + (e.clientY - resizeStartY)));
    panesEl.style.setProperty("--panes-h", `${h}px`);
  };
  const endResize = (e) => {
    resizer.classList.remove("dragging");
    try {
      resizer.releasePointerCapture(e.pointerId);
    } catch {}
  };
  resizer.onpointerup = endResize;
  resizer.onpointercancel = endResize;

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
  els.play.onclick = () => {
    if (!wf.isReady()) return;
    wf.toggleSegment(seg.id, (playing) => setPlayButton(seg.id, playing));
  };
  row.querySelector(".seg-del").onclick = () => removeSegment(seg.id);

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
    // state.rsmlConfig is a straight snapshot of a prior RSMLAnnotator's
    // .opts (see rsmlSettings.js), so it can be spread in as-is — same
    // shape the constructor already expects.
    rec.annotator = new RSMLAnnotator({ textarea: ta, output: rec.output, ...(getState().rsmlConfig || {}) });
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

// Called from the settings drawer after an RSMLAnnotator.add()/.remove()
// on the shared config instance (see rsmlSettings.js). Replays the exact
// same call on every already-active row's own annotator — rsml@3.2.0's
// add/remove update a live instance in place (re-render + CM6 decoration
// refresh included), so this needs no rebuild and is safe even on a row
// that's currently focused/mid-edit.
export function applyRsmlChange(category, action, value, label) {
  for (const rec of rows.values()) {
    if (!rec.active || !rec.annotator) continue;
    try {
      rec.annotator[action](category, value, label);
    } catch (err) {
      console.warn(`RSMLAnnotator.${action}("${category}", ...) failed on an open row`, err);
    }
  }
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

// ------------------------------------------------------- shortcuts ----
//
// Everything below is keyboard-only, meant to make a full transcribe pass
// possible without touching the mouse. Every combo carries a modifier
// (Ctrl+Shift+*, Shift+Enter, Tab/Shift+Tab) and fires regardless of focus,
// including while typing in a segment's own RSML editor — that's the
// point, since that's where time is actually spent. None of them are bare
// letters, so there's no need to gate on "not currently in a text field".

// Scopes shortcuts to the editor's own UI (segment list + waveform
// controls) so they don't fire while, say, typing into the settings
// drawer's "add tag name" field — that overlay sits on top of the editor
// screen without unmounting it, so it needs its own exclusion.
function inShortcutScope(e) {
  const el = e.target;
  if (el === document.body) return true;
  return !!(el.closest && el.closest("#seg-list, #wf-controls, #wf-scrub, #waveform-panel"));
}

// Focuses a row's actual editing surface. A freshly-activated row's
// CodeMirror view doesn't exist yet (it boots async) so activate()'s own
// {focus:true} path focusing the underlying textarea is the best available
// — CM6 picks up the focus once it mounts. An already-active row's view
// does exist, and it's the real interactive surface (the textarea sits
// beneath it, hidden), so focus that directly.
function focusSegmentEditor(id) {
  const rec = rows.get(id);
  if (!rec) return;
  if (rec.annotator && rec.annotator.view) rec.annotator.view.focus();
  else if (rec.textarea) rec.textarea.focus();
}

// Moves the active segment by `dir` (+1/-1) in start-time order, seeks the
// playhead there, and focuses its editor — Tab/Shift+Tab and Shift+Enter
// all route through this so "keep moving forward while transcribing" stays
// one keystroke. No active segment yet: both directions land on the first.
function stepSegment(dir) {
  const ids = getState().segments.map((s) => s.id);
  if (!ids.length) return;
  const cur = activeId ? ids.indexOf(activeId) : -1;
  const idx = cur === -1 ? 0 : cur + dir;
  if (idx < 0 || idx >= ids.length) return; // at a boundary — no wraparound
  const id = ids[idx];
  activate(id, { focus: false });
  setActive(id, { scroll: true, seek: true });
  focusSegmentEditor(id);
}

function verifyActive() {
  const seg = activeId && getState().segments.find((x) => x.id === activeId);
  if (!seg || seg.verified) return;
  seg.verified = true;
  const rec = rows.get(activeId);
  if (rec) {
    rec.el.classList.add("verified");
    rec.els.check.checked = true;
  }
  updateVerifyCount();
  scheduleSave();
}

function stepSpeed(dir) {
  const sel = document.getElementById("set-speed");
  if (!sel) return;
  const i = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + dir));
  if (i === sel.selectedIndex) return;
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event("change"));
}

function toggleShortcutsModal(forceOpen) {
  const modal = document.getElementById("shortcuts-modal");
  const backdrop = document.getElementById("shortcuts-backdrop");
  if (!modal || !backdrop) return;
  const show = forceOpen != null ? forceOpen : modal.hidden;
  modal.hidden = !show;
  backdrop.hidden = !show;
}

function handleShortcut(e) {
  // Ctrl+/ always toggles the shortcuts modal, regardless of scope/focus
  // — it's a "how do I use this thing" escape hatch, useful even if focus
  // has ended up somewhere unexpected.
  if (e.ctrlKey && e.key === "/") {
    e.preventDefault();
    toggleShortcutsModal();
    return;
  }
  const modalOpen = !document.getElementById("shortcuts-modal")?.hidden;
  if (modalOpen) {
    if (e.key === "Escape") toggleShortcutsModal(false);
    return; // modal open: don't let segment shortcuts fire underneath it
  }

  if (!inShortcutScope(e)) return;

  if (e.shiftKey && e.code === "Space" && !e.ctrlKey) {
    e.preventDefault();
    if (wf.isReady()) wf.playPause();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "Space") {
    e.preventDefault();
    if (wf.isReady() && activeId) wf.toggleSegment(activeId, (playing) => setPlayButton(activeId, playing));
    return;
  }
  // Checks e.code AND both possible e.key values: some browser/OS/layout
  // combinations don't recompute the shifted character once Ctrl is also
  // held, so Ctrl+Shift+. can come through as e.code:"Period" (the normal,
  // reliable case), or with e.code missing/unreliable and e.key stuck at
  // the unshifted "." instead of ">" — exactly why this didn't fire
  // reliably before. Covering all three keeps it working either way.
  if (e.ctrlKey && e.shiftKey && (e.code === "Period" || e.key === ">" || e.key === ".")) {
    e.preventDefault();
    stepSpeed(1);
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.code === "Comma" || e.key === "<" || e.key === ",")) {
    e.preventDefault();
    stepSpeed(-1);
    return;
  }
  if (e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    verifyActive();
    stepSegment(1);
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    stepSegment(e.shiftKey ? -1 : 1);
    return;
  }
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
    verified: false,
  };
  s.segments.push(seg);
  s.segments.sort((a, b) => a.start - b.start);
  const list = document.getElementById("seg-list");
  const rowEl = buildRow(seg);
  const gapEl = rows.get(seg.id).gapEl;
  const nextSeg = s.segments[s.segments.indexOf(seg) + 1];
  if (nextSeg && rows.get(nextSeg.id)) {
    list.insertBefore(rowEl, rows.get(nextSeg.id).el);
    list.insertBefore(gapEl, rows.get(nextSeg.id).el);
  } else {
    list.appendChild(rowEl);
    list.appendChild(gapEl);
  }
  if (io) io.observe(rowEl);
  reindex();
  updateVerifyCount();
  document.getElementById("editor-empty").hidden = true;
  if (wf.isReady()) wf.setRegions(s.segments);
  scheduleSave();
  selectRow(seg.id, false);
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
    r.gapEl.remove();
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
  if (wf.isReady()) {
    wf.syncRegionColors(s.segments);
    updateScrubMarks();
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

// Jumps to the segment right after the last verified one (in start-time
// order) - "resume where I left off". No segment verified yet: the first
// segment. The last segment is already verified (nothing after it): stays
// on the last segment rather than doing nothing.
function jumpToLatest() {
  const segs = getState().segments;
  if (!segs.length) return;
  let lastVerified = -1;
  segs.forEach((s, i) => {
    if (s.verified) lastVerified = i;
  });
  const idx = Math.min(lastVerified + 1, segs.length - 1);
  const id = segs[idx].id;
  activate(id, { focus: false });
  setActive(id, { scroll: true, seek: true });
  focusSegmentEditor(id);
}

// ------------------------------------------------------------- chrome ----

function wireChrome() {
  bind("editor-back-btn", () => showScreen("setup"));
  bind("jump-latest-btn", jumpToLatest);
  bind("shortcuts-btn", () => toggleShortcutsModal());
  bind("close-shortcuts", () => toggleShortcutsModal(false));
  const shortcutsBackdrop = document.getElementById("shortcuts-backdrop");
  if (shortcutsBackdrop) shortcutsBackdrop.onclick = () => toggleShortcutsModal(false);

  const all = document.getElementById("verify-all");
  if (all) all.onchange = () => setAllVerified(all.checked);

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
