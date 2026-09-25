// Settings-drawer "Languages" (default native language) and "Speakers"
// (gender + native language roster, no name) panels, plus the one shared
// add-speaker modal reachable both from the roster list here and from any
// segment's own speaker dropdown in editor.js.
//
// Speakers have a stable, monotonically-increasing `id` (1, 2, 3, ...,
// never reused) - that id is what a segment's speaker dropdown stores and
// what an annotator types as the N in &sN-start/&sN-end, so removing or
// reordering a speaker must never renumber another one still referenced
// elsewhere. Removal just filters the array (leaves a gap); reordering
// changes list/display order only, never an id.
//
// Takes its app-shell hooks as a `deps` parameter rather than importing
// them from main.js/editor.js, keeping this a plain leaf module - see
// rsmlSettings.js's header comment for the general idea (this file has no
// edges back to either of them, so both main.js and editor.js import it
// statically with no cycle risk, unlike rsmlSettings.js's own dynamic
// bridge back into editor.js).
//
// A "default code-mixing language for !" setting was tried and removed:
// confirmed live (not just from reading the rsml source) that CodeMirror's
// autocomplete always sorts the `!` language list alphabetically regardless
// of the order languages are supplied in, so reordering opts.languages had
// no visible effect. The only lever that actually controls display order,
// completion `boost`, is hardcoded per-option inside rsml's own closed
// completion source, not exposed through RSMLAnnotator's public options -
// not achievable without patching the library.
import RSMLAnnotator from "https://cdn.jsdelivr.net/npm/rsml@3.2.0/rsml.esm.js";

const GENDERS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
  { value: "unspecified", label: "Unspecified" },
];

function genderLabel(value) {
  return (GENDERS.find((g) => g.value === value) || GENDERS[GENDERS.length - 1]).label;
}

export function speakerLabel(sp) {
  return `Speaker ${sp.id} (${genderLabel(sp.gender)}, ${sp.nativeLanguage || "?"})`;
}

// A hidden, page-lifetime RSMLAnnotator built purely to read the library's
// own built-in language defaults when a project has never touched Settings
// -> RSML tags (state.rsmlConfig.languages is still null). These never
// change project-to-project, so caching after the first build is safe -
// mirrors rsmlSettings.js's own getDefaultsAnnotator().
let defaultsAnnotator = null;
function getLibraryDefaultLanguages() {
  if (defaultsAnnotator) return defaultsAnnotator.opts.languages;
  const ta = document.createElement("textarea");
  const out = document.createElement("div");
  ta.hidden = true;
  out.hidden = true;
  document.body.append(ta, out);
  defaultsAnnotator = new RSMLAnnotator({ textarea: ta, output: out, disableCodeMirror: true });
  return defaultsAnnotator.opts.languages;
}

function getEffectiveLanguages(state) {
  return (state.rsmlConfig && state.rsmlConfig.languages) || getLibraryDefaultLanguages();
}

