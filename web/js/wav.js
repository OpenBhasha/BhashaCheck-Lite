// Decode the working audio once, keep the AudioBuffer in memory, and cut a
// per-segment WAV Blob in the browser so the full recording is never
// re-uploaded for each segment. The server re-normalises to mono/16k anyway,
// so we encode at the buffer's native rate and just downmix to mono.

let _buffer = null;
let _decoding = null;

function audioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  return new AC();
}

export async function loadAudio(blob) {
  _buffer = null;
  const arrayBuf = await blob.arrayBuffer();
  const ctx = audioCtx();
  _decoding = new Promise((resolve, reject) => {
    // callback form for the widest browser support
    ctx.decodeAudioData(arrayBuf.slice(0), (buf) => resolve(buf), (err) => reject(err));
  });
  _buffer = await _decoding;
  try { ctx.close(); } catch {}
  return { duration: _buffer.duration, sampleRate: _buffer.sampleRate };
}

export function hasAudio() {
  return !!_buffer;
}

export function getDuration() {
  return _buffer ? _buffer.duration : 0;
}

function downmixMono(buffer, startSample, endSample) {
  const len = Math.max(0, endSample - startSample);
  const out = new Float32Array(len);
  const chans = buffer.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[startSample + i] / chans;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(off, s, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

export function sliceToWav(startSec, endSec) {
  if (!_buffer) throw new Error("No audio loaded");
  const sr = _buffer.sampleRate;
  const total = _buffer.length;
  const a = Math.max(0, Math.min(total, Math.floor(startSec * sr)));
  const b = Math.max(a, Math.min(total, Math.ceil(endSec * sr)));
  const mono = downmixMono(_buffer, a, b);
  return encodeWav(mono, sr);
}
