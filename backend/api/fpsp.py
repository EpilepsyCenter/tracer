"""Field PSP analysis — baseline / volley / fEPSP measurements per sweep
(or per N-sweep average), with slope computed on the rising phase.

Supports a second "LTP" series so the baseline (pre-tetanus) and LTP
(post-tetanus) recordings can be analysed and plotted together on the
same time axis. The `.pgf` carries an inter-sweep interval per
stimulation, which we report back so the frontend can draw real wall-
clock time on the over-time graph.

Returns one point per bin (a bin is ``avg_n`` consecutive sweeps averaged
together, non-overlapping). Each point carries its source series index
so the graph can keep baseline and LTP visually distinct.
"""

from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from api.files import get_current_recording
from utils.scaling import scaled
from readers.heka_native.pgf import PgfStimulation, PgfChannel
# Reuse the pre-detection filter helper from the burst module — same
# feature set (bandpass / lowpass / highpass, zero-phase Butterworth).
from analysis.bursts import _apply_pre_detection_filter

router = APIRouter()


def _stim_for_series(rec, group: int, series: int):
    """Find the PgfStimulation matching (group, series), or None."""
    from api.files import _pgf_data
    if _pgf_data is None:
        return None
    stim_idx = 0
    target = None
    for g in rec.groups:
        for s in g.series_list:
            if g.index == group and s.index == series:
                if stim_idx < len(_pgf_data.stimulations):
                    target = _pgf_data.stimulations[stim_idx]
            stim_idx += 1
    return target


# ---------------------------------------------------------------------------
# Stim-onset detection (shared with the I-V endpoint conceptually — kept
# inline for now; can be lifted to a utility if a third caller appears).
# ---------------------------------------------------------------------------

def _pick_stim_channel(stim: PgfStimulation) -> Optional[PgfChannel]:
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


def _interval_from_sweep_times(ser) -> float:
    """Sweep interval (s) from the sweeps' recorded start times — for
    files without a PatchMaster protocol (ABF, NWB). Median spacing, so a
    pause or a missing sweep doesn't skew it; 0 when unknown."""
    times = [sw.time for sw in getattr(ser, "sweeps", []) if sw.time is not None]
    if len(times) < 2:
        return 0.0
    d = np.diff(np.asarray(times, dtype=float))
    d = d[d > 0]
    return float(np.median(d)) if d.size else 0.0


def _detect_stim_onset_s(target: PgfStimulation) -> float:
    """Find the first non-trivial stim segment onset (seconds from sweep
    start) on the driving channel. Returns 0.0 if no pulse is found."""
    ch = _pick_stim_channel(target)
    if ch is None:
        return 0.0
    t = 0.0
    for seg in ch.segments:
        dur = seg.duration_at_sweep(0)
        level = seg.voltage_at_sweep(0)
        if abs(level) > 1e-9 and dur > 0:
            return float(t)
        t += dur
    return 0.0


# ---------------------------------------------------------------------------
# Peak finding, respecting the user's direction setting.
# ---------------------------------------------------------------------------

def _find_peak(seg: np.ndarray, baseline: float, direction: str) -> tuple[int, float]:
    """Return (index_in_segment, peak_value). `direction`:
       - 'auto'     → most-deviated sample (max |x − baseline|)
       - 'negative' → minimum sample
       - 'positive' → maximum sample
    """
    if len(seg) == 0:
        return 0, baseline
    if direction == "negative":
        i = int(np.argmin(seg))
    elif direction == "positive":
        i = int(np.argmax(seg))
    else:
        i = int(np.argmax(np.abs(seg - baseline)))
    return i, float(seg[i])


# ---------------------------------------------------------------------------
# Slope computation on the rising phase of a detected peak.
# ---------------------------------------------------------------------------

