// SRT import/export. The transcript body is the raw RSML markup, exported as-is.
//
// Line 3 of every cue is a machine-readable metadata line (every speaker the
// segment involves, verified, flagged, note) so the format round-trips
// losslessly through export -> import, while staying backward-compatible
// with plain third-party SRT (or SRT exported by this app before this
// metadata line existed) that has no such line - see META_LINE_RE below.
//
// "Every speaker the segment involves" is more than just seg.speaker: an
// annotator can also hand-type &sN-start/&sN-end inside the RSML text
// itself for a minority/interjecting speaker (N is the same stable
// speakers[].id as everywhere else in this app - see speakers.js's header
// comment). Those ids live only inside the free-form rsml text, so without
// scanning for them an SRT export would silently drop that speaker's
// gender/language entirely, and - worse - a re-import would invent a FRESH
// id for seg.speaker (matched by gender+language) while the &sN tokens
// already baked into the imported text keep pointing at the old id,
// silently breaking the reference. Encoding every referenced id explicitly
// (not just seg.speaker) and reusing those exact ids on import (not a
// gender/language match) fixes both problems at once - see
// referencedSpeakerIds() and main.js's importSrt().

function pad(n, w = 2) {
  return String(Math.floor(n)).padStart(w, "0");
}

export function secondsToSrt(sec) {
  sec = Math.max(0, sec);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function srtToSeconds(str) {
  const m = str.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, "0").slice(0, 3), 10) / 1000
  );
}

// Line 3 format: fixed key order, pipe-delimited, `note=` last and
// unsplit (takes the rest of the line) so free-text notes never need to
// escape `|` - only a literal backslash and embedded newline are escaped,
// via escapeNote()/unescapeNote() below. `speakers=` is a comma-separated
// list of every referenced speaker as `id:gender:lang` (lang empty when
// not set); `primary=` says which one (if any) is this segment's own
// seg.speaker, empty when none.
//   primary=<id-or-empty>|speakers=<id:gender:lang,...>|verified=<0|1>|flagged=<0|1>|note=<escaped text>
const META_LINE_RE = /^primary=[^|]*\|speakers=[^|]*\|verified=[01]\|flagged=[01]\|note=/;
const META_LINE_MATCH_RE = /^primary=([^|]*)\|speakers=([^|]*)\|verified=([01])\|flagged=([01])\|note=(.*)$/s;

function escapeNote(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unescapeNote(s) {
  return s.replace(/\\\\|\\n/g, (m) => (m === "\\n" ? "\n" : "\\"));
}

// Every &sN-start/&sN-end id a segment's RSML text references, in the
// order first seen (a Set preserves insertion order; dedup matters since
// a speaker's turn is wrapped by two tokens sharing the same N).
function referencedSpeakerIds(rsml) {
  const ids = new Set();
  const re = /&s(\d+)-(?:start|end)/g;
  let m;
  while ((m = re.exec(rsml || ""))) ids.add(parseInt(m[1], 10));
  return ids;
}

function decodeMetaLine(line) {
  const m = line.match(META_LINE_MATCH_RE);
  if (!m) return null;
  const [, primaryRaw, speakersRaw, verified, flagged, rawNote] = m;
  const speakers = speakersRaw
    ? speakersRaw.split(",").map((entry) => {
        const [idRaw, gender, lang] = entry.split(":");
        return { id: parseInt(idRaw, 10), gender: gender || "unspecified", nativeLanguage: lang || null };
      })
    : [];
  return {
    primary: primaryRaw ? parseInt(primaryRaw, 10) : null,
    speakers,
    verified: verified === "1",
    flagged: flagged === "1",
    note: unescapeNote(rawNote),
  };
}

export function parseSRT(text) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1; // optional index line
    const timeLine = lines[i] || "";
    if (!timeLine.includes("-->")) continue;
    const [rawStart, rawEnd] = timeLine.split("-->");
    const start = srtToSeconds(rawStart);
    const end = srtToSeconds(rawEnd);
    let bodyStart = i + 1;
    let meta = null;
    const metaLine = lines[bodyStart];
    if (metaLine && META_LINE_RE.test(metaLine)) {
      meta = decodeMetaLine(metaLine);
      bodyStart += 1;
    }
    const content = lines.slice(bodyStart).join("\n").trim();
    out.push({ start, end, text: content, meta });
  }
  return out;
}

function speakerEntry(id, speakers) {
  const sp = (speakers || []).find((s) => s.id === id);
  return `${id}:${sp ? sp.gender || "" : ""}:${sp ? sp.nativeLanguage || "" : ""}`;
}

function metaLine(seg, speakers) {
  const ids = [];
  if (seg.speaker != null) ids.push(seg.speaker);
  for (const id of referencedSpeakerIds(seg.rsml)) {
    if (!ids.includes(id)) ids.push(id);
  }
  const speakersField = ids.map((id) => speakerEntry(id, speakers)).join(",");
  const primaryField = seg.speaker != null ? String(seg.speaker) : "";
  return `primary=${primaryField}|speakers=${speakersField}|verified=${seg.verified ? "1" : "0"}|flagged=${seg.flagged ? "1" : "0"}|note=${escapeNote(seg.note)}`;
}

export function buildSRT(segments, speakers) {
  const rows = [...segments].sort((a, b) => a.start - b.start);
  const lines = [];
  rows.forEach((seg, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${secondsToSrt(seg.start)} --> ${secondsToSrt(seg.end)}`);
    lines.push(metaLine(seg, speakers));
    lines.push((seg.rsml || "").trim());
    lines.push("");
  });
  return lines.join("\n").trim() + "\n";
}

export function downloadSRT(filename, srtText) {
  const blob = new Blob([srtText], { type: "application/x-subrip;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/\.[^.]+$/, "") + ".srt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
