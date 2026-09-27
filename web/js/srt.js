// SRT import/export. The transcript body is the raw RSML markup, exported as-is.
//
// Line 3 of every cue is a machine-readable metadata line (speaker
// gender/language, verified, flagged, note) so the format round-trips
// losslessly through export -> import, while staying backward-compatible
// with plain third-party SRT (or SRT exported by this app before this
// metadata line existed) that has no such line - see META_LINE_RE below.

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
// via escapeNote()/unescapeNote() below.
//   gender=<enum-or-empty>|lang=<code-or-empty>|verified=<0|1>|flagged=<0|1>|note=<escaped text>
// An empty gender+lang (no speaker assigned) is distinct from a real
// speaker with gender=unspecified - matters so import never invents a
// speaker for a segment that never had one (see main.js's importSrt()).
const META_LINE_RE = /^gender=[^|]*\|lang=[^|]*\|verified=[01]\|flagged=[01]\|note=/;
const META_LINE_MATCH_RE = /^gender=([^|]*)\|lang=([^|]*)\|verified=([01])\|flagged=([01])\|note=(.*)$/s;

function escapeNote(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unescapeNote(s) {
  return s.replace(/\\\\|\\n/g, (m) => (m === "\\n" ? "\n" : "\\"));
}

function decodeMetaLine(line) {
  const m = line.match(META_LINE_MATCH_RE);
  if (!m) return null;
  const [, gender, lang, verified, flagged, rawNote] = m;
  return {
    gender: gender || null,
    lang: lang || null,
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

function metaLine(seg, speakers) {
  const sp = seg.speaker != null ? (speakers || []).find((s) => s.id === seg.speaker) : null;
  const gender = sp ? sp.gender || "" : "";
  const lang = sp ? sp.nativeLanguage || "" : "";
  return `gender=${gender}|lang=${lang}|verified=${seg.verified ? "1" : "0"}|flagged=${seg.flagged ? "1" : "0"}|note=${escapeNote(seg.note)}`;
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
