// Renders the "RSML tags" section of the settings drawer: per-category
// editors for every tag vocabulary the `rsml` library accepts as config
// (hesitations, paralinguistics, disfluency/prosody spans, entity types,
// languages). Edits write straight into state.rsmlConfig, save, and push
// live to any already-open segment editors.
//
// Deliberately takes its app-shell hooks (getState/scheduleSave/toast/
// escapeHtml/refreshRsmlAnnotators) as a `deps` parameter rather than
// importing them from main.js/editor.js. Not required for correctness (a
// module-linking failure chased down during development turned out to be
// the dev server serving a stale cached main.js, not an actual import
// cycle problem — see main.py's Cache-Control fix) but keeping this module
// a plain leaf with no imports of its own besides rsmlDefaults.js is good
// practice regardless: it stays trivially testable/reusable without caring
// what main.js or editor.js are.
import { RSML_DEFAULTS, RSML_TAG_CATEGORIES, freshRsmlConfig } from "./rsmlDefaults.js";

// Matches the library's own tokenizer: @-tag / span-base names are
// `[\w-]+`; entity/language codes must additionally start with a letter
// (`[A-Za-z][\w-]*`) since they sit in the `!code[` / `#TYPE[` prefix slot.
function sanitizeTagName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeCode(raw, keyCase) {
  let s = String(raw || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "");
  while (s && !/[A-Za-z]/.test(s[0])) s = s.slice(1); // must start with a letter
  return keyCase === "lower" ? s.toLowerCase() : s.toUpperCase();
}

export function renderRsmlSettings(root, deps) {
  if (!root) return;
  const { getState } = deps;
  root.innerHTML = "";
  const state = getState();
  if (!state.rsmlConfig) state.rsmlConfig = freshRsmlConfig();
  const cfg = state.rsmlConfig;
  for (const cat of RSML_TAG_CATEGORIES) {
    root.appendChild(cat.kind === "map" ? buildMapCategory(cat, cfg, deps) : buildListCategory(cat, cfg, deps));
  }
}

function commit(deps) {
  deps.scheduleSave();
  deps.refreshRsmlAnnotators();
}

function buildCategoryShell(cat, countFn) {
  const det = document.createElement("details");
  det.className = "rsml-cat";
  const summary = document.createElement("summary");
  const countEl = document.createElement("span");
  countEl.className = "rsml-cat-count";
  summary.append(cat.label + " ", countEl);
  det.appendChild(summary);

  const hint = document.createElement("p");
  hint.className = "rsml-cat-hint muted small";
  hint.textContent = cat.hint;
  det.appendChild(hint);

  const updateCount = () => {
    countEl.textContent = countFn();
  };
  return { det, updateCount };
}

function buildListCategory(cat, cfg, deps) {
  const { escapeHtml, toast } = deps;
  const { det, updateCount } = buildCategoryShell(cat, () => cfg[cat.key].length);

  const chipWrap = document.createElement("div");
  chipWrap.className = "rsml-chips";
  det.appendChild(chipWrap);

  const renderChips = () => {
    chipWrap.innerHTML = "";
    for (const word of cfg[cat.key]) {
      const chip = document.createElement("span");
      chip.className = "rsml-chip";
      chip.innerHTML = `${escapeHtml(word)} <button type="button" aria-label="Remove ${escapeHtml(word)}">&times;</button>`;
      chip.querySelector("button").onclick = () => {
        cfg[cat.key] = cfg[cat.key].filter((w) => w !== word);
        renderChips();
        updateCount();
        commit(deps);
      };
      chipWrap.appendChild(chip);
    }
    if (!cfg[cat.key].length) {
      const empty = document.createElement("span");
      empty.className = "rsml-cat-empty muted small";
      empty.textContent = "None — every @tag of this kind will show as unrecognized.";
      chipWrap.appendChild(empty);
    }
  };

  const addRow = document.createElement("div");
  addRow.className = "rsml-add-row";
  addRow.innerHTML =
    `<input type="text" placeholder="add tag name" class="form-control form-control-sm" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary">Add</button>`;
  const input = addRow.querySelector("input");
  const doAdd = () => {
    const name = sanitizeTagName(input.value);
    if (!name) {
      if (input.value.trim()) toast("Tag names can only use letters, numbers and hyphens.", "error");
      return;
    }
    if (cfg[cat.key].includes(name)) {
      input.value = "";
      return;
    }
    cfg[cat.key] = [...cfg[cat.key], name];
    input.value = "";
    renderChips();
    updateCount();
    commit(deps);
  };
  addRow.querySelector("button").onclick = doAdd;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doAdd();
    }
  });
  det.appendChild(addRow);

  det.appendChild(
    resetButton(() => {
      cfg[cat.key] = RSML_DEFAULTS[cat.key].slice();
      renderChips();
      updateCount();
      commit(deps);
    })
  );

  renderChips();
  updateCount();
  return det;
}

function buildMapCategory(cat, cfg, deps) {
  const { escapeHtml, toast } = deps;
  const { det, updateCount } = buildCategoryShell(cat, () => Object.keys(cfg[cat.key]).length);

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "rsml-map-rows";
  det.appendChild(rowsWrap);

  const renderRows = () => {
    rowsWrap.innerHTML = "";
    const codes = Object.keys(cfg[cat.key]).sort();
    for (const code of codes) {
      const row = document.createElement("div");
      row.className = "rsml-map-row";
      row.innerHTML =
        `<code class="rsml-map-code">${escapeHtml(code)}</code>` +
        `<span class="rsml-map-label">${escapeHtml(cfg[cat.key][code])}</span>` +
        `<button type="button" aria-label="Remove ${escapeHtml(code)}">&times;</button>`;
      row.querySelector("button").onclick = () => {
        delete cfg[cat.key][code];
        renderRows();
        updateCount();
        commit(deps);
      };
      rowsWrap.appendChild(row);
    }
    if (!codes.length) {
      const empty = document.createElement("p");
      empty.className = "rsml-cat-empty muted small";
      empty.textContent = "None configured.";
      rowsWrap.appendChild(empty);
    }
  };

  const addRow = document.createElement("div");
  addRow.className = "rsml-add-row rsml-add-row-map";
  addRow.innerHTML =
    `<input type="text" placeholder="code" class="form-control form-control-sm rsml-add-code" />` +
    `<input type="text" placeholder="label" class="form-control form-control-sm rsml-add-label" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary">Add</button>`;
  const codeInput = addRow.querySelector(".rsml-add-code");
  const labelInput = addRow.querySelector(".rsml-add-label");
  const doAdd = () => {
    const code = sanitizeCode(codeInput.value, cat.keyCase);
    const label = labelInput.value.trim();
    if (!code || !label) {
      if (codeInput.value.trim() || labelInput.value.trim()) {
        toast("Codes must start with a letter; both code and label are required.", "error");
      }
      return;
    }
    cfg[cat.key][code] = label;
    codeInput.value = "";
    labelInput.value = "";
    renderRows();
    updateCount();
    commit(deps);
  };
  addRow.querySelector("button").onclick = doAdd;
  for (const el of [codeInput, labelInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doAdd();
      }
    });
  }
  det.appendChild(addRow);

  det.appendChild(
    resetButton(() => {
      cfg[cat.key] = Object.assign({}, RSML_DEFAULTS[cat.key]);
      renderRows();
      updateCount();
      commit(deps);
    })
  );

  renderRows();
  updateCount();
  return det;
}

function resetButton(onReset) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-sm btn-link rsml-reset";
  btn.textContent = "Reset to defaults";
  btn.onclick = onReset;
  return btn;
}
