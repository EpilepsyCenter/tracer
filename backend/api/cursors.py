"""Cursor analysis endpoint — powers the CursorAnalysisWindow.

Accepts one baseline cursor pair plus up to N peak/fit "slots" and runs
every Stimfit-style measurement the analysis module exposes. Supports
averaging selected sweeps before measuring (``average=true``) or
measuring each sweep independently.
"""

from typing import List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.files import get_current_recording
from utils.scaling import scaled
from analysis.cursor_suite import (
    FIT_FUNCTIONS,
    fit_function_catalog,
    fit_window,
    measure_slot,
)

router = APIRouter()


class CursorPair(BaseModel):
    start: float
    end: float


class FitOptions(BaseModel):
    """Per-slot curve-fit tuning, mirroring Stimfit's fit dialog."""
    maxfev: Optional[int] = None
    ftol: Optional[float] = None
    xtol: Optional[float] = None
    initial_guess: Optional[dict[str, Optional[float]]] = None


class CursorSlot(BaseModel):
    enabled: bool = True
    peak: CursorPair
    fit: Optional[CursorPair] = None
    fit_function: Optional[str] = None
    fit_options: Optional[FitOptions] = None


class CursorAnalysisRequest(BaseModel):
    group: int = 0
    series: int = 0
    trace: int = 0
    sweeps: Optional[List[int]] = None                     # None = all sweeps
    average: bool = False
    baseline: CursorPair
    baseline_method: str = Field("mean", pattern="^(mean|median)$")
    slots: List[CursorSlot]
    compute_ap: bool = False
    ap_slope_vs: float = 20.0                              # dV/dt threshold in V/s


@router.get("/functions")
async def list_fit_functions():
    """Frontend pulls this on mount to populate the per-slot fit-function
    dropdowns and know which parameter names each function emits."""
    return {"functions": fit_function_catalog()}


@router.post("/run")
async def run_cursor_analysis(req: CursorAnalysisRequest):
    rec = get_current_recording()

    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    # Resolve sweep list.
    total = len(ser.sweeps)
    if req.sweeps is None or len(req.sweeps) == 0:
        sweep_indices = list(range(total))
    else:
        sweep_indices = [i for i in req.sweeps if 0 <= i < total]
        if not sweep_indices:
            raise HTTPException(status_code=400, detail="No valid sweep indices")

    # Grab per-sweep data vectors for the requested trace.
    data_vectors: list[np.ndarray] = []
    measured_idx: list[int] = []       # sweep index of each data vector
    sampling_rate: Optional[float] = None
    unit = ""
    for idx in sweep_indices:
        sw = ser.sweeps[idx]
        if req.trace >= sw.trace_count:
            continue
        tr = sw.traces[req.trace]
        if tr.data.size == 0:
            continue
        if sampling_rate is None:
            sampling_rate = tr.sampling_rate
            unit = tr.units
        data_vectors.append(scaled(tr))
        measured_idx.append(idx)

    if not data_vectors or sampling_rate is None:
        raise HTTPException(status_code=400, detail="No sweeps contain data for this trace")

    # Pad-and-crop to the shortest length when averaging so slicing stays safe
    # (HEKA sweeps in the same series should already share length).
    if req.average:
        min_n = min(v.size for v in data_vectors)
        stacked = np.stack([v[:min_n] for v in data_vectors], axis=0)
        traces_to_measure = [(-1, stacked.mean(axis=0).astype(np.float64))]
    else:
        # Pair each vector with ITS sweep: skipped sweeps (no data on
        # this trace) must not shift the labels of the ones after them.
        traces_to_measure = list(zip(measured_idx, data_vectors))

    # Validate slots once.
    for si, slot in enumerate(req.slots):
        if slot.peak.end <= slot.peak.start:
            raise HTTPException(
                status_code=400,
                detail=f"Slot {si + 1}: peak cursor end must exceed start",
            )
        if slot.fit is not None and slot.fit.end <= slot.fit.start:
            raise HTTPException(
                status_code=400,
                detail=f"Slot {si + 1}: fit cursor end must exceed start",
            )
        if slot.fit_function is not None and slot.fit_function not in FIT_FUNCTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Slot {si + 1}: unknown fit function '{slot.fit_function}'",
            )

    measurements = []
    for sweep_idx, data in traces_to_measure:
        for slot_index, slot in enumerate(req.slots):
            if not slot.enabled:
                continue
            baseline, sd, core = measure_slot(
                data=data,
                sampling_rate=sampling_rate,
                baseline_window=(req.baseline.start, req.baseline.end),
                peak_window=(slot.peak.start, slot.peak.end),
                baseline_method=req.baseline_method,
                compute_ap=req.compute_ap,
                ap_slope_vs=req.ap_slope_vs,
            )

            fit_result = None
            if slot.fit is not None and slot.fit_function:
                fit_result = fit_window(
                    data=data,
                    sampling_rate=sampling_rate,
                    window=(slot.fit.start, slot.fit.end),
                    function=slot.fit_function,
                    options=slot.fit_options.model_dump(exclude_none=True) if slot.fit_options else None,
                )

            measurements.append({
                "slot": slot_index,
                "sweep": sweep_idx,
                "baseline": baseline,
                "baseline_sd": sd,
                **{k: v for k, v in core.items() if v is not None or k in ("peak", "peak_time", "amplitude")},
                "fit": None if fit_result is None else {
                    "function": fit_result.function,
                    "params": fit_result.params,
                    "rss": fit_result.rss,
                    "r_squared": fit_result.r_squared,
                    "fit_time": fit_result.fit_time,
                    "fit_values": fit_result.fit_values,
                },
            })

    return {
        "measurements": measurements,
        "trace_unit": unit,
        "time_unit": "s",
        "sampling_rate": sampling_rate,
        "averaged": req.average,
        "sweeps_used": sweep_indices,
    }