def _rising_phase_indices(
    seg: np.ndarray, peak_i: int, baseline: float, peak_val: float,
) -> Optional[tuple[int, int]]:
    """Locate the start (near baseline) and end (near peak) of the rising
    phase for slope fitting. Returns (i_start, i_peak) or None if unable
    to identify."""
    if peak_i <= 1:
        return None
    # Walk back from peak until the signal first reaches 10% of the
    # (peak − baseline) excursion. That's the rising-phase start.
    excursion = peak_val - baseline
    threshold = baseline + 0.10 * excursion  # signed
    # If excursion is negative, we want the last sample ABOVE threshold
    # (i.e. less negative); if positive, last sample BELOW threshold.
    i = peak_i
    if excursion > 0:
        while i > 0 and seg[i] > threshold:
            i -= 1
    elif excursion < 0:
        while i > 0 and seg[i] < threshold:
            i -= 1
    else:
        return None
    return (i, peak_i)


def _percent_crossing(
    seg: np.ndarray, i_start: int, i_end: int,
    baseline: float, peak_val: float, pct: float,
) -> Optional[int]:
    """Index between i_start and i_end where the signal first crosses
    ``pct%`` of the peak-above-baseline excursion. Returns None if not
    found."""
    if i_end <= i_start:
        return None
    excursion = peak_val - baseline
    target = baseline + (pct / 100.0) * excursion
    if excursion > 0:
        for i in range(i_start, i_end + 1):
            if seg[i] >= target:
                return i
    elif excursion < 0:
        for i in range(i_start, i_end + 1):
            if seg[i] <= target:
                return i
    return None


def _linear_slope(xs: np.ndarray, ys: np.ndarray) -> Optional[float]:
    """Ordinary-least-squares slope of y vs x. Returns None on singular
    or degenerate inputs."""
    n = len(xs)
    if n < 2:
        return None
    mx = float(np.mean(xs))
    my = float(np.mean(ys))
    denom = float(np.sum((xs - mx) ** 2))
    if denom <= 0:
        return None
    return float(np.sum((xs - mx) * (ys - my)) / denom)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.get("/run")
