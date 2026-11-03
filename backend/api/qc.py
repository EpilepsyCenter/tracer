"""Quality control API (Cohort ▸ Quality tab). See analysis/qc.py.

- ``POST /api/qc/tags``     — series tags with Resistance / Cursor results
                              in the folder (the condition dropdowns).
- ``POST /api/qc/config``   — the folder's ``tracer_qc.json`` (or the
                              defaults, with ``exists: false``).
- ``POST /api/qc/save``     — write the folder's ``tracer_qc.json``.
- ``POST /api/qc/evaluate`` — verdicts for every cell in the folder,
                              with the given config or the saved one.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from analysis import qc

router = APIRouter()


class FolderRequest(BaseModel):
    folder: str


class SaveRequest(BaseModel):
    folder: str
    config: dict[str, Any]


class EvaluateRequest(BaseModel):
    folder: str
    config: Optional[dict[str, Any]] = None


@router.post("/tags")
def tags(req: FolderRequest) -> dict:
    return {'tags': qc.available_tags(req.folder)}


@router.post("/config")
def config(req: FolderRequest) -> dict:
    saved = qc.load_config(req.folder)
    return {'config': saved or qc.default_config(), 'exists': saved is not None,
            'metrics': qc.METRICS}


@router.post("/save")
def save(req: SaveRequest) -> dict:
    try:
        qc.save_config(req.folder, req.config)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Couldn't save {qc.RULES_FILE}: {exc}") from exc
    return {'ok': True, 'path': str(qc.rules_path(req.folder))}


@router.post("/evaluate")
def evaluate(req: EvaluateRequest) -> dict:
    cfg = req.config or qc.load_config(req.folder) or qc.default_config()
    return qc.evaluate_folder(req.folder, cfg)
