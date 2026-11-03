"""Burst-specific API endpoints.

Currently just /measure_at — used by the Burst Detection window's sweep
viewer so the user can left-click on a missed burst and have the backend
extract the same metrics that auto-detection would have produced.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.files import get_current_recording
from utils.scaling import scaled
from analysis.bursts import BurstDetection, _apply_pre_detection_filter

router = APIRouter()


class MeasureAtRequest(BaseModel):
    group: int
    series: int
    sweep: int
    trace: int
    time_s: float
    # Same params object the user ran detection with. We re-use the
    # filter + pre_burst_window_ms + peak_direction bits; everything else
    # is ignored.
    params: dict = {}


@router.post("/measure_at")
async def measure_at(req: MeasureAtRequest):
    """Measure a single burst seeded at ``time_s`` in the chosen sweep.

    Strategy: apply the same pre-detection filter the auto-detector used,
    then hand a tiny [time_s − 20 ms, time_s + 20 ms] seed window to
    ``_populate_burst_fields``. That helper finds the strongest
    deviation within the seed, sets the pre-burst baseline from the
    preceding ``pre_burst_window_ms``, and extends the bounds outward
    until the signal returns near the baseline — exactly what
    auto-detection does for every burst it finds.

    Returns a single burst dict in the same shape as
    ``BurstDetection.run().bursts[...]``, with an extra ``manual: true``
    flag so the frontend can style it distinctly.
    """
    rec = get_current_recording()
    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    if req.sweep < 0 or req.sweep >= ser.sweep_count:
        raise HTTPException(status_code=400, detail=f"Sweep index {req.sweep} out of range")
    sw = ser.sweeps[req.sweep]
    if req.trace < 0 or req.trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail=f"Trace index {req.trace} out of range")
    tr = sw.traces[req.trace]

    data = scaled(tr)
    sr = tr.sampling_rate
    if len(data) == 0 or sr <= 0:
        raise HTTPException(status_code=400, detail="Empty sweep")

    # Apply the same pre-detection filter the detector used, so the seed
    # measurement lands on the same signal the user is looking at in the
    # mini-viewer (which also shows the filtered trace when enabled).
    filtered = _apply_pre_detection_filter(data, sr, req.params)

    # ±20 ms seed around the click — wide enough that the argmax inside
    # the window reliably lands on the actual peak, narrow enough not to
    # pick up neighbouring events.
    seed_half_samples = max(1, int(0.020 * sr))
    click_idx = int(round(req.time_s * sr))
    i0 = max(0, click_idx - seed_half_samples)
    i1 = min(len(filtered), click_idx + seed_half_samples + 1)
    if i1 <= i0:
        raise HTTPException(status_code=400, detail="Click out of sweep range")

    burst: dict = {
        "start_idx": i0,
        "end_idx": i1,
        "start_s": i0 / sr,
        "end_s": i1 / sr,
        "duration_ms": (i1 - i0) / sr * 1000.0,
    }

    # Reuse the detector's measurement helper so the returned burst has
    # the exact same fields as any auto-detected one.
    det = BurstDetection()
    pre_window_ms = float(req.params.get("pre_burst_window_ms", 100.0))
    peak_dir = str(req.params.get("peak_direction", "auto"))
    det._populate_burst_fields(
        [burst], filtered, sr,
        pre_burst_window_ms=pre_window_ms,
        peak_direction=peak_dir,
    )

    # Sanity: if the amplitude came out as zero (click fell on a flat
    # region), the extension collapsed. Surface a clear error so the
    # frontend doesn't append a useless row.
    if burst.get("peak_amplitude", 0.0) == 0.0:
        raise HTTPException(
            status_code=400,
            detail="No burst-like deviation near that click point.",
        )

    return {
        "sweep_index": req.sweep,
        "manual": True,
        **burst,
    }


# ---------------------------------------------------------------------------
# Dual-site propagation
# ---------------------------------------------------------------------------

class PropagationRequest(BaseModel):
    group: int
    series: int
    ref_channel: int
    partner_channel: int
    # Burst records as the frontend stores them (camelCase): only
    # sweepIndex, startS, endS, peakTimeS, peakSigned, peakAmplitude are used.
    ref_bursts: list[dict] = []
    partner_bursts: list[dict] = []
    # Each channel's detection params — their pre-filter is applied to the
    # waveforms before cross-correlation.
    ref_params: dict = {}
    partner_params: dict = {}
    params: dict = {}
    excluded_sweeps: Optional[list[int]] = None


@router.post("/propagation")
async def propagation(req: PropagationRequest):
    """Pair reference and partner discharges and measure their lags."""
    from analysis.propagation import analyse_propagation

    rec = get_current_recording()
    try:
        ser = rec.groups[req.group].series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    if req.ref_channel == req.partner_channel:
        raise HTTPException(status_code=400, detail="Pick two different channels")
    try:
        return analyse_propagation(
            ser, req.ref_channel, req.partner_channel,
            req.ref_bursts, req.partner_bursts,
            req.ref_params, req.partner_params, req.params,
            req.excluded_sweeps or [], scaled,
        )
    except (ValueError, IndexError) as e:
        raise HTTPException(status_code=400, detail=str(e))