async def run_fpsp(
    group: int = Query(0),
    series: int = Query(0),
    trace: int = Query(0),
    series_b: Optional[int] = Query(None, description="Optional second (LTP) series in the same group"),
    baseline_start_s: float = Query(..., description="Baseline cursor start (s)"),
    baseline_end_s: float = Query(..., description="Baseline cursor end (s)"),
    volley_start_s: float = Query(..., description="Volley cursor start (s)"),
    volley_end_s: float = Query(..., description="Volley cursor end (s)"),
    fepsp_start_s: float = Query(..., description="fEPSP cursor start (s)"),
    fepsp_end_s: float = Query(..., description="fEPSP cursor end (s)"),
    method: str = Query("range_slope", description="amplitude | full_slope | range_slope"),
    slope_low_pct: float = Query(20.0),
    slope_high_pct: float = Query(80.0),
    peak_direction: str = Query("auto", description="auto | negative | positive"),
    avg_n: int = Query(1, description="Number of consecutive sweeps to average per bin"),
    sweeps: Optional[str] = Query(None, description="Comma-separated 0-based sweep indices restricted to `series`. None = all sweeps in both series."),
    exclude_b: Optional[str] = Query(None, description="Comma-separated 0-based sweeps of `series_b` to leave out (its excluded sweeps)."),
    filter_enabled: bool = Query(False, description="Apply a pre-detection filter to each sweep before averaging"),
    filter_type: str = Query("lowpass", description="lowpass | highpass | bandpass"),
    filter_low: float = Query(1.0, description="Low cutoff (Hz)"),
    filter_high: float = Query(1000.0, description="High cutoff (Hz)"),
    filter_order: int = Query(4, description="Butterworth filter order"),
):
    """Field PSP analysis across (optionally averaged) sweeps of one or two series."""
    rec = get_current_recording()

    try:
        grp = rec.groups[group]
        ser_a = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")
    ser_b = None
    if series_b is not None:
        try:
            ser_b = grp.series_list[series_b]
        except IndexError:
            raise HTTPException(status_code=400, detail="Invalid series_b index")

    # Sanity-check cursor windows.
    if baseline_end_s <= baseline_start_s:
        raise HTTPException(status_code=400, detail="Baseline cursor: end must exceed start")
    if volley_end_s <= volley_start_s:
        raise HTTPException(status_code=400, detail="Volley cursor: end must exceed start")
    if fepsp_end_s <= fepsp_start_s:
        raise HTTPException(status_code=400, detail="fEPSP cursor: end must exceed start")

    # Optional sweep subset — applies ONLY to `series` (primary) so users
    # can partial-run baseline while keeping the LTP series full.
    sweep_filter: Optional[set[int]] = None
    if sweeps is not None and sweeps.strip():
        try:
            sweep_filter = {int(x) for x in sweeps.split(",") if x.strip() != ""}
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid `sweeps` list")

    avg_n = max(1, int(avg_n))

    # Measurement config packaged so the inner loop stays compact.
    cfg = {
        "baseline_start_s": baseline_start_s,
        "baseline_end_s": baseline_end_s,
        "volley_start_s": volley_start_s,
        "volley_end_s": volley_end_s,
        "fepsp_start_s": fepsp_start_s,
        "fepsp_end_s": fepsp_end_s,
        "method": method,
        "slope_low_pct": slope_low_pct,
        "slope_high_pct": slope_high_pct,
        "peak_direction": peak_direction,
        "avg_n": avg_n,
        "trace": trace,
        # Pre-detection filter. Same param shape as bursts so we can reuse
        # `_apply_pre_detection_filter`.
        "filter_enabled": filter_enabled,
        "filter_type": filter_type,
        "filter_low": filter_low,
        "filter_high": filter_high,
        "filter_order": filter_order,
    }

    stim_a = _stim_for_series(rec, group, series)
    stim_onset_s_a = _detect_stim_onset_s(stim_a) if stim_a else 0.0
    sweep_interval_a = float(stim_a.sweep_interval) if stim_a and stim_a.sweep_interval else 0.0
    if sweep_interval_a <= 0:
        sweep_interval_a = _interval_from_sweep_times(ser_a)

    points_a, unit_a, flagged_a = _run_on_series(ser_a, series, sweep_filter, cfg)

    points_b = []
    unit_b = ""
    flagged_b = 0
    stim_onset_s_b = 0.0
    sweep_interval_b = 0.0
    if ser_b is not None and series_b is not None:
        stim_b = _stim_for_series(rec, group, series_b)
        stim_onset_s_b = _detect_stim_onset_s(stim_b) if stim_b else 0.0
        sweep_interval_b = float(stim_b.sweep_interval) if stim_b and stim_b.sweep_interval else 0.0
        if sweep_interval_b <= 0:
            sweep_interval_b = _interval_from_sweep_times(ser_b)
        # The user's sweep range is typed for A; B uses all its sweeps
        # except the ones excluded on B.
        filter_b = None
        if exclude_b:
            try:
                ex_b = {int(x) for x in exclude_b.split(",") if x.strip() != ""}
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid `exclude_b` list")
            filter_b = {i for i in range(ser_b.sweep_count) if i not in ex_b}
        points_b, unit_b, flagged_b = _run_on_series(ser_b, series_b, filter_b, cfg)

    return {
        "points": points_a + points_b,
        "stim_onset_s": stim_onset_s_a,
        "stim_onset_s_b": stim_onset_s_b if ser_b else None,
        "sweep_interval_s": sweep_interval_a,
        "sweep_interval_s_b": sweep_interval_b if ser_b else None,
        "response_unit": unit_a or unit_b,
        "flagged_count": flagged_a + flagged_b,
        "avg_n": avg_n,
        "series_a": series,
        "series_b": series_b,
    }


