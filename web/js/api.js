// Fetch wrappers for the v2 ML service.
//
// The page is normally served BY the FastAPI app, so same-origin ('' base).
// If it's opened straight from disk (file://) we fall back to localhost:8000.

const BASE =
  location.protocol === "file:" ? "http://localhost:8000" : location.origin;

export function apiBase() {
  return BASE;
}

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ApiError";
    this.code = code || "error"; // 'not_configured' | 'error'
  }
}
export { ApiError };

// The service returns handled problems as HTTP 200 + {code, message}. Turn
// those into ApiError so callers have one thing to catch.
function checkPayload(data) {
  if (data && typeof data === "object" && (data.code === "not_configured" || data.code === "error")) {
    throw new ApiError(data.message || "Request failed", data.code);
  }
  return data;
}

async function postForm(path, formData, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(BASE + path, { method: "POST", body: formData, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new ApiError("The request timed out.", "error");
    throw new ApiError(`Could not reach the ML service at ${BASE}. Is it running?`, "error");
  }
  clearTimeout(timer);

  const ctype = resp.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const data = await resp.json();
    if (!resp.ok) throw new ApiError(data.message || `HTTP ${resp.status}`, data.code || "error");
    return checkPayload(data);
  }
  if (!resp.ok) throw new ApiError(`HTTP ${resp.status}`, "error");
  return resp; // caller wants the raw response (e.g. audio bytes)
}

export async function health() {
  const resp = await fetch(BASE + "/api/health");
  if (!resp.ok) throw new ApiError(`HTTP ${resp.status}`, "error");
  return resp.json();
}

export async function getModels() {
  const resp = await fetch(BASE + "/api/models");
  if (!resp.ok) throw new ApiError(`HTTP ${resp.status}`, "error");
  return resp.json();
}

export async function musicRemoval(blob) {
  const fd = new FormData();
  fd.append("file", blob, "audio.wav");
  const resp = await postForm("/api/music-removal", fd);
  const buf = await resp.blob();
  return new Blob([buf], { type: "audio/wav" });
}

export async function vad(blob) {
  const fd = new FormData();
  fd.append("file", blob, "audio.wav");
  return postForm("/api/vad", fd);
}

export async function diarize(blob) {
  const fd = new FormData();
  fd.append("file", blob, "audio.wav");
  return postForm("/api/diarize", fd);
}

export async function transcribe(blob, { language = "", model = "whisper", apiKey = "" } = {}) {
  const fd = new FormData();
  fd.append("file", blob, "segment.wav");
  fd.append("language", language || "");
  fd.append("model", model || "whisper");
  fd.append("api_key", apiKey || "");
  return postForm("/api/transcribe", fd, { timeoutMs: 5 * 60 * 1000 });
}