function languageOptions(languages, selected, escapeHtml) {
  let html = "";
  // Defensive: if the stored code has since been removed from the
  // vocabulary, still show it selected rather than silently blanking out.
  if (selected && !(selected in languages)) {
    html += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (removed)</option>`;
  }
  html += Object.keys(languages)
    .sort()
    .map(
      (code) =>
        `<option value="${escapeHtml(code)}"${code === selected ? " selected" : ""}>${escapeHtml(languages[code])} (${escapeHtml(code)})</option>`
    )
    .join("");
  return html;
}

// ------------------------------------------------------- language defaults ----

export function renderLanguageDefaults(root, deps) {
  const { getState, scheduleSave, escapeHtml } = deps;
  const state = getState();
  const languages = getEffectiveLanguages(state);
  root.innerHTML = `
    <div>
      <label class="form-label small mb-1" for="default-native-lang">Native language</label>
      <select id="default-native-lang" class="form-select form-select-sm">
        <option value="">Not set</option>
        ${languageOptions(languages, state.defaultNativeLanguage || "", escapeHtml)}
      </select>
    </div>`;
  root.querySelector("#default-native-lang").onchange = (e) => {
    getState().defaultNativeLanguage = e.target.value || null;
    scheduleSave();
  };
}

// -------------------------------------------------------------- speakers ----

function nextSpeakerId(state) {
  return state.speakers.reduce((max, s) => Math.max(max, s.id), 0) + 1;
}

// Re-renders just the roster list (not the whole panel — the "Add speaker"
// button is static markup, only the rows change) after any mutation.
function refreshRosterPanel(deps) {
  const root = document.getElementById("speaker-roster-panel");
  if (root) renderSpeakerSettings(root, deps);
}

export function renderSpeakerSettings(root, deps) {
  const { getState, escapeHtml } = deps;
  const state = getState();
  const rowsHtml = state.speakers
    .map((sp, i) => {
      const label = escapeHtml(speakerLabel(sp));
      return `
    <div class="spk-row" data-id="${sp.id}">
      <span class="spk-row-label">${label}</span>
      <span class="flex-spacer"></span>
      <button type="button" class="spk-move" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move ${label} up">&uarr;</button>
      <button type="button" class="spk-move" data-dir="1" ${i === state.speakers.length - 1 ? "disabled" : ""} aria-label="Move ${label} down">&darr;</button>
      <button type="button" class="spk-remove" aria-label="Remove ${label}">&times;</button>
    </div>`;
    })
    .join("");
  root.innerHTML = `
    <div class="spk-rows">${rowsHtml || '<p class="rsml-cat-empty muted small">No speakers yet.</p>'}</div>
    <button type="button" class="btn btn-sm btn-outline-secondary spk-add">Add speaker</button>`;

  root.querySelectorAll(".spk-remove").forEach((btn) => {
    btn.onclick = () => removeSpeaker(deps, parseInt(btn.closest(".spk-row").dataset.id, 10));
  });
  root.querySelectorAll(".spk-move").forEach((btn) => {
    btn.onclick = () =>
      moveSpeaker(deps, parseInt(btn.closest(".spk-row").dataset.id, 10), parseInt(btn.dataset.dir, 10));
  });
  root.querySelector(".spk-add").onclick = () => openSpeakerModal(deps, {});
}

export function removeSpeaker(deps, id) {
  const state = deps.getState();
  state.speakers = state.speakers.filter((s) => s.id !== id);
  deps.scheduleSave();
  refreshRosterPanel(deps);
  deps.onRosterChange && deps.onRosterChange();
}

export function moveSpeaker(deps, id, dir) {
  const state = deps.getState();
  const i = state.speakers.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.speakers.length) return;
  const [sp] = state.speakers.splice(i, 1);
  state.speakers.splice(j, 0, sp);
  deps.scheduleSave();
  refreshRosterPanel(deps);
  deps.onRosterChange && deps.onRosterChange();
}

// ---------------------------------------------------------------- modal ----

// Opened either from the Settings -> Speakers "Add speaker" button, or from
// any segment's own speaker dropdown ("+ Add new speaker") - in the latter
// case onSaved lets the caller (editor.js) assign the freshly-created
// speaker straight to that segment.
export function openSpeakerModal(deps, { onSaved } = {}) {
  const { getState, scheduleSave, escapeHtml } = deps;
  const state = getState();
  const backdrop = document.getElementById("speaker-modal-backdrop");
  const modal = document.getElementById("speaker-modal");
  if (!backdrop || !modal) return;
  const languages = getEffectiveLanguages(state);
  modal.querySelector(".speaker-modal-body").innerHTML = `
    <div class="mb-2">
      <label class="form-label small mb-1" for="speaker-modal-gender">Gender</label>
      <select id="speaker-modal-gender" class="form-select form-select-sm">
        ${GENDERS.map((g) => `<option value="${g.value}">${g.label}</option>`).join("")}
      </select>
    </div>
    <div>
      <label class="form-label small mb-1" for="speaker-modal-lang">Native language</label>
      <select id="speaker-modal-lang" class="form-select form-select-sm">
        <option value="">Not set</option>
        ${languageOptions(languages, state.defaultNativeLanguage || "", escapeHtml)}
      </select>
    </div>`;

  const close = () => {
    modal.hidden = true;
    backdrop.hidden = true;
  };
  backdrop.onclick = close;
  modal.querySelectorAll(".speaker-modal-cancel").forEach((btn) => (btn.onclick = close));
  modal.querySelector(".speaker-modal-save").onclick = () => {
    const gender = document.getElementById("speaker-modal-gender").value;
    const nativeLanguage = document.getElementById("speaker-modal-lang").value || null;
    const sp = { id: nextSpeakerId(state), gender, nativeLanguage };
    state.speakers.push(sp);
    scheduleSave();
    close();
    refreshRosterPanel(deps);
    deps.onRosterChange && deps.onRosterChange();
    onSaved && onSaved(sp);
  };

  modal.hidden = false;
  backdrop.hidden = false;
}

// Wired once at module load (idempotent regardless of how many times
// openSpeakerModal() itself runs) rather than inside openSpeakerModal,
// which would otherwise stack a new document-level listener on every open.
document.addEventListener("keydown", (e) => {
  const modal = document.getElementById("speaker-modal");
  if (e.key === "Escape" && modal && !modal.hidden) {
    modal.hidden = true;
    document.getElementById("speaker-modal-backdrop").hidden = true;
  }
});