def _run_on_series(
    ser, series_index: int, sweep_filter: Optional[set[int]], cfg: dict,
) -> tuple[list[dict], str, int]:
    """Run the fPSP measurement loop across one series' sweeps, binning
    every cfg['avg_n'] consecutive ones. Returns (points, response_unit,
    flagged_count). Each point is tagged with its source series index."""
    trace = cfg["trace"]
    avg_n = cfg["avg_n"]
    baseline_start_s = cfg["baseline_start_s"]
    baseline_end_s = cfg["baseline_end_s"]
    volley_start_s = cfg["volley_start_s"]
    volley_end_s = cfg["volley_end_s"]
    fepsp_start_s = cfg["fepsp_start_s"]
    fepsp_end_s = cfg["fepsp_end_s"]
    method = cfg["method"]
    slope_low_pct = cfg["slope_low_pct"]
    slope_high_pct = cfg["slope_high_pct"]
    peak_direction = cfg["peak_direction"]

    sweep_order = [
        i for i in range(ser.sweep_count)
        if (sweep_filter is None or i in sweep_filter)
    ]
    if not sweep_order:
        return [], "", 0

    points: list[dict] = []
    response_unit = ""
    flagged_count = 0

    for bin_i, bin_start in enumerate(range(0, len(sweep_order), avg_n)):
        group_sw = sweep_order[bin_start:bin_start + avg_n]
        if not group_sw:
            continue

        arrays: list[np.ndarray] = []
        sr = 0.0
        for sw_idx in group_sw:
            sw = ser.sweeps[sw_idx]
            if trace >= sw.trace_count:
                continue
            tr = sw.traces[trace]
            # Filter each sweep BEFORE averaging so sweep-to-sweep noise
            # still cancels out across the average (filtering the mean
            # would be mathematically equivalent but loses this property
            # if the filter is nonlinear-ish at the edges). Helper reads
            # the same cfg keys bursts.py's endpoint uses.
            data_arr = _apply_pre_detection_filter(scaled(tr), tr.sampling_rate, cfg)
            arrays.append(data_arr)
            sr = tr.sampling_rate
            response_unit = tr.units
        if not arrays or sr <= 0:
            continue
        n_min = min(len(a) for a in arrays)
        stacked = np.stack([a[:n_min] for a in arrays], axis=0)
        avg = np.mean(stacked, axis=0)

        b0 = max(0, int(baseline_start_s * sr))
        b1 = min(len(avg), int(baseline_end_s * sr))
        if b1 <= b0:
            continue
        baseline = float(np.mean(avg[b0:b1]))

        v0 = max(0, int(volley_start_s * sr))
        v1 = min(len(avg), int(volley_end_s * sr))
        if v1 <= v0:
            continue
        vseg = avg[v0:v1]
        vi, volley_peak = _find_peak(vseg, baseline, peak_direction)
        volley_peak_t_s = (v0 + vi) / sr
        volley_amp = volley_peak - baseline

        f0 = max(0, int(fepsp_start_s * sr))
        f1 = min(len(avg), int(fepsp_end_s * sr))
        if f1 <= f0:
            continue
        fseg = avg[f0:f1]
        fi, fepsp_peak = _find_peak(fseg, baseline, peak_direction)
        fepsp_peak_t_s = (f0 + fi) / sr
        fepsp_amp = fepsp_peak - baseline

        slope_value: Optional[float] = None
        slope_low_point = None
        slope_high_point = None
        if method != "amplitude":
            phase = _rising_phase_indices(fseg, fi, baseline, fepsp_peak)
            if phase is not None:
                i_start, i_peak = phase
                if method == "full_slope":
                    lo, hi = i_start, i_peak
                else:
                    lo_i = _percent_crossing(fseg, i_start, i_peak, baseline, fepsp_peak, slope_low_pct)
                    hi_i = _percent_crossing(fseg, i_start, i_peak, baseline, fepsp_peak, slope_high_pct)
                    if lo_i is None or hi_i is None or hi_i <= lo_i:
                        lo, hi = None, None
                    else:
                        lo, hi = lo_i, hi_i
                if lo is not None and hi is not None and hi > lo:
                    xs = np.arange(lo, hi + 1) / sr
                    ys = fseg[lo:hi + 1]
                    slope_value = _linear_slope(xs, ys)
                    slope_low_point = {"t": float((f0 + lo) / sr), "v": float(fseg[lo])}
                    slope_high_point = {"t": float((f0 + hi) / sr), "v": float(fseg[hi])}

        ratio: Optional[float] = None
        flagged = False
        if abs(volley_amp) > 1e-12:
            ratio = abs(fepsp_amp) / abs(volley_amp)
            if ratio < 3.0:
                flagged = True
                flagged_count += 1

        mean_sweep_idx = float(np.mean(group_sw))
        points.append({
            "source_series": int(series_index),
            "bin_index": bin_i,
            "sweep_indices": [int(s) for s in group_sw],
            "mean_sweep_index": mean_sweep_idx,
            "baseline": baseline,
            "volley_peak": volley_peak,
            "volley_peak_t_s": volley_peak_t_s,
            "volley_amp": volley_amp,
            "fepsp_peak": fepsp_peak,
            "fepsp_peak_t_s": fepsp_peak_t_s,
            "fepsp_amp": fepsp_amp,
            "slope": slope_value,
            "slope_low_point": slope_low_point,
            "slope_high_point": slope_high_point,
            "ratio": ratio,
            "flagged": flagged,
        })
    return points, response_unit, flagged_count


