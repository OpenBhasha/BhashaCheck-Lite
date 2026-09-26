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
import { speakerLabel, openSpeakerModal, defaultSpeakerId } from "./speakers.js";

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
      <select class="seg-speaker" title="Speaker">${speakerOptionsHtml(seg.speaker)}</select>
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
    </div>`;

  const els = {
    check: row.querySelector(".seg-check"),
    idx: row.querySelector(".seg-idx"),
    dur: row.querySelector(".seg-dur"),
    play: row.querySelector(".seg-play"),
    speaker: row.querySelector(".seg-speaker"),
    starts: row.querySelectorAll('.time-group[data-edge="start"] input'),
    ends: row.querySelectorAll('.time-group[data-edge="end"] input'),
  };
  const host = row.querySelector(".rsml-host");
  const output = row.querySelector(".rsml-output");
  // A small "add segment after this one" / "merge with next" control
  // rendered as its own sibling in #seg-list, between this row and the
  // next, rather than buttons inline in the row's own toolbar. The merge
  // button starts enabled and gets disabled by reindex() below whenever
  // this segment turns out to be the last one (nothing to merge into).
  const gapEl = document.createElement("div");
  gapEl.className = "seg-gap";
  gapEl.innerHTML =
    '<button class="seg-gap-btn" title="Add segment after this one"><i class="bi bi-plus-lg"></i></button>' +
    '<button class="seg-merge-btn" title="Merge with next segment"><i class="bi bi-arrows-collapse"></i></button>';
  gapEl.querySelector(".seg-gap-btn").onclick = () => {
    const span = Math.max(1, seg.end - seg.start);
    addSegment(seg.end, wav.getDuration() ? Math.min(seg.end + span, wav.getDuration()) : seg.end + span);
  };
  const mergeBtn = gapEl.querySelector(".seg-merge-btn");
  mergeBtn.onclick = () => mergeWithNext(seg.id);
  const rec = { seg, el: row, host, output, gapEl, mergeBtn, plainEl: null, textarea: null, annotator: null, active: false, els };
  rows.set(seg.id, rec);

  setCollapsed(rec); // start collapsed; IntersectionObserver upgrades it

  els.check.onchange = () => {
    seg.verified = els.check.checked;
    row.classList.toggle("verified", seg.verified);
    updateVerifyCount();
    scheduleSave();
  };
  els.speaker.onchange = () => {
    if (els.speaker.value === "__add__") {
      // Reset the visible selection back to whatever's actually assigned
      // while the modal is open, rather than sitting on "+ Add new speaker".
      els.speaker.innerHTML = speakerOptionsHtml(seg.speaker);
      openSpeakerModal(speakerDeps(), {
        onSaved: (sp) => {
          seg.speaker = sp.id;
          scheduleSave();
          els.speaker.innerHTML = speakerOptionsHtml(seg.speaker);
        },
      });
      return;
    }
    seg.speaker = parseInt(els.speaker.value, 10);
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
    patchCompletions(rec.annotator);
    patchStatusAlwaysVisible(rec.annotator);
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

// Called after the speaker roster changes (add/edit/remove/default), from
// either the settings drawer or a segment's own "+ Add new speaker" —
// rebuilds every row's speaker <select> options against the current roster.
export function refreshSpeakerDropdowns() {
  for (const rec of rows.values()) {
    rec.els.speaker.innerHTML = speakerOptionsHtml(rec.seg.speaker);
  }
}

// Mirrors rsml's own trigger regex exactly (see its _cmComplete source) so
// patchCompletions() can tell which prefix a given completion result came
// from without sniffing option labels for it.
const RSML_TRIGGER_RE = /\$\$[\w-]*|!![\w-]*|[@#!$&][\w-]*/;
function triggerPrefix(ctx) {
  const m = ctx.matchBefore(RSML_TRIGGER_RE);
  if (!m) return null;
  return m.text.startsWith("$$") ? "$$" : m.text.startsWith("!!") ? "!!" : m.text[0];
}

// Mirrors rsml's own internal bracketApply exactly (see the `!`/`#`/`$`/
// `$$`/`!!` cases in its _cmComplete source): scaffold-aware apply that
// reuses an existing `[verbatim]()` right after the trigger if present (the
// shape wrap-on-selection produces), otherwise inserts the full
// `typeSegment[]()` scaffold with the caret dropped between the brackets.
function bracketApply(typeSegment) {
  return (view, completion, from, to) => {
    const doc = view.state.doc;
    const after = doc.sliceString(to, Math.min(to + 500, doc.length));
    const scaf = /^\[([^\]]*)\](\([^)]*\))?/.exec(after);
    if (scaf) {
      const verbatim = scaf[1];
      view.dispatch({
        changes: { from, to, insert: typeSegment },
        selection: { anchor: from + typeSegment.length + 1 + verbatim.length },
        userEvent: "input.complete",
      });
    } else {
      const insert = `${typeSegment}[]()`;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + typeSegment.length + 1 }, userEvent: "input.complete" });
    }
  };
}

