"""I-V curve analysis — compute (stimulus level, response) pairs across every
sweep in a series so the frontend can plot the cell's I-V relationship.

For each sweep we return BOTH a steady-state response (mean of the last
``peak_window_ms`` of the pulse minus baseline) AND a transient peak response
(most-deviant sample in the pulse minus baseline). The frontend picks which
metric to display; both are always returned so switching doesn't require a
refetch.

Baseline is measured in the FIRST ``baseline_window_ms`` of the sweep — user
may override the window via the query params.
"""

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from api.files import get_current_recording
from utils.scaling import scaled
from utils.stimulus import is_current_unit, steps_for_series
from readers.heka_native.pgf import PgfStimulation, PgfChannel

router = APIRouter()


def _pick_stim_channel(stim: PgfStimulation) -> Optional[PgfChannel]:
    """Same scoring as the stimulus-overlay endpoint — pick the channel that
    actually drives the cell (highest voltage range, preferring ``do_write``)."""
    best: Optional[PgfChannel] = None
    best_score = -1.0
    for ch in stim.channels:
        if not ch.segments:
            continue
        levels = [seg.voltage_at_sweep(0) for seg in ch.segments]
        v_range = max(abs(v) for v in levels) if levels else 0.0
        score = v_range * (2.0 if ch.do_write else 1.0)
        if score > best_score or best is None:
            best_score = score
            best = ch
    return best


def _stim_level_for_sweep(stim: PgfStimulation, sweep_idx: int) -> tuple[float, str]:
    """Compute the pulse level (absolute, scaled to mV/pA) for a given sweep.

    Strategy: take the channel's largest-amplitude segment (the actual pulse,
    as opposed to a pre-pulse baseline segment), and return its level at the
    requested sweep.
    """
    ch = _pick_stim_channel(stim)
    if ch is None:
        return 0.0, ""

    # Unit conversion — identical to the stimulus overlay (x1000 universal).
    dac_unit = ch.dac_unit.strip()
    if dac_unit in ("V", "Volt"):
        unit_label = "mV"
        scale = 1000.0
    elif dac_unit in ("A", "Amp", "Ampere"):
        unit_label = "pA"
        scale = 1000.0
    else:
        unit_label = dac_unit
        scale = 1.0

    # Find the segment with largest absolute voltage at this sweep — that's
    # the pulse. Fall back to the first non-zero segment.
    best_seg = None
    best_abs = -1.0
    for seg in ch.segments:
        v = seg.voltage_at_sweep(sweep_idx)
        if abs(v) > best_abs:
            best_abs = abs(v)
            best_seg = seg
    if best_seg is None:
        return 0.0, unit_label

    level = best_seg.voltage_at_sweep(sweep_idx) * scale
    return float(level), unit_label


