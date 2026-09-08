// SRT import/export. The transcript body is the raw RSML markup, exported as-is.

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
    const content = lines.slice(i + 1).join("\n").trim();
    out.push({ start, end, text: content });
  }
  return out;
}

export function buildSRT(segments) {
  const rows = [...segments].sort((a, b) => a.start - b.start);
  const lines = [];
  rows.forEach((seg, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${secondsToSrt(seg.start)} --> ${secondsToSrt(seg.end)}`);
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