// Shadows this row's RSMLAnnotator._cmComplete (an instance property lookup
// inside the library's own closure - `self._cmComplete(ctx)`, where `self`
// is captured once per instance, not the shared prototype - so reassigning
// it here intercepts every completion this row's editor ever requests,
// cleanly, per row, without touching the library's class or any other row)
// to layer two things the library's public options can't reach:
//
// 1. Boosts the default code-mixing language to the very top of the `!`
//    popup, ahead of even rsml's own "! (unspecified language)" entry. Its
//    "!" completion source builds `{ label: "! (unspecified language)",
//    boost: 1 }` followed by every real language with no boost at all (0),
//    and CodeMirror's autocomplete ranks strictly by boost first
//    (score = matchScore + boost, sorted descending — see
//    @codemirror/autocomplete's sortOptions()), alphabetical only breaking
//    ties — confirmed by reading that package's source directly.
// 2. Appends this project's configured accents (state.accents, edited in
//    Settings -> RSML tags -> Accents) to the `$` popup, the same way
//    dialects/domains present theirs — rsml has no accents vocabulary of
//    its own at all (see rsmlSettings.js's header comment), so without this
//    the `$` popup would only ever offer "unspecified accent".
function patchCompletions(annotator) {
  if (!annotator || annotator.__completionsPatched || typeof annotator._cmComplete !== "function") return;
  annotator.__completionsPatched = true;
  const original = annotator._cmComplete.bind(annotator);
  annotator._cmComplete = (ctx) => {
    const result = original(ctx);
    if (!result || !Array.isArray(result.options)) return result;

    const code = getState().defaultCodeMixLanguage;
    if (code) {
      const i = result.options.findIndex((o) => o.label === `!${code}`);
      if (i > 0) {
        const [opt] = result.options.splice(i, 1);
        result.options.unshift({ ...opt, boost: 99 });
      }
    }

    if (triggerPrefix(ctx) === "$") {
      const accents = getState().accents || {};
      const extra = Object.keys(accents)
        .sort()
        .map((id) => ({ label: `$${id}`, detail: accents[id] || null, apply: bracketApply(`$${id}`) }));
      result.options = result.options.concat(extra);
    }

    return result;
  };
}

// Shadows _updateStatus the same way (see patchCompletions() above for why
// that's safe) so the error/warning status bar never fully disappears. The
// library's own _updateStatus() sets display:none and empties it outright
// whenever the current segment has zero errors/warnings — meaning on any
// segment without a mistake in it (i.e. most of the time), there is no
// status bar at all, which reads as "this feature doesn't exist" rather
// than "this segment is clean". Force it visible either way, showing a
// quiet confirmation instead of nothing.
function patchStatusAlwaysVisible(annotator) {
  if (!annotator || annotator.__statusPatched || typeof annotator._updateStatus !== "function") return;
  annotator.__statusPatched = true;
  const original = annotator._updateStatus.bind(annotator);
  annotator._updateStatus = () => {
    original();
    const el = annotator._statusEl;
    if (el && el.style.display === "none") {
      el.style.display = "";
      el.innerHTML = `<span class="rsml-status-ok">&check; 0 errors</span>`;
    }
  };
  // The constructor's own initial call (before this patch could exist yet)
  // ran unpatched, so repaint immediately rather than waiting for the first
  // edit to reveal a clean segment's bar.
  annotator._updateStatus();
}

function speakerOptionsHtml(selectedId) {
  const speakers = getState().speakers;
  // A native <select> with no option explicitly marked selected silently
  // shows the first option anyway — misleading here, since that would make
  // an unset segment *look* assigned to speaker 1 without seg.speaker
  // actually holding that value. An explicit placeholder keeps the two in
  // sync; it only ever appears while nothing real has been chosen yet.
  let html = selectedId == null ? `<option value="" selected disabled>Not set</option>` : "";
  html += speakers.map((sp) => `<option value="${sp.id}"${sp.id === selectedId ? " selected" : ""}>${escapeHtml(speakerLabel(sp))}</option>`).join("");
  if (selectedId != null && !speakers.some((sp) => sp.id === selectedId)) {
    html += `<option value="${selectedId}" selected disabled>Speaker ${selectedId} (removed)</option>`;
  }
  html += `<option value="__add__">+ Add new speaker</option>`;
  return html;
}