@router.get("/run")
async def run_iv(
    group: int = Query(0),
    series: int = Query(0),
    trace: int = Query(0),
    baseline_start_s: float = Query(..., description="Baseline cursor start (s from sweep start)"),
    baseline_end_s: float = Query(..., description="Baseline cursor end (s from sweep start)"),
    peak_start_s: float = Query(..., description="Peak/SS cursor start (s from sweep start)"),
    peak_end_s: float = Query(..., description="Peak/SS cursor end (s from sweep start)"),
    sweeps: Optional[str] = Query(None, description="Comma-separated 0-based sweep indices. None = all sweeps."),
    manual_im_enabled: bool = Query(False, description=(
        "Bypass the stimulus-protocol lookup and reconstruct Im from the "
        "four parameters below. Use this when the stimulus trace isn't "
        "recorded or the protocol doesn't expose Im."
    )),
    manual_im_start_s: float = Query(0.0),
    manual_im_end_s: float = Query(0.0),
    manual_im_start_pa: float = Query(0.0, description=(
        "Im amplitude of the FIRST sweep's step (pA). Subsequent sweeps get "
        "`start_pa + sweep_index * step_pa`."
    )),
    manual_im_step_pa: float = Query(0.0, description=(
        "Im increment between consecutive sweeps (pA)."
    )),
    stim_trace: Optional[int] = Query(None, description=(
        "Index of a recorded trace holding the stimulus (NWB stimulus, ABF "
        "command, HEKA monitor). Each sweep's level is its step's level. "
        "Used when Manual Im is off, instead of the protocol."
    )),
):
    """Run I-V analysis over every sweep in a series.

    Baseline window: ``[baseline_start_ms, baseline_end_ms]`` from sweep start
    (defaults to first 100 ms of the sweep, as requested).

    Peak/steady-state window: the last ``peak_window_ms`` of the pulse (pulse
    window is taken from the series's stimulus info — ``pulse_start`` to
    ``pulse_end`` attributes of the parsed stim).

    When ``manual_im_enabled`` is set, the stimulus lookup is skipped entirely
    and Im for each sweep is reconstructed from the four ``manual_im_*``
    params. This is the fallback path for recordings where the stimulus
    channel wasn't saved.
    """
    from api.files import _pgf_data

    rec = get_current_recording()

    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    target: Optional[PgfStimulation] = None
    use_trace = stim_trace is not None and not manual_im_enabled
    if not manual_im_enabled and not use_trace:
        if _pgf_data is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No stimulus protocol for this recording. Pick the "
                    "stimulus trace as the Im source, or enable 'Manual Im'."
                ),
            )
        # Linearly map (group, series) → stim index (same logic as traces.py::stimulus).
        stim_idx = 0
        for g in rec.groups:
            for s in g.series_list:
                if g.index == group and s.index == series:
                    if stim_idx < len(_pgf_data.stimulations):
                        target = _pgf_data.stimulations[stim_idx]
                stim_idx += 1
        if target is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No stimulus found for this series. Enable 'Manual Im' "
                    "to provide start/end times and amplitudes by hand."
                ),
            )

    # Sanity-check the cursor windows.
    if baseline_end_s <= baseline_start_s:
        raise HTTPException(status_code=400, detail="Baseline cursor: end must exceed start")
    if peak_end_s <= peak_start_s:
        raise HTTPException(status_code=400, detail="Peak cursor: end must exceed start")

    # Optional sweep-subset filter (zero-based indices).
    sweep_filter: Optional[set[int]] = None
    if sweeps is not None and sweeps.strip():
        try:
            sweep_filter = {int(x) for x in sweeps.split(",") if x.strip() != ""}
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid `sweeps` list")

    # Recorded stimulus trace: the level of each sweep's step (#28).
    trace_levels: dict[int, float] = {}
    trace_unit = ""
    if use_trace:
        idxs = [i for i in range(len(ser.sweeps)) if sweep_filter is None or i in sweep_filter]
        traces = []
        for i in idxs:
            sw = ser.sweeps[i]
            if stim_trace < 0 or stim_trace >= sw.trace_count:
                raise HTTPException(status_code=400, detail=f"Stimulus trace {stim_trace} isn't in sweep {i + 1}")
            st = sw.traces[stim_trace]
            trace_unit = st.units
            traces.append(scaled(st))
        sr_stim = ser.sweeps[idxs[0]].traces[stim_trace].sampling_rate if idxs else 0.0
        for i, step in zip(idxs, steps_for_series(traces, sr_stim)):
            if step is not None:
                trace_levels[i] = step.level

    points = []
    response_unit = ""

    for sw_idx, sw in enumerate(ser.sweeps):
        if sweep_filter is not None and sw_idx not in sweep_filter:
            continue
        if trace >= sw.trace_count:
            continue
        tr = sw.traces[trace]
        response_unit = tr.units
        sr = tr.sampling_rate
        data = scaled(tr)
        n = len(data)
        if n == 0:
            continue

        # Baseline = mean of the signal inside the baseline cursor window.
        bl_i0 = max(0, int(baseline_start_s * sr))
        bl_i1 = min(n, int(baseline_end_s * sr))
        if bl_i1 <= bl_i0:
            continue
        baseline = float(np.mean(data[bl_i0:bl_i1]))

        # Peak cursor window — what the user brackets for the response.
        # Steady-state = mean(peak_window). Transient peak = extreme
        # deviation from baseline within that same window.
        p_i0 = max(0, int(peak_start_s * sr))
        p_i1 = min(n, int(peak_end_s * sr))
        if p_i1 <= p_i0:
            steady_state = baseline
            transient_peak = baseline
        else:
            seg = data[p_i0:p_i1]
            steady_state = float(np.mean(seg))
            max_dev_idx = int(np.argmax(np.abs(seg - baseline)))
            transient_peak = float(seg[max_dev_idx])

        if manual_im_enabled:
            stim_level = manual_im_start_pa + sw_idx * manual_im_step_pa
            # The manual numbers are a voltage in voltage clamp (the
            # response is a current), a current otherwise (#24).
            stim_unit = "mV" if is_current_unit(response_unit) else "pA"
        elif use_trace:
            if sw_idx not in trace_levels:
                continue
            stim_level, stim_unit = trace_levels[sw_idx], trace_unit
        elif target is not None:
            stim_level, stim_unit = _stim_level_for_sweep(target, sw_idx)
        else:
            # Shouldn't reach here — the manual/stim check above raises 400.
            stim_level, stim_unit = 0.0, ""

        # Sag measurements. Defined per Ih convention for hyperpolarising
        # steps but the user asked for both signs so we report them
        # regardless of polarity and let the interpreter decide.
        #   sag_amp   = transient_peak − steady_state (mV; same sign
        #               as the step deflection; 0 when no sag)
        #   sag_ratio = sag_amp / (transient_peak − baseline)
        #               (dimensionless, typically 0..1; null when
        #               the total deflection is ~0 so the ratio is
        #               undefined).
        sag_amp = transient_peak - steady_state
        total_dev = transient_peak - baseline
        sag_ratio = (sag_amp / total_dev) if abs(total_dev) > 1e-9 else None
        points.append({
            "sweep_index": sw_idx,
            "stim_level": stim_level,
            "baseline": baseline,
            "steady_state": steady_state,
            "transient_peak": transient_peak,
            "sag_amp": sag_amp,
            "sag_ratio": sag_ratio,
        })

    # Sort points by stim level so the plot is monotonic in x.
    points.sort(key=lambda p: p["stim_level"])

    # Report which Im source got used so the UI's ImSourceCard can
    # surface it. Matches the shape AP returns.
    if manual_im_enabled:
        im_source = {"mode": "manual", "label": None}
    elif use_trace:
        lbl = ser.sweeps[0].traces[stim_trace].label if ser.sweeps and stim_trace < ser.sweeps[0].trace_count else ""
        im_source = {"mode": "trace", "label": f"{lbl or f'Ch {stim_trace}'} ({trace_unit})"}
    elif target is not None:
        picked = _pick_stim_channel(target)
        unit = getattr(picked, "stim_unit_label", None) or stim_unit or ""
        im_source = {"mode": "protocol", "label": f"reconstructed ({unit})" if unit else "reconstructed"}
    else:
        im_source = {"mode": "none", "label": None}

    return {
        "points": points,
        "stim_unit": stim_unit if points else "",
        "response_unit": response_unit,
        "baseline_start_s": baseline_start_s,
        "baseline_end_s": baseline_end_s,
        "peak_start_s": peak_start_s,
        "peak_end_s": peak_end_s,
        "im_source": im_source,
    }
