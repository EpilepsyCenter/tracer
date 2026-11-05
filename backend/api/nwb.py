"""NWB export of the open recording, and the NWB Inspector.

- ``GET  /api/nwb/plan``    — series with their guessed type, channels,
  sweep counts and the recording start, for the export dialog.
- ``POST /api/nwb/export``  — write the file, then inspect it.
- ``POST /api/nwb/inspect`` — inspect any NWB file.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.files import get_current_recording

router = APIRouter()


@router.get("/plan")
async def nwb_plan():
    from export.nwb_export import plan
    return plan(get_current_recording())


class ExportRequest(BaseModel):
    path: str
    meta: dict[str, Any] = {}
    # "group:series" → vc / cc / field / skip
    kinds: dict[str, str] = {}
    # "group:series" → excluded sweep indices (left out when given)
    excluded: Optional[dict[str, list[int]]] = None
    inspect: bool = True


@router.post("/export")
async def nwb_export(req: ExportRequest):
    from api import files
    from export.nwb_export import write_nwb, inspect

    rec = get_current_recording()
    if not req.path.lower().endswith(".nwb"):
        raise HTTPException(status_code=400, detail="The file name must end in .nwb")
    if os.path.abspath(req.path) == os.path.abspath(rec.file_path):
        raise HTTPException(status_code=400, detail="Choose a different file from the open recording")
    try:
        res = write_nwb(rec, req.path, req.meta, req.kinds, req.excluded, pgf=files._pgf_data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not write the NWB file: {e}")
    messages: list[dict] = []
    inspect_error = None
    if req.inspect:
        try:
            messages = inspect(req.path)
        except Exception as e:
            inspect_error = f"The NWB Inspector could not run: {e}"
    return {
        "path": res.path,
        "sizeBytes": os.path.getsize(res.path),
        "seriesWritten": res.series_written,
        "sweepsWritten": res.sweeps_written,
        "notes": res.notes,
        "messages": messages,
        "inspectError": inspect_error,
    }


class InspectRequest(BaseModel):
    path: str


@router.post("/inspect")
async def nwb_inspect(req: InspectRequest):
    from export.nwb_export import inspect
    if not os.path.exists(req.path):
        raise HTTPException(status_code=404, detail="File not found")
    try:
        return {"messages": inspect(req.path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"The NWB Inspector could not run: {e}")


# ---------------------------------------------------------------------------
# Folder export: the dialog scans once, then exports file by file (so it
# can show progress and stop between files). Plain ``def`` routes run in
# FastAPI's thread pool, so a long export doesn't hold up the viewer.
# ---------------------------------------------------------------------------

def _read_recording(path: str):
    """Read a recording without touching the open one; (recording, pgf)."""
    from api.files import READERS
    from readers.heka_native.reader import HekaNativeReader

    for reader in READERS:
        if reader.can_read(path):
            rec = reader.read(path)
            pgf = getattr(reader, "_last_pgf", None) if isinstance(reader, HekaNativeReader) else None
            return rec, pgf
    raise ValueError(f"Unsupported file format: {os.path.basename(path)}")


class ScanRequest(BaseModel):
    folder: str
    recursive: bool = True
    outDir: Optional[str] = None


@router.post("/scan_folder")
def nwb_scan_folder(req: ScanRequest):
    from export.nwb_export import scan_folder
    if not os.path.isdir(req.folder):
        raise HTTPException(status_code=404, detail="Folder not found")
    res = scan_folder(req.folder, req.recursive, req.outDir)
    taken: set[str] = set()
    if req.outDir:
        from export.nwb_export import output_path
        for f in res["files"]:
            f["target"] = output_path(f["path"], req.folder, req.outDir, taken)
    return res


class PlanFileRequest(BaseModel):
    path: str


@router.post("/plan_file")
def nwb_plan_file(req: PlanFileRequest):
    from export.nwb_export import plan
    try:
        rec, _ = _read_recording(req.path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read the file: {e}")
    return plan(rec)


class ExportFileRequest(BaseModel):
    source: str
    target: str
    meta: dict[str, Any] = {}
    kinds: dict[str, str] = {}
    leaveOutExcluded: bool = True
    inspect: bool = True


@router.post("/export_file")
def nwb_export_file(req: ExportFileRequest):
    from export.nwb_export import write_nwb, inspect, read_sidecar, apply_scale_overrides

    if not req.target.lower().endswith(".nwb"):
        raise HTTPException(status_code=400, detail="The target must end in .nwb")
    if os.path.abspath(req.target) == os.path.abspath(req.source):
        raise HTTPException(status_code=400, detail="Target and source are the same file")
    try:
        rec, pgf = _read_recording(req.source)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read the file: {e}")
    sc = read_sidecar(req.source)
    apply_scale_overrides(rec, sc.get("scale_overrides") or {})
    excluded = (sc.get("excluded_sweeps") or {}) if req.leaveOutExcluded else None
    os.makedirs(os.path.dirname(req.target) or ".", exist_ok=True)
    try:
        res = write_nwb(rec, req.target, req.meta, req.kinds, excluded, pgf=pgf)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not write the NWB file: {e}")
    messages: list[dict] = []
    inspect_error = None
    if req.inspect:
        try:
            messages = inspect(req.target)
        except Exception as e:
            inspect_error = f"The NWB Inspector could not run: {e}"
    return {
        "path": res.path,
        "sizeBytes": os.path.getsize(res.path),
        "seriesWritten": res.series_written,
        "sweepsWritten": res.sweeps_written,
        "notes": res.notes,
        "messages": messages,
        "inspectError": inspect_error,
    }
