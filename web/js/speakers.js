// Settings-drawer "Languages" (default code-mixing language) and "Speakers"
// (gender + native language roster, no name) panels, plus the one shared
// add/edit-speaker modal reachable both from the roster list here and from
// any segment's own speaker dropdown in editor.js.
//
// Speakers have a stable, monotonically-increasing `id` (1, 2, 3, ...,
// never reused) - that id is what a segment's speaker dropdown stores and
// what an annotator types as the N in &sN-start/&sN-end, so removing a
// speaker must never renumber another one still referenced elsewhere.
// Removal just filters the array (leaves a gap). No reorder UI - add, edit,
// or delete only.
//
// Takes its app-shell hooks as a `deps` parameter rather than importing
// them from main.js/editor.js, keeping this a plain leaf module - see
// rsmlSettings.js's header comment for the general idea (this file has no
// edges back to either of them, so both main.js and editor.js import it
// statically with no cycle risk, unlike rsmlSettings.js's own dynamic
// bridge back into editor.js).
//
// A "default code-mixing language reorders the ! popup" behavior was tried
// and abandoned: confirmed live (not just from reading the rsml source)
// that CodeMirror's autocomplete always sorts the `!` language list
// alphabetically regardless of the order languages are supplied in, and the
// only lever that actually controls display order, completion `boost`, is
// hardcoded per-option inside rsml's own closed completion source, not
// exposed through RSMLAnnotator's public options. The default here instead
// drives a quick-insert button per segment (editor.js's
// insertCodeMixTag/refreshCodeMixButtons) that inserts the tag directly at
// the cursor - a mechanism fully within our own control (CM6's public
// transaction API), not the library's popup at all.
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

