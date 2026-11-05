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