function speakerDeps() {
  return { getState, scheduleSave, toast, escapeHtml, onRosterChange: refreshSpeakerDropdowns };
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
    if (r) {
      r.els.idx.textContent = i + 1;
      // Nothing to merge into once this is the last segment - recomputed
      // here (rather than once at row-build time) since which segment is
      // last can change any time the list does.
      if (r.mergeBtn) r.mergeBtn.disabled = i === s.segments.length - 1;
    }
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
    speaker: defaultSpeakerId(s),
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

// Merges a segment into the one right after it in start-time order: the
// combined span keeps this segment's id/start and the next one's end, RSML
// text concatenated with a space, this segment's speaker (falling back to
// the next one's only if this one has none), and re-opens for review
// (verified resets) since the combined text is new. Removing the *next*
// segment (rather than this one) reuses removeSegment() as-is for the
// reindex/verify-count/waveform-regions/save bookkeeping it already does,
// leaving only this row's own display to refresh below.
function mergeWithNext(id) {
  const s = getState();
  const idx = s.segments.findIndex((x) => x.id === id);
  if (idx === -1 || idx >= s.segments.length - 1) return; // already last - nothing to merge into
  const cur = s.segments[idx];
  const next = s.segments[idx + 1];

  // Pull in any live-edited text neither has synced to state yet (same
  // reason sweep()/deactivate() call this before reading rec.seg.rsml).
  const curRec = rows.get(cur.id);
  const nextRec = rows.get(next.id);
  if (curRec) syncOne(curRec);
  if (nextRec) syncOne(nextRec);

  cur.end = next.end;
  cur.rsml = [cur.rsml, next.rsml].map((t) => (t || "").trim()).filter(Boolean).join(" ");
  if (cur.speaker == null) cur.speaker = next.speaker;
  cur.verified = false;

  removeSegment(next.id);

  if (curRec) {
    curRec.el.classList.remove("verified");
    curRec.els.check.checked = false;
    curRec.els.speaker.innerHTML = speakerOptionsHtml(cur.speaker);
    refreshRowTimes(cur);
    if (curRec.active) {
      // Tear down and remount to get CM6/the preview to pick up the new
      // merged text, without needing rsml's internal API surface -
      // deliberately NOT going through deactivate() here, since it calls
      // syncOne() first, which would read the *old*, still-unmerged text
      // straight out of the live CM6 doc and stomp the merge right back
      // out of cur.rsml before activate() below ever got to use it.
      try {
        curRec.annotator && curRec.annotator.destroy && curRec.annotator.destroy();
      } catch {}
      curRec.annotator = null;
      curRec.textarea = null;
      curRec.active = false;
      curRec.el.classList.remove("cm-live");
      activate(cur.id, { focus: false });
    } else {
      setCollapsed(curRec);
    }
  }
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

  wireFontSize();

  bind("export-srt-btn", () => {
    const s = getState();
    if (!s.segments.length) {
      toast("Nothing to export yet.", "info");
      return;
    }
    const name = (s.audioMeta && s.audioMeta.name) || "transcript";
    downloadSRT(name, buildSRT(s.segments, s.speakers));
  });
}

// A-/A+ in the toolbar scale every segment's transcription/preview text at
// once via the --rsml-font-size CSS custom property (see app.css) rather
// than touching each row - .rsml-host, .rsml-output and .rsml-plain all
// read that one variable, and CM6's own .cm-content picks it up through
// ordinary inheritance (rsml sets no font-size of its own on it).
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 20;
const FONT_SIZE_STEP = 1;
const FONT_SIZE_DEFAULT = 16;

function applyFontSize() {
  const size = getState().ui.fontSize || FONT_SIZE_DEFAULT;
  document.documentElement.style.setProperty("--rsml-font-size", `${size}px`);
  const dec = document.getElementById("font-size-dec");
  const inc = document.getElementById("font-size-inc");
  if (dec) dec.disabled = size <= FONT_SIZE_MIN;
  if (inc) inc.disabled = size >= FONT_SIZE_MAX;
}

function wireFontSize() {
  const step = (delta) => {
    const ui = getState().ui;
    ui.fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, (ui.fontSize || FONT_SIZE_DEFAULT) + delta));
    applyFontSize();
    scheduleSave();
  };
  bind("font-size-dec", () => step(-FONT_SIZE_STEP));
  bind("font-size-inc", () => step(FONT_SIZE_STEP));
  bind("font-size-reset", () => {
    getState().ui.fontSize = FONT_SIZE_DEFAULT;
    applyFontSize();
    scheduleSave();
  });
  applyFontSize();
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
