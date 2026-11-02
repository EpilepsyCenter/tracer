"""Spectral analysis endpoints: per-region PSD / band power, and spectrogram."""

from __future__ import annotations

import base64
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from analysis import spectral as S
from api.files import get_current_recording
from utils.scaling import scaled

router = APIRouter()


class SpectralRunRequest(BaseModel):
    group: int = 0
    series: int = 0
    trace: int = 0
    regions: list[dict] = []
    params: dict = {}
    excluded_sweeps: Optional[list[int]] = None


@router.get("/defaults")
async def defaults():
    return {"params": S.DEFAULT_PARAMS}


@router.post("/run")
async def run(req: SpectralRunRequest):
    rec = get_current_recording()
    try:
        ser = rec.groups[req.group].series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    regions = req.regions or [{"id": "all", "label": "Whole series"}]
    params = S.merged_params(req.params)
    results = S.run_regions(ser, req.trace, regions, params,
                            req.excluded_sweeps or [], scaled)
    return {"results": results, "params": params}


class TimecourseRequest(BaseModel):
    group: int = 0
    series: int = 0
    trace: int = 0
    params: dict = {}
    excluded_sweeps: Optional[list[int]] = None
    bin_s: float = 10.0
    step_s: Optional[float] = None


@router.post("/timecourse")
async def timecourse(req: TimecourseRequest):
    rec = get_current_recording()
    try:
        ser = rec.groups[req.group].series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    try:
        return S.band_timecourse(ser, req.trace, req.params, req.excluded_sweeps or [],
                                 scaled, req.bin_s, req.step_s)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class SpectrogramRequest(BaseModel):
    group: int = 0
    series: int = 0
    sweep: int = 0
    trace: int = 0
    t_start: Optional[float] = None
    t_end: Optional[float] = None
    params: dict = {}
    max_cols: int = 1200


@router.post("/spectrogram")
async def spectrogram(req: SpectrogramRequest):
    rec = get_current_recording()
    try:
        sw = rec.groups[req.group].series_list[req.series].sweeps[req.sweep]
        tr = sw.traces[req.trace]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series/sweep/trace index")
    params = S.merged_params(req.params)
    sr = float(tr.sampling_rate)
    x = S.prefilter(scaled(tr), sr, params)
    n = len(x)
    # Pad by half a window each side so the first and last columns are
    # centred at the viewport edges rather than half a window inside.
    pad = float(params.get("spec_window_s") or 1.0) / 2.0
    t0 = 0.0 if req.t_start is None else max(0.0, req.t_start - pad)
    t1 = n / sr if req.t_end is None else min(n / sr, req.t_end + pad)
    i0, i1 = int(t0 * sr), int(t1 * sr)
    if i1 - i0 < 8:
        raise HTTPException(status_code=400, detail="Empty time range")
    try:
        out = S.compute_spectrogram(
            x[i0:i1], sr, i0 / sr, params,
            max_cols=max(50, min(int(req.max_cols), 3000)),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    p = np.ascontiguousarray(out.pop("power_db"), dtype="<f4")
    return {
        **out,
        "n_freqs": int(p.shape[0]),
        "n_times": int(p.shape[1]),
        "power_db_b64": base64.b64encode(p.tobytes()).decode("ascii"),
        "units": tr.units,
    }