// select2 (+ jQuery) is loaded via plain <script> tags in index.html, ahead
// of this module, so both are already on window by the time any of this
// runs. Re-applying after a rebuild is required, not optional - select2
// renders its own widget once on init and does not notice a plain
// innerHTML swap on the underlying <select> on its own; every place here
// that rebuilds a select's options calls this again right after.
export function applySelect2(el) {
  const $ = window.jQuery;
  if (!el || !$ || !$.fn || !$.fn.select2) return;
  const $el = $(el);
  if ($el.data("select2")) $el.select2("destroy");
  // dropdownAutoWidth: true - the box itself stays sized to its CSS width
  // (e.g. .seg-speaker's compact 160px), but the popup sizes to its longest
  // option so a row like "+ Add new speaker" doesn't wrap into 3 lines.
  $el.select2({ theme: "bootstrap-5", width: "style", dropdownAutoWidth: true });
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

// ------------------------------------------------------- code-mix default ----

export function renderCodeMixDefault(root, deps) {
  const { getState, scheduleSave, escapeHtml } = deps;
  const state = getState();
  const languages = getEffectiveLanguages(state);
  root.innerHTML = `
    <div>
      <label class="form-label small mb-1" for="default-codemix-lang">Default code-mixing language</label>
      <select id="default-codemix-lang" class="form-select form-select-sm">
        <option value="">None</option>
        ${languageOptions(languages, state.defaultCodeMixLanguage || "", escapeHtml)}
      </select>
    </div>`;
  const sel = root.querySelector("#default-codemix-lang");
  applySelect2(sel);
  sel.onchange = () => {
    getState().defaultCodeMixLanguage = sel.value || null;
    scheduleSave();
    deps.onDefaultCodeMixChange && deps.onDefaultCodeMixChange();
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
    .map((sp) => {
      const label = escapeHtml(speakerLabel(sp));
      const isDefault = state.defaultSpeaker === sp.id;
      return `
    <div class="spk-row" data-id="${sp.id}">
      <button type="button" class="spk-default-btn${isDefault ? " is-default" : ""}" title="${isDefault ? "Default speaker" : "Set as default for all segments"}">
        <i class="bi ${isDefault ? "bi-star-fill" : "bi-star"}"></i>
      </button>
      <span class="spk-row-label">${label}</span>
      <span class="flex-spacer"></span>
      <button type="button" class="spk-edit" aria-label="Edit ${label}">Edit</button>
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
  root.querySelectorAll(".spk-edit").forEach((btn) => {
    btn.onclick = () => {
      const id = parseInt(btn.closest(".spk-row").dataset.id, 10);
      const sp = getState().speakers.find((s) => s.id === id);
      if (sp) openSpeakerModal(deps, { editSpeaker: sp });
    };
  });
  root.querySelectorAll(".spk-default-btn").forEach((btn) => {
    btn.onclick = () => setDefaultSpeaker(deps, parseInt(btn.closest(".spk-row").dataset.id, 10));
  });
  root.querySelector(".spk-add").onclick = () => openSpeakerModal(deps, {});
}

export function removeSpeaker(deps, id) {
  const state = deps.getState();
  state.speakers = state.speakers.filter((s) => s.id !== id);
  if (state.defaultSpeaker === id) state.defaultSpeaker = null;
  deps.scheduleSave();
  refreshRosterPanel(deps);
  deps.onRosterChange && deps.onRosterChange();
}

// Sets `id` as the project's default speaker AND (after confirming, since
// this overwrites existing per-segment choices) assigns it to every
// segment right now - "default" here means the one true speaker for this
// project, not just a seed for new segments.
export function setDefaultSpeaker(deps, id) {
  const state = deps.getState();
  const sp = state.speakers.find((s) => s.id === id);
  if (!sp) return;
  const n = state.segments.length;
  const msg = n
    ? `Set ${speakerLabel(sp)} as the default speaker? This assigns them to all ${n} segment${n === 1 ? "" : "s"}, replacing any individual choices already made.`
    : `Set ${speakerLabel(sp)} as the default speaker?`;
  if (!confirm(msg)) return;
  state.defaultSpeaker = id;
  for (const seg of state.segments) seg.speaker = id;
  deps.scheduleSave();
  refreshRosterPanel(deps);
  deps.onRosterChange && deps.onRosterChange();
}

// ---------------------------------------------------------------- modal ----

// Opened from the Settings -> Speakers "Add speaker" button, from any
// segment's own speaker dropdown ("+ Add new speaker"), or from a roster
// row's "Edit" button (editSpeaker set - pre-fills and updates in place
// rather than creating a new entry). onSaved lets a segment-dropdown caller
// (editor.js) assign the freshly-created speaker straight to that segment.
export function openSpeakerModal(deps, { onSaved, editSpeaker } = {}) {
  const { getState, scheduleSave, escapeHtml } = deps;
  const state = getState();
  const backdrop = document.getElementById("speaker-modal-backdrop");
  const modal = document.getElementById("speaker-modal");
  if (!backdrop || !modal) return;
  const languages = getEffectiveLanguages(state);
  const currentGender = editSpeaker ? editSpeaker.gender : GENDERS[0].value;
  const currentLang = editSpeaker ? editSpeaker.nativeLanguage || "" : "";

  modal.querySelector(".speaker-modal-title").textContent = editSpeaker ? `Edit ${speakerLabel(editSpeaker)}` : "Add speaker";
  modal.querySelector(".speaker-modal-save").textContent = editSpeaker ? "Save" : "Add speaker";
  modal.querySelector(".speaker-modal-body").innerHTML = `
    <div class="mb-2">
      <label class="form-label small mb-1" for="speaker-modal-gender">Gender</label>
      <select id="speaker-modal-gender" class="form-select form-select-sm">
        ${GENDERS.map((g) => `<option value="${g.value}"${g.value === currentGender ? " selected" : ""}>${g.label}</option>`).join("")}
      </select>
    </div>
    <div>
      <label class="form-label small mb-1" for="speaker-modal-lang">Native language</label>
      <select id="speaker-modal-lang" class="form-select form-select-sm">
        <option value="">Not set</option>
        ${languageOptions(languages, currentLang, escapeHtml)}
      </select>
    </div>`;
  applySelect2(document.getElementById("speaker-modal-gender"));
  applySelect2(document.getElementById("speaker-modal-lang"));

  const close = () => {
    modal.hidden = true;
    backdrop.hidden = true;
  };
  backdrop.onclick = close;
  modal.querySelectorAll(".speaker-modal-cancel").forEach((btn) => (btn.onclick = close));
  modal.querySelector(".speaker-modal-save").onclick = () => {
    const gender = document.getElementById("speaker-modal-gender").value;
    const nativeLanguage = document.getElementById("speaker-modal-lang").value || null;
    let sp;
    if (editSpeaker) {
      editSpeaker.gender = gender;
      editSpeaker.nativeLanguage = nativeLanguage;
      sp = editSpeaker;
    } else {
      sp = { id: nextSpeakerId(state), gender, nativeLanguage };
      state.speakers.push(sp);
    }
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
