// JSON project export/import - the full-fidelity round-trip format (unlike
// SRT, which is lossy on speaker identity: JSON preserves the actual
// speakers[].id on every segment instead of re-matching by gender+language).
//
// Pure functions, no state import - mirrors srt.js's shape so this stays a
// plain leaf module. Segment/speaker normalization on import (defaults for
// missing fields, id fallback) happens in main.js's importJson(), not here.

export function buildProjectExport(state) {
  return {
    formatVersion: 1,
    exportedAt: Date.now(),
    audioMeta: state.audioMeta,
    segments: state.segments,
    speakers: state.speakers,
    defaultCodeMixLanguage: state.defaultCodeMixLanguage,
    accents: state.accents,
    rsmlConfig: state.rsmlConfig,
  };
}

export function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/\.[^.]+$/, "") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseProjectImport(text) {
  const data = JSON.parse(text); // throws on malformed JSON - caller catches
  if (!data || typeof data !== "object" || !Array.isArray(data.segments)) {
    throw new Error("not a recognized project export");
  }
  return data;
}
