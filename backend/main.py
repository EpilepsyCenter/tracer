"""TRACER Python Backend — FastAPI server for electrophysiology analysis."""

import argparse
import os
import sys
from contextlib import asynccontextmanager


def _keep_matplotlib_cache() -> None:
    """Packaged backend only: give matplotlib a cache folder that persists.

    PyInstaller's matplotlib runtime hook sets MPLCONFIGDIR to a temporary
    folder that is deleted on exit, so matplotlib (imported at start-up by the
    cohort / export routers and pingouin) rebuilt its font cache on every
    launch: ~9 s before the backend answered, against ~1 s in development.
    The hook has already run, so overwrite its value (setdefault would not).
    """
    if not getattr(sys, "frozen", False):
        return
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        cache = os.path.join(home, "Library", "Caches", "TRACER")
    elif sys.platform.startswith("win"):
        cache = os.path.join(os.environ.get("LOCALAPPDATA", home), "TRACER", "cache")
    else:
        cache = os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.join(home, ".cache")),
                             "tracer")
    try:
        folder = os.path.join(cache, "matplotlib")
        os.makedirs(folder, exist_ok=True)
        os.environ["MPLCONFIGDIR"] = folder
    except OSError:
        pass  # fall back to the hook's temporary folder


_keep_matplotlib_cache()

import uvicorn  # noqa: E402  (after the cache folder is set)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.files import router as files_router
from api.traces import router as traces_router
from api.analysis import router as analysis_router
from api.macros import router as macros_router
from api.results import router as results_router
from api.iv import router as iv_router
from api.fpsp import router as fpsp_router
from api.cursors import router as cursors_router
from api.bursts import router as bursts_router
from api.ap import router as ap_router
from api.events import router as events_router
from api.paired import router as paired_router
from api.cohort import router as cohort_router
from api.trace_export import router as trace_export_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown."""
    print("TRACER backend starting...")
    yield
    print("TRACER backend shutting down...")


app = FastAPI(title="TRACER Backend", version="0.4.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files_router, prefix="/api/files", tags=["files"])
app.include_router(traces_router, prefix="/api/traces", tags=["traces"])
app.include_router(analysis_router, prefix="/api/analysis", tags=["analysis"])
app.include_router(macros_router, prefix="/api/macros", tags=["macros"])
app.include_router(results_router, prefix="/api/results", tags=["results"])
app.include_router(iv_router, prefix="/api/iv", tags=["iv"])
app.include_router(fpsp_router, prefix="/api/fpsp", tags=["fpsp"])
app.include_router(cursors_router, prefix="/api/cursors", tags=["cursors"])
app.include_router(bursts_router, prefix="/api/bursts", tags=["bursts"])
app.include_router(ap_router, prefix="/api/ap", tags=["ap"])
app.include_router(events_router, prefix="/api/events", tags=["events"])
app.include_router(paired_router, prefix="/api/paired", tags=["paired"])
app.include_router(cohort_router, prefix="/api/cohort", tags=["cohort"])
app.include_router(trace_export_router, prefix="/api/trace_export", tags=["trace_export"])


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.4.0"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Auto-reload the backend on Python file changes — useful "
             "during dev so edits to api/* and analysis/* take effect "
             "without manually restarting the server.",
    )
    args = parser.parse_args()

    if args.reload:
        # Reload mode requires the import-string form so uvicorn can
        # re-import the module on file change. The direct ``app``
        # reference path doesn't support reload.
        uvicorn.run(
            "main:app",
            host=args.host, port=args.port, log_level="info",
            reload=True,
            reload_dirs=["."],
        )
    else:
        uvicorn.run(app, host=args.host, port=args.port, log_level="info")
