"""BhashaCheck v2 ML service - a thin, stateless FastAPI app.

Run from this directory so the flat imports (`from config import settings`)
resolve:

    cd v2/server
    uvicorn main:app --reload --port 8000

It also serves the single-page frontend (../web) at / so everything is one
origin. Set SERVE_WEB=false to disable that and host the page yourself.
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.routes import router
from config import settings

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)

app = FastAPI(title="BhashaCheck v2 ML service", version="2.0.0")

# Permissive CORS so the page also works when opened straight from disk
# (file://) or served from a different port during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Model-Used"],
)

app.include_router(router)

os.makedirs(settings.work_dir, exist_ok=True)

_WEB_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "web"))
if settings.serve_web and os.path.isdir(_WEB_DIR):
    # StaticFiles sends ETag/Last-Modified but no Cache-Control, so browsers
    # are free to apply heuristic caching (RFC 7234 4.2.2) and reuse a stale
    # response from disk cache with zero network round-trip — no 304, no
    # revalidation, nothing that shows up as "the file changed". That's
    # exactly wrong for a dev server whose whole premise is edit-and-reload.
    # `no-cache` (not `no-store`) keeps the ETag fast-path: still forces a
    # round-trip, but an unchanged file still gets a cheap 304.
    @app.middleware("http")
    async def _no_cache_static(request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    # Mounted last so /api/* routes above win.
    app.mount("/", StaticFiles(directory=_WEB_DIR, html=True), name="web")
    logging.getLogger(__name__).info("Serving frontend from %s", _WEB_DIR)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
