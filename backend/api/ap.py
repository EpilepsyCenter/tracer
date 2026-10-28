"""Action Potentials API endpoints.

Three endpoints:

- ``POST /api/ap/run`` — full pipeline. Takes a JSON body with the
  detection params, kinetics params, optional manual edits, and
  rheobase mode. Returns per-sweep + per-spike results, F-I curve,
  and rheobase.

- ``GET /api/ap/phase_plot`` — Vm vs dV/dt slice around one spike,
  computed on demand. Takes the spike's peak time so the call site
  doesn't have to re-detect.

- ``GET /api/ap/auto_im_params`` — best-effort guess at ramp
  parameters parsed from the ``.pgf`` stimulus tree. Used by the
  frontend to prefill the ramp-rheobase inputs when the user has
  no Im channel recorded.

POST is used for ``/run`` because the param surface is large enough
(detection, kinetics, ramp, manual edits) that a query string would
be unwieldy. The other two endpoints stay GET — both have a small
parameter set.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from api.files import get_current_recording
from api.fpsp import _stim_for_series, _detect_stim_onset_s
from utils.scaling import scaled
from analysis.ap import (
    run_ap, phase_plot_for_spike, _Spike, measure_spike_polar, kinetics_for_method,
    kinetics_on_filtered,
)
from analysis.bursts import _apply_pre_detection_filter

router = APIRouter()


# ---------------------------------------------------------------------------
# /run — full AP pipeline
# ---------------------------------------------------------------------------

class APRunRequest(BaseModel):
    """All inputs for one /api/ap/run call.

    Im source model (matches IV): when ``manual_im_enabled`` is False
    (default), the backend reconstructs Im from the recording's
    stimulus protocol — the same logic the AP window used to trigger
    via ``im_trace=-1``. When True, Im for each sweep is computed
    from ``start_pa + sweep_index * step_pa`` over the window
    [start_s, end_s]. Either way the response reports back what got
    used via the ``im_source`` field so the UI can surface it.
    """
    group: int
    series: int
    trace: int
    sweeps: Optional[list[int]] = None
    detection: dict = {}
    kinetics: dict = {}
    rheobase_mode: str = "record"
    ramp_params: Optional[dict] = None
    manual_edits: Optional[dict] = None
    measure_kinetics: bool = True
    # Manual Im override — same field names as IV so the two windows
    # pass the same shape through to the backend.
    manual_im_enabled: bool = False
    manual_im_start_s: float = 0.0
    manual_im_end_s: float = 0.0
    manual_im_start_pa: float = 0.0
    manual_im_step_pa: float = 0.0
    # 'evoked' (default — stimulus-driven sweeps) or 'spontaneous'
    # (continuous recording, no stimulus: Im / F-I / rheobase /
    # latency are skipped).
    mode: str = "evoked"


@router.post("/run")
async def ap_run(req: APRunRequest):
    rec = get_current_recording()
    try:
        grp = rec.groups[req.group]
        ser = grp.series_list[req.series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    n_sweeps = ser.sweep_count
    if n_sweeps == 0:
        raise HTTPException(status_code=400, detail="Series has no sweeps")

    sweep_indices = req.sweeps if req.sweeps else list(range(n_sweeps))
    sweep_indices = [s for s in sweep_indices if 0 <= s < n_sweeps]
    if not sweep_indices:
        raise HTTPException(status_code=400, detail="No valid sweeps requested")

    # Im source: two modes.
    #
    # 1. Auto (default): reconstruct Im from the stimulus protocol.
    #    For current-clamp this is the actual current step / ramp
    #    commanded at the DAC. We rebuild the DA waveform per sweep
    #    via the protocol channel's ``reconstruct_sweep``.
    # 2. Manual: the user provides start / step / window. Per sweep
    #    Im = start_pa + sweep_index * step_pa over [start_s, end_s],
    #    padded with zeros outside. Used when the recording has no
    #    stimulus protocol, or the protocol doesn't expose Im.
    #
    # The response's ``im_source`` field reports which path was taken
    # (and which channel the protocol picked) so the UI can surface
    # it in the ImSourceCard info line.
    spontaneous = req.mode == "spontaneous"
    use_manual = bool(req.manual_im_enabled) and not spontaneous
    sweeps_vm: list[np.ndarray] = []
    # Im is always fetched — we need it for F-I curves, rheobase, and
    # latency-to-first-spike. Manual fills from the formula; auto fills
    # from the protocol (or zeros if reconstruction fails).
    sweeps_im: list[np.ndarray] = []
    sr: float = 0.0

    # Protocol-based Im reconstruction (auto mode). Picked once, reused
    # per sweep. Falls back to noop if no protocol data is present
    # (older Patchmaster versions don't write one; other file formats
    # may not either once we add them).
    synth_channel = None
    if not use_manual and not spontaneous:
        target = _stim_for_series(rec, req.group, req.series)
        if target is not None:
            # Layered current-channel pick:
            # 1) Channels in current-clamp ampl_mode (== 2). HEKA
            #    sets this on the active CC DAC reliably.
            # 2) Channels whose DAC unit string explicitly says
            #    A / Amp / Ampere.
            # 3) Sanity: pick the result whose actual values look
            #    like biological currents (< 1 µA in magnitude). If
            #    we wind up with a value that's clearly a voltage in
            #    SI volts (~0.05 = 50 mV), bail.
            def _is_current_unit(u: str) -> bool:
                u = (u or "").strip().upper()
                return u in ("A", "AMP", "AMPS", "AMPERE", "AMPERES")

            cc_channels = [
                ch for ch in target.channels
                if ch.segments and getattr(ch, "is_current_clamp", False)
            ]
            unit_channels = [
                ch for ch in target.channels
                if ch.segments and _is_current_unit(ch.dac_unit)
            ]
            # Combine, deduplicating; prefer CC-mode channels first.
            seen = set()
            candidates: list = []
            for ch in cc_channels + unit_channels:
                if id(ch) in seen:
                    continue
                seen.add(id(ch))
                candidates.append(ch)

            # Tie-break across candidates: widest range across first/
            # middle/last sweep wins (sweep 0 of a CC step protocol
            # is often 0 pA — checking sweep 0 alone misses the
            # active channel entirely).
            n_sw = ser.sweep_count
            probe_sweeps = sorted({0, n_sw // 2, n_sw - 1})
            best, best_score = None, -1.0
            for ch in candidates:
                max_range = 0.0
                for sw in probe_sweeps:
                    if sw < 0 or sw >= n_sw:
                        continue
                    try:
                        lvls = [seg.voltage_at_sweep(sw) for seg in ch.segments]
                    except Exception:
                        continue
                    if not lvls:
                        continue
                    rng = max(abs(v) for v in lvls)
                    if rng > max_range:
                        max_range = rng
                store_bonus = 2.0 if ch.do_write else 1.0
                score = max_range * store_bonus + 1e-30  # tiebreak ≥ 0
                if score > best_score:
                    best_score = score; best = ch

            # Final gate: require the unit string to be a current
            # explicitly. Values are stored in nA (50 pA → 0.05),
            # so a magnitude check is mostly redundant — the unit
            # string is the canonical signal.
            if best is not None and not _is_current_unit(best.dac_unit):
                best = None
            synth_channel = best

    for si in sweep_indices:
        sw = ser.sweeps[si]
        if req.trace < 0 or req.trace >= sw.trace_count:
            sweeps_vm.append(np.zeros(0))
            sweeps_im.append(np.zeros(0))
            continue
        tr = sw.traces[req.trace]
        sweeps_vm.append(np.asarray(scaled(tr), dtype=float))
        if sr <= 0 and tr.sampling_rate > 0:
            sr = float(tr.sampling_rate)

        if use_manual:
            # Build a per-sweep Im trace from the manual formula. Matches
            # the IV window's Manual Im semantics: constant current
            # inside [start_s, end_s], zero outside.
            n = tr.data.size
            sr_tr = float(tr.sampling_rate) if tr.sampling_rate > 0 else 0.0
            im_arr = np.zeros(n, dtype=float)
            if sr_tr > 0 and req.manual_im_end_s > req.manual_im_start_s:
                i0 = max(0, int(round(req.manual_im_start_s * sr_tr)))
                i1 = min(n, int(round(req.manual_im_end_s * sr_tr)))
                if i1 > i0:
                    level = req.manual_im_start_pa + si * req.manual_im_step_pa
                    im_arr[i0:i1] = level
            sweeps_im.append(im_arr)
        elif synth_channel is not None and tr.sampling_rate > 0:
            # PgfSegment values are stored in nA (not SI A as the
            # dataclass docstring claims). Convert nA → pA = ×1000.
            # api/traces.py uses the same factor for stim overlay.
            wave = synth_channel.reconstruct_sweep(si, 1.0 / float(tr.sampling_rate))
            sweeps_im.append(np.asarray(wave, dtype=float) * 1000.0)
        else:
            sweeps_im.append(np.zeros(0))

    if sr <= 0:
        raise HTTPException(status_code=400, detail="No valid sweeps in selection")

    # Stim onset (used for first-spike latency only; rheobase 'exact'
    # uses the actual Im channel sample rather than this).
    im_onset_s: Optional[float] = None
    target = None if spontaneous else _stim_for_series(rec, req.group, req.series)
    if target is not None:
        try:
            im_onset_s = float(_detect_stim_onset_s(target))
        except Exception:
            im_onset_s = None

    # Default bounds_end_s to the Vm sweep length when not provided —
    # mirrors how FPsp handles "no end set".
    detection = dict(req.detection)
    if not detection.get("bounds_end_s"):
        detection["bounds_end_s"] = sweeps_vm[0].size / sr if sweeps_vm[0].size else 0.0

    result = run_ap(
        sweeps_vm=sweeps_vm,
        sweeps_im=sweeps_im,
        sweep_indices=sweep_indices,
        sr=sr,
        detection=detection,
        kinetics=req.kinetics or {},
        rheobase_mode=req.rheobase_mode,
        ramp_params=req.ramp_params,
        im_onset_s=im_onset_s,
        manual_edits=req.manual_edits,
        measure_kinetics=req.measure_kinetics,
        mode="spontaneous" if spontaneous else "evoked",
    )

    # Auto/protocol Im patch: for step protocols the per-sweep Im mean
    # over [bounds_start_s, bounds_end_s] (typically the full sweep)
    # is diluted by long stretches at holding (0 pA) and collapses
    # toward zero. F-I points then all stack at x ≈ 0. Recompute
    # im_mean from the most-active stim segment for each sweep, and
    # rebuild the F-I curve from those step-level values. Spike
    # counts/rates are not changed. (Manual mode doesn't need this —
    # the user's start_s/end_s already bracket the step and the formula
    # returns a single level per sweep.)
    if (not use_manual) and synth_channel is not None:
        new_fi_im: list[float] = []
        new_fi_rate: list[float] = []
        new_fi_sweep: list[int] = []
        for i, sweep_idx in enumerate(sweep_indices):
            # Find the dominant non-trivial segment for this sweep.
            t = 0.0
            step_t0 = step_t1 = None
            best_abs = 0.0
            for seg in synth_channel.segments:
                try:
                    dur = seg.duration_at_sweep(sweep_idx)
                    level = seg.voltage_at_sweep(sweep_idx)
                except Exception:
                    continue
                if dur > 0 and abs(level) > best_abs:
                    best_abs = abs(level)
                    step_t0 = t
                    step_t1 = t + dur
                t += dur
            if step_t0 is None or i >= len(sweeps_im):
                continue
            i0 = max(0, int(round(step_t0 * sr)))
            i1 = min(sweeps_im[i].size, int(round(step_t1 * sr)))
            if i1 <= i0:
                continue
            step_im = float(np.mean(sweeps_im[i][i0:i1]))
            ps = result["per_sweep"][i]
            ps["im_mean_pa"] = step_im
            if ps.get("spike_rate_hz") is not None:
                new_fi_im.append(step_im)
                new_fi_rate.append(ps["spike_rate_hz"])
                new_fi_sweep.append(int(sweep_idx))
        if new_fi_im:
            result["fi_curve"] = {"im": new_fi_im, "rate": new_fi_rate, "sweep": new_fi_sweep}

    # Report back which Im source got used, so the UI's ImSourceCard
    # info line can say "detected: X" or "manual values" rather than
    # leaving the user guessing. Format matches IV for consistency.
    if spontaneous:
        im_source = {"mode": "disabled", "label": None}
    elif use_manual:
        im_source = {"mode": "manual", "label": None}
    elif synth_channel is not None:
        unit = getattr(synth_channel, "stim_unit_label", None) or "pA"
        im_source = {"mode": "protocol", "label": f"reconstructed ({unit})"}
    else:
        im_source = {"mode": "none", "label": None}

    result["sampling_rate"] = sr
    result["im_onset_s"] = im_onset_s
    result["im_source"] = im_source
    return result


# ---------------------------------------------------------------------------
# /phase_plot — Vm vs dV/dt around one spike
# ---------------------------------------------------------------------------

@router.get("/phase_plot")
async def ap_phase_plot(
    group: int = Query(...),
    series: int = Query(...),
    trace: int = Query(...),
    sweep: int = Query(...),
    peak_t_s: float = Query(..., description="Time of the spike's peak (seconds within sweep)"),
    window_ms: float = Query(5.0, description="Half-width of the slice around the peak"),
    interp_factor: int = Query(10, ge=1, le=200, description="1 = no upsampling; 10 = 10× cubic-style interp"),
    filter_type: str = Query("", description="Optional filter (the kinetics trace): lowpass / highpass / bandpass"),
    filter_low: float = Query(0),
    filter_high: float = Query(0),
    filter_order: int = Query(4),
):
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    if sweep < 0 or sweep >= ser.sweep_count:
        raise HTTPException(status_code=400, detail="Sweep out of range")
    sw = ser.sweeps[sweep]
    if trace < 0 or trace >= sw.trace_count:
        raise HTTPException(status_code=400, detail="Trace out of range")
    tr = sw.traces[trace]
    sr = float(tr.sampling_rate)
    vm = np.asarray(scaled(tr), dtype=float)
    if filter_type:
        # Same filter as the pre-detection filter, so the loop matches a
        # run that measured kinetics on the filtered trace.
        vm = _apply_pre_detection_filter(vm, sr, {
            "filter_enabled": True, "filter_type": filter_type,
            "filter_low": filter_low, "filter_high": filter_high,
            "filter_order": filter_order,
        })
    return phase_plot_for_spike(
        vm,
        sr,
        peak_t_s=peak_t_s,
        window_ms=window_ms,
        interp_factor=interp_factor,
    )


# ---------------------------------------------------------------------------
# /auto_im_params — read step / ramp params from .pgf for prefill
# ---------------------------------------------------------------------------

@router.get("/auto_im_params")
async def ap_auto_im_params(
    group: int = Query(...),
    series: int = Query(...),
):
    """Return either a step or ramp description parsed from the
    stimulation protocol, or ``{type: 'none'}`` if nothing useful is
    on the .pgf side. Used to prefill the manual ramp-rheobase inputs
    in the AP window when the recording has no Im channel.

    The .pgf channel structure is shared with FPsp/IV — we lean on
    ``_stim_for_series`` + the segment list to identify a step or ramp.
    """
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    target = _stim_for_series(rec, group, series)
    if target is None:
        return {"type": "none"}

    # Walk segments on the most-active channel; classify the first
    # nonzero segment as either a constant step (level uniform) or a
    # ramp (linearly varying). Heuristics are intentionally simple —
    # the user can always override via the manual ramp inputs.
    n_sweeps = ser.sweep_count
    best_channel = None
    best_score = -1.0
    for ch in target.channels:
        if not ch.segments:
            continue
        # Score: how much the channel level varies across sweeps for
        # any one segment. A current ramp typically varies sweep-to-
        # sweep on at least one step.
        score = 0.0
        for seg in ch.segments:
            try:
                lv0 = seg.voltage_at_sweep(0)
                lvN = seg.voltage_at_sweep(max(0, n_sweeps - 1))
                score = max(score, abs(lvN - lv0))
            except Exception:
                pass
        if score > best_score:
            best_score = score; best_channel = ch
    if best_channel is None:
        return {"type": "none"}

    # Find the first significant segment. Detect ramp by checking if
    # the start and end levels differ within the SAME sweep (the
    # PgfSegment carries that distinction).
    t = 0.0
    for seg in best_channel.segments:
        try:
            dur = seg.duration_at_sweep(0)
            level0 = seg.voltage_at_sweep(0)
        except Exception:
            continue
        if dur <= 0:
            continue
        # Heuristic ramp detection — if the segment carries distinct
        # start/end voltages on a single sweep, it's a ramp.
        try:
            level_end = getattr(seg, "voltage_end_at_sweep", None)
            end_level = level_end(0) if callable(level_end) else level0
        except Exception:
            end_level = level0
        if abs(level0 - end_level) > 1e-9:
            return {
                "type": "ramp",
                "t_start_s": float(t),
                "t_end_s": float(t + dur),
                "im_start_pa": float(level0),
                "im_end_pa": float(end_level),
            }
        if abs(level0) > 1e-9:
            # Plain step — reported as a step type with the constant
            # current and the segment timing. The frontend can decide
            # whether to use it.
            return {
                "type": "step",
                "t_start_s": float(t),
                "t_end_s": float(t + dur),
                "im_pa": float(level0),
            }
        t += dur

    return {"type": "none"}


# ---------------------------------------------------------------------------
# /measure_one — single-spike kinetics for a manually-added AP
# ---------------------------------------------------------------------------

class MeasureOneRequest(BaseModel):
    """Inputs for measuring kinetics on a single click-added spike.

    The frontend's prime+click manual-edit flow inserts an optimistic
    placeholder marker at the click time and dispatches this request
    to fill in threshold, amplitude, rise/decay, FWHM, fAHP, mAHP, and
    max-slope fields — same numbers the auto-detector would produce
    for the same peak. Mirrors how Burst's /measure_at extends a click
    into a fully-measured burst.
    """
    group: int
    series: int
    trace: int
    sweep: int
    peak_t_s: float
    # Same shapes the /run endpoint accepts. Detection is consulted
    # only for the pre-detection filter and ``min_distance_ms`` (the
    # peak-snap window). Kinetics drives the measurement itself.
    detection: dict = {}
    kinetics: dict = {}
    # +1 = upward spike (default), -1 = downward (e.g. inward action
    # currents). Sent from the last run's detected polarity so a click
    # snaps and measures the same way the detector did.
    polarity: int = 1


@router.post("/measure_one")
async def ap_measure_one(req: MeasureOneRequest):
    """Measure full kinetics for a single spike at ``peak_t_s``.

    Strategy:
      1. Apply the same pre-detection filter the auto-detector used and
         snap the click to the nearest local max within ±half the
         configured ``min_distance_ms`` — same as the /run endpoint's
         manual-edits replay (noise-relative runs then snap once more
         onto the unfiltered trace, as /run does).
      2. Measure kinetics on the unfiltered trace (or the filtered one
         with ``measure_on: 'filtered'``) with the user's kinetics
         params — again as /run does.
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

    vm = np.asarray(scaled(tr), dtype=float)
    sr = float(tr.sampling_rate)
    if vm.size == 0 or sr <= 0:
        raise HTTPException(status_code=400, detail="Empty sweep")

    vm_for_measure = _apply_pre_detection_filter(vm, sr, req.detection)

    dt_ms = 1000.0 / sr
    min_dist_ms = float(req.detection.get("min_distance_ms", 2.0))
    snap = max(1, int(round((min_dist_ms / 2.0) / dt_ms)))
    click_idx = int(round(req.peak_t_s * sr))
    i0 = max(0, click_idx - snap)
    i1 = min(vm_for_measure.size, click_idx + snap + 1)
    if i1 <= i0:
        raise HTTPException(status_code=400, detail="Click out of sweep range")
    polarity = -1 if req.polarity < 0 else 1
    seg = vm_for_measure[i0:i1]
    peak_idx = i0 + int(np.argmax(polarity * seg))
    method = str(req.detection.get("method", "auto_rec"))
    # Kinetics on the same trace /run measures on (unfiltered by
    # default), so a clicked spike is measured exactly like a detected one.
    vm_meas = vm_for_measure if kinetics_on_filtered(req.kinetics or {}) else vm
    if method == "noise_threshold":
        # Same final snap as /run: onto the measured trace.
        w = max(1, int(round(float(req.detection.get("peak_snap_ms", 1.0)) / dt_ms)))
        lo, hi = max(0, peak_idx - w), min(vm_meas.size, peak_idx + w + 1)
        peak_idx = lo + int(np.argmax(polarity * vm_meas[lo:hi]))

    spike = _Spike(
        onset_idx=peak_idx,
        peak_idx=peak_idx,
        fall_idx=peak_idx,
        peak_vm=float(vm_meas[peak_idx]),
        manual=True,
    )

    m = measure_spike_polar(
        vm_meas, sr, spike, polarity, kinetics_for_method(req.kinetics or {}, method),
    )
    if not m:
        raise HTTPException(status_code=400, detail="Could not measure spike at click point")
    m["sweep"] = int(req.sweep)
    m["spike_index"] = 0
    m["manual"] = True
    return m