@router.get("/bin_waveform")
async def bin_waveform(
    group: int = Query(0),
    series: int = Query(0),
    trace: int = Query(0),
    sweeps: str = Query(..., description="Comma-separated 0-based sweep indices to average"),
    t_start: float = Query(0.0),
    t_end: float = Query(0.0),
    max_points: int = Query(4000),
    # Optional filter applied per-sweep before averaging — must match what
    # /run used so the mini-viewer shows the signal measurements were
    # computed on.
    filter_enabled: bool = Query(False),
    filter_type: str = Query("lowpass"),
    filter_low: float = Query(1.0),
    filter_high: float = Query(1000.0),
    filter_order: int = Query(4),
):
    """Return the averaged waveform across ``sweeps`` of the given
    (group, series, trace), sliced to [t_start, t_end] and decimated to
    at most ``max_points`` samples. Used by the fPSP mini-viewer so the
    user sees the exact signal the measurements were computed on."""
    rec = get_current_recording()
    try:
        grp = rec.groups[group]
        ser = grp.series_list[series]
    except IndexError:
        raise HTTPException(status_code=400, detail="Invalid group/series index")

    sw_list: list[int] = []
    try:
        sw_list = [int(x) for x in sweeps.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid sweeps list")
    if not sw_list:
        return {"time": [], "values": [], "sampling_rate": 0.0, "units": ""}

    filt_cfg = {
        "filter_enabled": filter_enabled,
        "filter_type": filter_type,
        "filter_low": filter_low,
        "filter_high": filter_high,
        "filter_order": filter_order,
    }
    arrays: list[np.ndarray] = []
    sr = 0.0
    units = ""
    for sw_idx in sw_list:
        if sw_idx < 0 or sw_idx >= ser.sweep_count:
            continue
        sw = ser.sweeps[sw_idx]
        if trace >= sw.trace_count:
            continue
        tr = sw.traces[trace]
        data_arr = _apply_pre_detection_filter(scaled(tr), tr.sampling_rate, filt_cfg)
        arrays.append(data_arr)
        sr = tr.sampling_rate
        units = tr.units
    if not arrays or sr <= 0:
        return {"time": [], "values": [], "sampling_rate": 0.0, "units": units}

    n_min = min(len(a) for a in arrays)
    avg = np.mean(np.stack([a[:n_min] for a in arrays], axis=0), axis=0)

    # Slice to [t_start, t_end] (end <= start means "entire sweep").
    if t_end > t_start:
        i0 = max(0, int(t_start * sr))
        i1 = min(len(avg), int(t_end * sr) + 1)
        avg = avg[i0:i1]
        t0 = i0 / sr
    else:
        t0 = 0.0

    # Decimate via LTTB for display.
    from utils.downsampling import lttb_downsample
    time = t0 + np.arange(len(avg)) / sr
    if max_points > 0 and len(avg) > max_points:
        time, avg = lttb_downsample(time, avg, max_points)

    return {
        "time": time.tolist(),
        "values": avg.tolist(),
        "sampling_rate": sr,
        "units": units,
    }
