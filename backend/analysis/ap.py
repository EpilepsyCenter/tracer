"""Action Potentials analysis — detection + counting + per-spike kinetics.

Two analyses live under one detection stage:

1. **Counting** — spike count per sweep, ISI-derived metrics
   (mean ISI, SFA divisor, Shinomoto local variance), first-spike
   latency, F-I curve across sweeps, rheobase.

2. **Kinetics** — per-spike measurements (threshold, peak, amplitude,
   rise/decay, FWHM, fAHP, mAHP, max rise/decay slopes). Eight
   threshold-detection methods are implemented (first-derivative
   cutoff/max, third-derivative cutoff/max, Sekerli I/II, leading
   inflection, max curvature) so the user can match how their
   preferred software (Easy Electrophysiology, Clampfit, etc.) reports
   spike threshold.

The phase-plot view is just a slice around one spike's peak with the
same dV/dt axis — computed on demand by ``api/ap.py``.

Manual-edit replay: ``run_ap`` accepts a ``manual_edits`` dict with
``added`` and ``removed`` peak timestamps per sweep. The auto-detection
runs first, then removed timestamps drop nearby auto peaks (within
``min_distance_ms``) and added timestamps are inserted (snapping to the
nearest local Vm max within ``min_distance_ms / 2``). Each output
spike carries a ``manual: bool`` flag for the UI's marker styling.

All public-domain math; no code ported from copyleft sources.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

# Reuse the burst module's filter helper — same shape/semantics as
# every other "pre-detection filter" in the app.
from analysis.bursts import _apply_pre_detection_filter, detect_threshold_epochs


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

@dataclass
class _Spike:
    """Detected spike, in sample-index space within the sweep."""
    onset_idx: int      # rough start (first sample where +dV/dt > pos_dvdt)
    peak_idx: int       # absolute peak (max Vm) between onset and fall
    fall_idx: int       # first sample after peak where dV/dt < neg_dvdt
    peak_vm: float
    manual: bool = False


def _detect_spikes_sweep(
    vm: np.ndarray,
    sr: float,
    *,
    method: str,
    manual_threshold_mv: float,
    min_amplitude_mv: float,
    pos_dvdt_mv_ms: float,
    neg_dvdt_mv_ms: float,
    width_ms: float,
    min_distance_ms: float,
    bounds_start_s: float,
    bounds_end_s: float,
) -> list[_Spike]:
    """Detect APs in a single sweep.

    Two algorithms share the rejection/merge stages:

    - ``manual``: an upward crossing of ``manual_threshold_mv`` followed
      within ``width_ms`` by a downward crossing back through it. Peak
      = argmax between the two crossings.
    - ``auto_rec``/``auto_spike``: detect candidates by +dV/dt crossing
      ``pos_dvdt_mv_ms``, search forward up to ``width_ms`` for a -dV/dt
      sample below ``neg_dvdt_mv_ms``, peak = argmax(Vm) between them.
      ``auto_rec`` then re-runs the search using a per-sweep adaptive
      threshold = (median(peak_vm) + median(threshold_vm)) / 2 — useful
      when spike heights vary or when noise causes false +dV/dt
      triggers; ``auto_spike`` skips that second pass for speed.
    """
    if vm.size == 0 or sr <= 0:
        return []

    # Restrict everything to the analysis window. Indexing is inclusive
    # of bounds_start, exclusive of bounds_end — same convention as the
    # rest of the codebase.
    i0 = max(0, int(round(bounds_start_s * sr)))
    i1 = min(vm.size, int(round(bounds_end_s * sr))) if bounds_end_s > 0 else vm.size
    if i1 <= i0 + 2:
        return []

    seg = vm[i0:i1]
    dt_ms = 1000.0 / sr
    width_samples = max(1, int(round(width_ms / dt_ms)))
    min_dist_samples = max(1, int(round(min_distance_ms / dt_ms)))

    spikes: list[_Spike] = []

    if method == "manual":
        thr = float(manual_threshold_mv)
        # Find all upward crossings of `thr`.
        above = seg >= thr
        # crossings_up: True at sample i where seg[i] >= thr and seg[i-1] < thr
        crossings = np.flatnonzero(above[1:] & ~above[:-1]) + 1
        for c in crossings:
            # Look forward up to width_samples for the matching downward
            # crossing back through `thr`.
            window_end = min(seg.size, c + width_samples + 1)
            search = seg[c:window_end]
            below_idx_rel = np.argmax(search < thr) if (search < thr).any() else -1
            if below_idx_rel <= 0:
                continue
            fall = c + int(below_idx_rel)
            peak_rel = c + int(np.argmax(seg[c:fall + 1]))
            spikes.append(_Spike(
                onset_idx=int(i0 + c),
                peak_idx=int(i0 + peak_rel),
                fall_idx=int(i0 + fall),
                peak_vm=float(seg[peak_rel]),
            ))
    else:
        # Auto detection — dV/dt-based.
        # gradient returns mV per sample; multiply by sr/1000 to get
        # mV per ms (samples per ms = sr / 1000).
        dvdt = np.gradient(seg) * (sr / 1000.0)
        pos = dvdt >= pos_dvdt_mv_ms
        neg = dvdt <= neg_dvdt_mv_ms

        # Candidate onsets: rising edges of `pos`. We don't want every
        # sample above threshold — just the first one in each contiguous
        # run, otherwise a single AP fires multiple candidates.
        rising = np.flatnonzero(pos[1:] & ~pos[:-1]) + 1
        if pos[0]:
            rising = np.r_[0, rising]

        for c in rising:
            window_end = min(seg.size, c + width_samples + 1)
            fall_search = neg[c:window_end]
            if not fall_search.any():
                continue
            fall = c + int(np.argmax(fall_search))
            peak_rel = c + int(np.argmax(seg[c:fall + 1]))
            # Reject low-amplitude deflections (noise wiggles that
            # crossed +dV/dt but never developed into a real spike).
            local_baseline = float(np.median(seg[max(0, c - width_samples):c + 1]))
            if (seg[peak_rel] - local_baseline) < min_amplitude_mv:
                continue
            spikes.append(_Spike(
                onset_idx=int(i0 + c),
                peak_idx=int(i0 + peak_rel),
                fall_idx=int(i0 + fall),
                peak_vm=float(seg[peak_rel]),
            ))

    # Merge peaks closer than min_distance_ms. Keep the highest.
    if len(spikes) > 1:
        spikes.sort(key=lambda s: s.peak_idx)
        merged: list[_Spike] = [spikes[0]]
        for s in spikes[1:]:
            if s.peak_idx - merged[-1].peak_idx < min_dist_samples:
                if s.peak_vm > merged[-1].peak_vm:
                    merged[-1] = s
            else:
                merged.append(s)
        spikes = merged

    # auto_rec second pass: adaptive level threshold from the spikes
    # found so far. Cheap, helps on traces where the first-pass dV/dt
    # cutoff missed lower-amplitude follow-on spikes (adaptation).
    if method == "auto_rec" and len(spikes) >= 2:
        peak_vms = np.array([s.peak_vm for s in spikes])
        # Crude per-spike threshold: foot of the spike (sample where
        # dV/dt first crossed pos_dvdt above onset). Use vm[onset_idx].
        thr_vms = np.array([float(vm[s.onset_idx]) for s in spikes])
        adaptive_thr = float((np.median(peak_vms) + np.median(thr_vms)) / 2.0)
        # Re-detect with adaptive level threshold.
        return _detect_spikes_sweep(
            vm, sr,
            method="manual",
            manual_threshold_mv=adaptive_thr,
            min_amplitude_mv=min_amplitude_mv,
            pos_dvdt_mv_ms=pos_dvdt_mv_ms,
            neg_dvdt_mv_ms=neg_dvdt_mv_ms,
            width_ms=width_ms,
            min_distance_ms=min_distance_ms,
            bounds_start_s=bounds_start_s,
            bounds_end_s=bounds_end_s,
        )

    return spikes


def _detect_spikes_noise_threshold(
    vm: np.ndarray,
    sr: float,
    *,
    detection: dict,
    bounds_start_s: float,
    bounds_end_s: float,
) -> tuple[list[_Spike], int]:
    """Noise-relative threshold detection ("Threshold (noise-relative)").

    Runs the Burst window's threshold detector (``detect_threshold_epochs``)
    on the analysis window — same baseline modes, noise estimators,
    smoothing, min duration and min gap — and turns each detected epoch
    into one spike at its most extreme sample. ``vm`` is expected to be
    pre-filtered already (``run_ap`` applies the pre-detection filter to
    the whole sweep), so the detector's own filter is switched off.

    Spike polarity comes from ``peak_direction``: ``positive`` /
    ``negative``, or ``auto`` = the sign of the median epoch extreme,
    decided once per sweep so every spike is measured the same way.
    The detector itself works on the rectified signal, so it also finds
    deflections the other way; an epoch whose largest deviation points
    against the polarity is dropped (with *positive* peaks, a downward-
    only event is not a spike).
    Returns ``(spikes, polarity, lines)`` with polarity ``+1`` or ``-1``
    and ``lines`` the detector's baseline / threshold for the viewer
    (see ``_detection_lines``), or None when nothing could be run.
    """
    if vm.size == 0 or sr <= 0:
        return [], 1, None
    i0 = max(0, int(round(bounds_start_s * sr)))
    i1 = min(vm.size, int(round(bounds_end_s * sr))) if bounds_end_s > 0 else vm.size
    if i1 <= i0 + 2:
        return [], 1, None
    seg = vm[i0:i1]
    params = dict(detection)
    params["filter_enabled"] = False
    det = detect_threshold_epochs(seg, sr, params)
    epochs = det["epochs"]
    dev = det["detrended"] - det["baseline_value"]

    # Signed extreme (largest |deviation|) of each epoch.
    extremes: list[float] = []
    for ep in epochs:
        w = dev[ep["start_idx"]:ep["end_idx"]]
        extremes.append(float(w[int(np.argmax(np.abs(w)))]) if w.size else 0.0)

    direction = str(detection.get("peak_direction", "auto")).lower()
    if direction == "positive":
        polarity = 1
    elif direction == "negative":
        polarity = -1
    else:
        polarity = -1 if extremes and float(np.median(extremes)) < 0 else 1
    lines = _detection_lines(seg, det, sr, i0 / sr, polarity)

    spikes: list[_Spike] = []
    for ep, ext in zip(epochs, extremes):
        a, b = ep["start_idx"], ep["end_idx"]
        if b <= a:
            continue
        # Opposite-direction event — not a spike of this polarity.
        if ext * polarity <= 0:
            continue
        rel = int(np.argmax(polarity * dev[a:b]))
        peak = i0 + a + rel
        spikes.append(_Spike(
            onset_idx=int(i0 + a),
            peak_idx=int(peak),
            fall_idx=int(i0 + b - 1),
            peak_vm=float(vm[peak]),
        ))
    return spikes, polarity, lines


# Most points sent for a rolling-baseline curve (one sweep).
_LINE_MAX_POINTS = 5000


def _detection_lines(seg: np.ndarray, det: dict, sr: float, t0: float, polarity: int) -> dict:
    """Baseline and threshold of a noise-relative run, for drawing on the
    viewer (same idea as the Burst window's baseline / threshold lines).

    Values are in the frame the detector saw (the pre-filtered trace).
    ``threshold`` is the distance from the baseline (``n × noise``); the
    detector applies it to the smoothed |signal − baseline|, so the line
    is a guide, not an exact per-sample criterion. With a rolling
    baseline the baseline is a curve: ``curve`` holds it on a uniform
    grid (``t0``, ``dt``) decimated to at most ``_LINE_MAX_POINTS``.
    """
    out = {
        "baseline_mode": str(det.get("baseline_mode", "percentile")),
        "baseline": float(det["baseline_value"]),
        "threshold": float(det["threshold_value"]),
        "noise": float(det["noise_value"]),
        "polarity": int(polarity),
        "t_start_s": float(t0),
        "t_end_s": float(t0 + seg.size / sr),
        "curve": None,
    }
    if out["baseline_mode"] == "rolling":
        rolling = det["filtered"] - det["detrended"]
        step = max(1, int(np.ceil(rolling.size / _LINE_MAX_POINTS)))
        out["curve"] = {
            "t0": float(t0),
            "dt": float(step / sr),
            "v": [round(float(x), 6) for x in rolling[::step]],
        }
    return out


def _snap_peaks(
    spikes: list[_Spike], vm: np.ndarray, sr: float, polarity: int, snap_ms: float,
) -> list[_Spike]:
    """Move each spike's peak to the most extreme sample of ``vm`` within
    ±``snap_ms``. Used after noise-relative detection so the peak sits on
    the unfiltered trace (a band-pass smears and shifts a 1 ms spike)."""
    w = max(1, int(round(snap_ms * sr / 1000.0)))
    out: list[_Spike] = []
    for sp in spikes:
        lo = max(0, sp.peak_idx - w)
        hi = min(vm.size, sp.peak_idx + w + 1)
        if hi <= lo:
            out.append(sp)
            continue
        pk = lo + int(np.argmax(polarity * vm[lo:hi]))
        out.append(_Spike(
            onset_idx=min(sp.onset_idx, pk), peak_idx=pk,
            fall_idx=max(sp.fall_idx, pk),
            peak_vm=float(vm[pk]), manual=sp.manual,
        ))
    # Two epochs can snap onto the same sample — keep one.
    out.sort(key=lambda s: s.peak_idx)
    dedup: list[_Spike] = []
    for sp in out:
        if dedup and sp.peak_idx == dedup[-1].peak_idx:
            continue
        dedup.append(sp)
    return dedup


def _apply_manual_edits_to_sweep(
    spikes: list[_Spike],
    vm: np.ndarray,
    sr: float,
    added_t_s: list[float],
    removed_t_s: list[float],
    min_distance_ms: float,
    polarity: int = 1,
) -> list[_Spike]:
    """Replay manual additions / removals on top of an auto-detected
    spike list. See module docstring."""
    dt_ms = 1000.0 / sr
    tol_samples = max(1, int(round(min_distance_ms / dt_ms)))

    # 1. Drop auto-detected spikes near any removed timestamp.
    if removed_t_s:
        removed_idx = [int(round(t * sr)) for t in removed_t_s]
        kept: list[_Spike] = []
        for s in spikes:
            if any(abs(s.peak_idx - r) <= tol_samples for r in removed_idx):
                continue
            kept.append(s)
        spikes = kept

    # 2. Insert manual additions, snapping each to the nearest local
    # Vm max within ±(min_distance_ms / 2) — protects against a click
    # that landed slightly off the actual peak.
    snap = max(1, int(round((min_distance_ms / 2) / dt_ms)))
    for t in added_t_s:
        click_idx = int(round(t * sr))
        # Skip if too close to an existing (auto- or already-added) spike.
        if any(abs(click_idx - s.peak_idx) <= tol_samples for s in spikes):
            continue
        i0 = max(0, click_idx - snap)
        i1 = min(vm.size, click_idx + snap + 1)
        if i1 <= i0:
            continue
        seg = vm[i0:i1]
        peak_rel = int(np.argmax(polarity * seg))
        peak_idx = i0 + peak_rel
        spikes.append(_Spike(
            onset_idx=peak_idx, peak_idx=peak_idx, fall_idx=peak_idx,
            peak_vm=float(vm[peak_idx]),
            manual=True,
        ))

    spikes.sort(key=lambda s: s.peak_idx)
    return spikes


# ---------------------------------------------------------------------------
# Per-spike kinetics
# ---------------------------------------------------------------------------

def _interp_to_200khz(vm: np.ndarray, sr: float) -> tuple[np.ndarray, float]:
    """Cubic-spline-style upsample to 200 kHz for finer rise/decay /
    FWHM measurements. Falls back to the original signal when sr is
    already at or above the target. Returns (vm_interp, sr_interp)."""
    target_sr = 200_000.0
    if sr >= target_sr or vm.size < 4:
        return vm, sr
    factor = int(round(target_sr / sr))
    if factor < 2:
        return vm, sr
    n = vm.size
    x_old = np.arange(n)
    x_new = np.linspace(0, n - 1, n * factor)
    # Use np.interp (linear) — fast and good enough for measuring
    # crossings on short windows. Cubic was overkill here; the dV/dt
    # quantities we measure are computed on the ORIGINAL signal, only
    # the % crossing times use this upsampled track.
    vm_new = np.interp(x_new, x_old, vm)
    return vm_new, sr * factor


def _threshold_idx(
    vm: np.ndarray, dvdt: np.ndarray, sr: float,
    *,
    onset: int, peak: int,
    method: str,
    cutoff_mv_ms: float,
    sekerli_lower_bound_mv_ms: float,
) -> int:
    """Find the index (in vm/dvdt space) of the AP's threshold, using
    the user-selected method. Returns an index relative to the input
    arrays (full sweep), guaranteed to be in ``[max(0, onset-window),
    peak]``. Falls back to ``onset`` if the method yields nothing.
    """
    # All methods search a small window before the peak. Limit the
    # window to ``threshold_search_ms_before_peak`` worth of samples
    # so we don't pick up unrelated wiggles further back.
    search_lo = max(0, onset - 1)
    search_hi = max(search_lo + 2, peak + 1)
    seg_v = vm[search_lo:search_hi]
    seg_d = dvdt[search_lo:search_hi]
    if seg_v.size < 2:
        return onset

    def _to_full(rel: int) -> int:
        return int(np.clip(search_lo + rel, search_lo, search_hi - 1))

    if method == "first_deriv_cutoff":
        candidates = np.flatnonzero(seg_d >= cutoff_mv_ms)
        return _to_full(int(candidates[0]) if candidates.size else 0)

    if method == "first_deriv_max":
        return _to_full(int(np.argmax(seg_d)))

    # The third-derivative variants need 2 more numpy.diff steps.
    if method in ("third_deriv_max", "third_deriv_cutoff"):
        d3 = np.gradient(np.gradient(seg_d)) * (sr / 1000.0) ** 2
        if method == "third_deriv_max":
            return _to_full(int(np.argmax(d3)))
        candidates = np.flatnonzero(d3 >= cutoff_mv_ms)
        return _to_full(int(candidates[0]) if candidates.size else int(np.argmax(d3)))

    if method in ("sekerli_I", "sekerli_II"):
        # Mask: skip samples where dV/dt is too low to give a stable
        # ratio (avoids division-by-near-zero artifacts in the formula).
        d2 = np.gradient(seg_d) * (sr / 1000.0)
        mask = seg_d > sekerli_lower_bound_mv_ms
        if not mask.any():
            return _to_full(int(np.argmax(seg_d)))
        if method == "sekerli_I":
            ratio = np.where(mask, d2 / np.where(seg_d == 0, np.inf, seg_d), -np.inf)
        else:
            d3 = np.gradient(d2) * (sr / 1000.0)
            num = d3 * seg_d - d2 ** 2
            den = np.where(seg_d == 0, np.inf, seg_d ** 3)
            ratio = np.where(mask, num / den, -np.inf)
        return _to_full(int(np.argmax(ratio)))

    if method == "leading_inflection":
        # Most-negative (lowest dV/dt) just before the foot of the spike.
        return _to_full(int(np.argmin(seg_d)))

    if method == "max_curvature":
        # Rossokhin & Saakian 1992: κ = d²V / (1 + dV²)^(3/2)
        d2 = np.gradient(seg_d) * (sr / 1000.0)
        kappa = d2 / np.power(1.0 + seg_d ** 2, 1.5)
        return _to_full(int(np.argmax(kappa)))

    return onset


def _measure_spike(
    vm: np.ndarray, sr: float,
    spike: _Spike,
    *,
    threshold_method: str,
    threshold_cutoff_mv_ms: float,
    threshold_search_ms_before_peak: float,
    sekerli_lower_bound_mv_ms: float,
    rise_low_pct: float, rise_high_pct: float,
    decay_low_pct: float, decay_high_pct: float,
    decay_end: str,
    fahp_search_start_ms: float, fahp_search_end_ms: float,
    mahp_search_start_ms: float, mahp_search_end_ms: float,
    max_slope_window_ms: float,
    interpolate: bool,
    amplitude_ref: str = "threshold",
    baseline_window_ms: float = 10.0,
    dvdt: Optional[np.ndarray] = None,
) -> dict:
    """Compute every per-spike kinetic quantity for one spike. Indexes
    into ``vm`` are absolute (sweep-wide). All time quantities are
    returned in seconds.

    ``amplitude_ref`` picks what amplitude, rise, FWHM and decay are
    measured from:
      - ``threshold`` — the AP threshold found by ``threshold_method``
        (classic whole-cell APs).
      - ``baseline`` — the local pre-spike baseline: the median of the
        ``baseline_window_ms`` just before the search window (which
        starts ``threshold_search_ms_before_peak`` before the peak). The
        spike's onset is the last baseline crossing before the peak.
        Used by noise-relative detection, where spikes may be action
        currents or extracellular units with no voltage threshold. The
        returned ``threshold_vm`` / ``threshold_t_s`` then hold that
        baseline level and the onset time.

    ``dvdt`` may be passed in pre-computed (``np.gradient(vm) · sr/1000``)
    so a sweep with thousands of spikes doesn't recompute the
    derivative of the whole trace once per spike."""
    if vm.size == 0 or sr <= 0:
        return {}

    dt_ms = 1000.0 / sr

    # Threshold-search window — N ms before peak, capped at sweep start.
    search_samples = max(1, int(round(threshold_search_ms_before_peak / dt_ms)))
    onset_for_thr = max(0, spike.peak_idx - search_samples)

    if dvdt is None or dvdt.size != vm.size:
        dvdt = np.gradient(vm) * (sr / 1000.0)  # mV/ms

    peak_vm = float(vm[spike.peak_idx])
    if amplitude_ref == "baseline":
        bw = max(1, int(round(baseline_window_ms / dt_ms)))
        b0 = max(0, onset_for_thr - bw)
        base_seg = vm[b0:onset_for_thr]
        threshold_vm = float(np.median(base_seg)) if base_seg.size else float(vm[onset_for_thr])
        # Onset = last sample at or below the baseline before the peak.
        rise_win = vm[onset_for_thr:spike.peak_idx + 1]
        below = np.flatnonzero(rise_win <= threshold_vm)
        thr_idx = onset_for_thr + (int(below[-1]) if below.size else int(np.argmin(rise_win)))
    else:
        thr_idx = _threshold_idx(
            vm, dvdt, sr,
            onset=onset_for_thr,
            peak=spike.peak_idx,
            method=threshold_method,
            cutoff_mv_ms=threshold_cutoff_mv_ms,
            sekerli_lower_bound_mv_ms=sekerli_lower_bound_mv_ms,
        )
        threshold_vm = float(vm[thr_idx])
    amplitude = peak_vm - threshold_vm

    # Optionally upsample the rising-and-decay slice for precise %
    # crossing times. We measure on the upsampled track but report
    # times in seconds in the ORIGINAL clock.
    decay_search_ms = max(fahp_search_end_ms, mahp_search_end_ms, 50.0)
    decay_end_idx = min(vm.size, spike.peak_idx + int(round(decay_search_ms / dt_ms)))
    rise_seg = vm[thr_idx:spike.peak_idx + 1]
    decay_seg = vm[spike.peak_idx:decay_end_idx]
    rise_seg_i, sr_i = (rise_seg, sr)
    decay_seg_i, _ = (decay_seg, sr)
    if interpolate:
        rise_seg_i, sr_i = _interp_to_200khz(rise_seg, sr)
        decay_seg_i, _ = _interp_to_200khz(decay_seg, sr)

    def _crossing_t_in_seg(seg: np.ndarray, target: float, sr_seg: float) -> Optional[float]:
        """Index (interpolated) of the first crossing of ``target``,
        searching forward. Returns time in seconds from the seg start."""
        if seg.size < 2:
            return None
        # First sample where seg crosses target (works for either
        # direction of crossing — find first sign change).
        sign = np.sign(seg - target)
        # np.diff catches transitions including 0→±. argmax of nonzero
        # is the first transition. If never crosses, return None.
        diff = np.diff(sign)
        idx = np.flatnonzero(diff != 0)
        if idx.size == 0:
            return None
        i = int(idx[0])
        v0, v1 = float(seg[i]), float(seg[i + 1])
        # Linear interpolate the exact crossing within [i, i+1].
        if v1 == v0:
            frac = 0.0
        else:
            frac = (target - v0) / (v1 - v0)
        return (i + frac) / sr_seg

    rise_lo_t = _crossing_t_in_seg(rise_seg_i, threshold_vm + amplitude * rise_low_pct / 100.0, sr_i)
    rise_hi_t = _crossing_t_in_seg(rise_seg_i, threshold_vm + amplitude * rise_high_pct / 100.0, sr_i)
    rise_time_s = (rise_hi_t - rise_lo_t) if (rise_lo_t is not None and rise_hi_t is not None) else None

    # Decay end: choose the floor relative to which % crossings are computed.
    if decay_end == "to_fahp":
        # Use the lowest Vm in the fAHP window.
        fahp_lo = max(spike.peak_idx, spike.peak_idx + int(round(fahp_search_start_ms / dt_ms)))
        fahp_hi = min(vm.size, spike.peak_idx + int(round(fahp_search_end_ms / dt_ms)) + 1)
        if fahp_hi > fahp_lo:
            floor_vm = float(np.min(vm[fahp_lo:fahp_hi]))
        else:
            floor_vm = threshold_vm
    else:
        floor_vm = threshold_vm
    decay_amp = peak_vm - floor_vm

    decay_hi_t = _crossing_t_in_seg(decay_seg_i, peak_vm - decay_amp * decay_high_pct / 100.0, sr_i)
    decay_lo_t = _crossing_t_in_seg(decay_seg_i, peak_vm - decay_amp * decay_low_pct / 100.0, sr_i)
    # ``decay_lo_t`` = drop by ``decay_low_pct`` of the amplitude (near the
    # peak, crossed first); ``decay_hi_t`` = drop by ``decay_high_pct``
    # (crossed later). Decay time is the interval between them.
    decay_time_s = (decay_hi_t - decay_lo_t) if (decay_hi_t is not None and decay_lo_t is not None) else None

    # Half-width: measure at amplitude/2 above threshold, both rising and falling.
    half_target = threshold_vm + amplitude / 2.0
    rise_half = _crossing_t_in_seg(rise_seg_i, half_target, sr_i)
    fall_half = _crossing_t_in_seg(decay_seg_i, half_target, sr_i)
    if rise_half is not None and fall_half is not None:
        half_rise_t = thr_idx / sr + rise_half
        half_fall_t = spike.peak_idx / sr + fall_half
        half_width_s = half_fall_t - half_rise_t
    else:
        half_rise_t = half_fall_t = None
        half_width_s = None

    # AHP windows.
    def _min_in_window(start_ms: float, end_ms: float) -> tuple[Optional[float], Optional[float]]:
        i0 = spike.peak_idx + int(round(start_ms / dt_ms))
        i1 = spike.peak_idx + int(round(end_ms / dt_ms)) + 1
        i0 = max(0, i0); i1 = min(vm.size, i1)
        if i1 <= i0:
            return None, None
        local = vm[i0:i1]
        rel = int(np.argmin(local))
        return float(local[rel]), (i0 + rel) / sr

    fahp_vm, fahp_t = _min_in_window(fahp_search_start_ms, fahp_search_end_ms)
    mahp_vm, mahp_t = _min_in_window(mahp_search_start_ms, mahp_search_end_ms)

    # Max rise / decay slopes — fit a line to the steepest
    # max_slope_window_ms-wide stretch of dV/dt.
    win_samples = max(2, int(round(max_slope_window_ms / dt_ms)))
    rise_dvdt = dvdt[thr_idx:spike.peak_idx + 1]
    decay_dvdt = dvdt[spike.peak_idx:decay_end_idx]

    def _max_abs_slope(arr: np.ndarray) -> Optional[float]:
        if arr.size < win_samples:
            return None
        # Sliding mean of dV/dt is a clean stand-in for the linear-fit
        # slope on a constant-spacing grid (the fit collapses to mean
        # for evenly-spaced y values).
        kernel = np.ones(win_samples) / win_samples
        smoothed = np.convolve(arr, kernel, mode="valid")
        if smoothed.size == 0:
            return None
        i = int(np.argmax(np.abs(smoothed)))
        return float(smoothed[i])

    max_rise = _max_abs_slope(rise_dvdt)
    max_decay = _max_abs_slope(decay_dvdt)

    return {
        "threshold_vm": threshold_vm,
        "threshold_t_s": float(thr_idx / sr),
        "peak_vm": peak_vm,
        "peak_t_s": float(spike.peak_idx / sr),
        "amplitude_mv": float(amplitude),
        "rise_time_s": rise_time_s,
        "decay_time_s": decay_time_s,
        "half_width_s": half_width_s,
        # Where the FWHM was measured (s, sweep time) — lets the viewers
        # draw the FWHM marks exactly where the measurement put them.
        "half_rise_t_s": float(half_rise_t) if half_rise_t is not None else None,
        "half_fall_t_s": float(half_fall_t) if half_fall_t is not None else None,
        "fahp_vm": fahp_vm,
        "fahp_t_s": fahp_t,
        "mahp_vm": mahp_vm,
        "mahp_t_s": mahp_t,
        "max_rise_slope_mv_ms": max_rise,
        "max_decay_slope_mv_ms": max_decay,
        "manual": bool(spike.manual),
    }


def kinetics_kwargs(kinetics: dict) -> dict:
    """Map the frontend's kinetics dict onto ``_measure_spike`` kwargs."""
    k = kinetics or {}
    return dict(
        threshold_method=str(k.get("threshold_method", "first_deriv_cutoff")),
        threshold_cutoff_mv_ms=float(k.get("threshold_cutoff_mv_ms", 20.0)),
        threshold_search_ms_before_peak=float(k.get("threshold_search_ms_before_peak", 5.0)),
        sekerli_lower_bound_mv_ms=float(k.get("sekerli_lower_bound_mv_ms", 5.0)),
        rise_low_pct=float(k.get("rise_low_pct", 10.0)),
        rise_high_pct=float(k.get("rise_high_pct", 90.0)),
        decay_low_pct=float(k.get("decay_low_pct", 10.0)),
        decay_high_pct=float(k.get("decay_high_pct", 90.0)),
        decay_end=str(k.get("decay_end", "to_threshold")),
        fahp_search_start_ms=float(k.get("fahp_search_start_ms", 0.0)),
        fahp_search_end_ms=float(k.get("fahp_search_end_ms", 5.0)),
        mahp_search_start_ms=float(k.get("mahp_search_start_ms", 5.0)),
        mahp_search_end_ms=float(k.get("mahp_search_end_ms", 100.0)),
        max_slope_window_ms=float(k.get("max_slope_window_ms", 0.5)),
        interpolate=bool(k.get("interpolate_to_200khz", True)),
        amplitude_ref=str(k.get("amplitude_ref", "threshold")),
        baseline_window_ms=float(k.get("baseline_window_ms", 10.0)),
    )


def kinetics_on_filtered(kinetics: dict) -> bool:
    """True when kinetics should be measured on the pre-detection-
    filtered trace instead of the unfiltered one (the default). Has no
    effect when no pre-detection filter is set."""
    return str((kinetics or {}).get("measure_on", "raw")) == "filtered"


def kinetics_for_method(kinetics: dict, method: str) -> dict:
    """Kinetics params as used for a given detection method: the
    noise-relative method measures from the local pre-spike baseline
    instead of an AP threshold."""
    k = dict(kinetics or {})
    k["amplitude_ref"] = "baseline" if method == "noise_threshold" else "threshold"
    return k


# Fields that carry signal values (or slopes of it) and flip sign with
# the trace when a downward spike is measured on the inverted signal.
_SIGNED_FIELDS = (
    "threshold_vm", "peak_vm", "amplitude_mv", "fahp_vm", "mahp_vm",
    "max_rise_slope_mv_ms", "max_decay_slope_mv_ms",
)


def measure_spike_polar(
    vm: np.ndarray, sr: float, spike: _Spike, polarity: int,
    kinetics: dict, dvdt: Optional[np.ndarray] = None,
) -> dict:
    """``_measure_spike`` for either spike polarity.

    Downward spikes (polarity −1, e.g. inward action currents) are
    measured on the inverted trace — so "threshold", "fAHP" etc. keep
    their geometric meaning relative to the spike — and the signal-valued
    results are flipped back, so every value is reported in the
    recording's own sign. ``dvdt`` must belong to the same orientation
    as the measured trace (i.e. already inverted when polarity is −1).
    """
    if polarity >= 0:
        return _measure_spike(vm, sr, spike, dvdt=dvdt, **kinetics_kwargs(kinetics))
    flipped = _Spike(
        onset_idx=spike.onset_idx, peak_idx=spike.peak_idx, fall_idx=spike.fall_idx,
        peak_vm=-spike.peak_vm, manual=spike.manual,
    )
    m = _measure_spike(-vm, sr, flipped, dvdt=dvdt, **kinetics_kwargs(kinetics))
    for k in _SIGNED_FIELDS:
        if m.get(k) is not None:
            m[k] = -float(m[k])
    return m


# ---------------------------------------------------------------------------
# Per-sweep counting metrics
# ---------------------------------------------------------------------------

def _local_variance(isis: np.ndarray) -> Optional[float]:
    """Shinomoto 2003 local variance — robust accommodation metric.
    Returns None when fewer than 2 ISIs are available."""
    if isis.size < 2:
        return None
    pairs = 3.0 * (isis[:-1] - isis[1:]) ** 2 / ((isis[:-1] + isis[1:]) ** 2)
    return float(np.mean(pairs))


def _per_sweep_metrics(
    spikes: list[_Spike], sr: float,
    *,
    bounds_start_s: float, bounds_end_s: float,
    im_mean_pa: Optional[float],
    im_onset_s: Optional[float],
    spontaneous: bool = False,
) -> dict:
    """Counting metrics computed from a sweep's detected spike list.

    In spontaneous mode there is no stimulus, so the stimulus-relative
    metrics (first-spike latency, SFA divisor) are left empty."""
    peak_t = np.array([s.peak_idx / sr for s in spikes], dtype=float) if spikes else np.zeros(0)
    isis = np.diff(peak_t) if peak_t.size >= 2 else np.zeros(0)
    sfa_div = float(isis[0] / isis[-1]) if isis.size >= 2 and isis[-1] != 0 else None
    first_lat = (float(peak_t[0]) - im_onset_s) if (peak_t.size > 0 and im_onset_s is not None) else None
    if spontaneous:
        sfa_div = None
        first_lat = None
    mean_isi = float(isis.mean()) if isis.size else None
    return {
        "spike_count": int(peak_t.size),
        "peak_times_s": peak_t.tolist(),
        "first_spike_latency_s": first_lat,
        "mean_isi_s": mean_isi,
        "median_isi_s": float(np.median(isis)) if isis.size else None,
        "cv_isi": (float(isis.std(ddof=1) / mean_isi)
                   if isis.size >= 2 and mean_isi else None),
        "sfa_divisor": sfa_div,
        "local_variance": _local_variance(isis),
        "im_mean_pa": im_mean_pa,
        "duration_s": float(bounds_end_s - bounds_start_s) if bounds_end_s > bounds_start_s else None,
        "spike_rate_hz": (
            float(peak_t.size / (bounds_end_s - bounds_start_s))
            if bounds_end_s > bounds_start_s else None
        ),
    }


# ---------------------------------------------------------------------------
# Top-level entry point — called by api/ap.py
# ---------------------------------------------------------------------------

def run_ap(
    *,
    sweeps_vm: list[np.ndarray],          # list of Vm traces, one per sweep
    sweeps_im: Optional[list[np.ndarray]],  # parallel Im traces, or None
    sweep_indices: list[int],             # absolute sweep numbers (0-based)
    sr: float,
    detection: dict,
    kinetics: dict,
    rheobase_mode: str,                   # 'record' | 'exact' | 'ramp'
    ramp_params: Optional[dict],          # {t_start_s, t_end_s, im_start_pa, im_end_pa}
    im_onset_s: Optional[float],          # from .pgf, used for first-spike latency
    manual_edits: Optional[dict] = None,  # {added: {sweep: [t_s,...]}, removed: {...}}
    measure_kinetics: bool = True,
    mode: str = "evoked",                 # 'evoked' | 'spontaneous'
) -> dict:
    """Run AP detection + counting + (optionally) kinetics across all sweeps.

    Returns a dict with ``per_sweep`` (one entry per sweep), ``per_spike``
    (flattened list across sweeps with sweep + spike index), ``fi_curve``
    (Im, rate, sweep), and ``rheobase`` (mode + value).

    ``mode='spontaneous'`` is for continuous recordings without a
    stimulus: F-I, rheobase, latency and SFA are skipped; detection and
    kinetics are unchanged.
    """
    spontaneous = str(mode) == "spontaneous"
    bounds_start_s = float(detection.get("bounds_start_s", 0.0))
    bounds_end_s = float(detection.get("bounds_end_s", 0.0))
    method = str(detection.get("method", "auto_rec"))
    manual_threshold = float(detection.get("manual_threshold_mv", -10.0))
    min_amp = float(detection.get("min_amplitude_mv", 50.0))
    pos_dvdt = float(detection.get("pos_dvdt_mv_ms", 10.0))
    neg_dvdt = float(detection.get("neg_dvdt_mv_ms", -10.0))
    width_ms = float(detection.get("width_ms", 5.0))
    min_dist = float(detection.get("min_distance_ms", 2.0))
    kin_eff = kinetics_for_method(kinetics, method)
    # Kinetics on the unfiltered trace (default) or on the pre-filtered
    # one the detector saw (``measure_on: 'filtered'``).
    measure_filtered = kinetics_on_filtered(kinetics)

    added_by_sweep: dict[int, list[float]] = {}
    removed_by_sweep: dict[int, list[float]] = {}
    if manual_edits:
        for k, v in (manual_edits.get("added") or {}).items():
            added_by_sweep[int(k)] = [float(t) for t in (v or [])]
        for k, v in (manual_edits.get("removed") or {}).items():
            removed_by_sweep[int(k)] = [float(t) for t in (v or [])]

    per_sweep_out: list[dict] = []
    per_spike_out: list[dict] = []
    fi_im: list[float] = []
    fi_rate: list[float] = []
    fi_sweep: list[int] = []
    spike_times_per_sweep: list[list[float]] = []
    polarity_per_sweep: list[int] = []

    rheobase_value: Optional[float] = None
    first_ap_sweep_idx: Optional[int] = None
    first_ap_peak_t_s: Optional[float] = None

    sweep_end_default = bounds_end_s if bounds_end_s > 0 else None

    for i, sweep_idx in enumerate(sweep_indices):
        vm = sweeps_vm[i]
        if vm.size == 0:
            per_sweep_out.append({
                "sweep": int(sweep_idx),
                "spike_count": 0,
                "peak_times_s": [],
                "first_spike_latency_s": None,
                "mean_isi_s": None,
                "median_isi_s": None,
                "cv_isi": None,
                "sfa_divisor": None,
                "local_variance": None,
                "im_mean_pa": None,
                "duration_s": None,
                "spike_rate_hz": None,
            })
            spike_times_per_sweep.append([])
            polarity_per_sweep.append(1)
            continue

        eff_end = sweep_end_default if sweep_end_default else (vm.size / sr)
        # Optional pre-detection filter (same shape as bursts).
        vm_for_detection = _apply_pre_detection_filter(vm, sr, detection)
        vm_meas = vm_for_detection if measure_filtered else vm

        polarity = 1
        lines = None
        if method == "noise_threshold":
            spikes, polarity, lines = _detect_spikes_noise_threshold(
                vm_for_detection, sr,
                detection=detection,
                bounds_start_s=bounds_start_s,
                bounds_end_s=eff_end,
            )
            # Peaks onto the trace kinetics are measured on.
            spikes = _snap_peaks(
                spikes, vm_meas, sr, polarity,
                float(detection.get("peak_snap_ms", 1.0)),
            )
        else:
            spikes = _detect_spikes_sweep(
                vm_for_detection, sr,
                method=method,
                manual_threshold_mv=manual_threshold,
                min_amplitude_mv=min_amp,
                pos_dvdt_mv_ms=pos_dvdt,
                neg_dvdt_mv_ms=neg_dvdt,
                width_ms=width_ms,
                min_distance_ms=min_dist,
                bounds_start_s=bounds_start_s,
                bounds_end_s=eff_end,
            )
        polarity_per_sweep.append(int(polarity))
        # Apply manual edits for THIS sweep, if any.
        added = added_by_sweep.get(int(sweep_idx), [])
        removed = removed_by_sweep.get(int(sweep_idx), [])
        if added or removed:
            spikes = _apply_manual_edits_to_sweep(
                spikes, vm_for_detection, sr, added, removed, min_dist,
                polarity=polarity,
            )
            if method == "noise_threshold":
                # Added spikes were snapped on the filtered trace — move
                # them onto the measured one like the detected spikes.
                manual = _snap_peaks(
                    [sp for sp in spikes if sp.manual], vm_meas, sr, polarity,
                    float(detection.get("peak_snap_ms", 1.0)),
                )
                spikes = sorted(
                    [sp for sp in spikes if not sp.manual] + manual,
                    key=lambda sp: sp.peak_idx,
                )

        # Im channel mean over the bounded window (for F-I + rheobase 'record').
        im_mean_pa: Optional[float] = None
        if sweeps_im is not None and i < len(sweeps_im) and sweeps_im[i].size:
            i0 = max(0, int(round(bounds_start_s * sr)))
            i1 = min(sweeps_im[i].size, int(round(eff_end * sr)))
            if i1 > i0:
                im_mean_pa = float(np.mean(sweeps_im[i][i0:i1]))

        per_sweep = _per_sweep_metrics(
            spikes, sr,
            bounds_start_s=bounds_start_s, bounds_end_s=eff_end,
            im_mean_pa=im_mean_pa, im_onset_s=im_onset_s,
            spontaneous=spontaneous,
        )
        per_sweep["sweep"] = int(sweep_idx)
        per_sweep["polarity"] = int(polarity)
        per_sweep["detection_lines"] = lines
        per_sweep_out.append(per_sweep)
        spike_times_per_sweep.append(per_sweep["peak_times_s"])

        # F-I point — needs an Im value from one source or another.
        if (not spontaneous) and im_mean_pa is not None and per_sweep["spike_rate_hz"] is not None:
            fi_im.append(im_mean_pa)
            fi_rate.append(per_sweep["spike_rate_hz"])
            fi_sweep.append(int(sweep_idx))

        # Track the first sweep with any AP — used for all rheobase modes.
        if first_ap_sweep_idx is None and spikes:
            first_ap_sweep_idx = int(sweep_idx)
            first_ap_peak_t_s = float(spikes[0].peak_idx / sr)

        if measure_kinetics and spikes:
            # Derivative once per sweep, in the orientation being measured.
            oriented = vm_meas if polarity >= 0 else -vm_meas
            dvdt = np.gradient(oriented) * (sr / 1000.0)
            for j, sp in enumerate(spikes):
                m = measure_spike_polar(vm_meas, sr, sp, polarity, kin_eff, dvdt=dvdt)
                m["sweep"] = int(sweep_idx)
                m["spike_index"] = int(j)
                per_spike_out.append(m)

    # Rheobase computation (stimulus-driven recordings only).
    if first_ap_sweep_idx is not None and not spontaneous:
        if rheobase_mode == "record":
            # Im of the first sweep that fired.
            for ps in per_sweep_out:
                if ps["sweep"] == first_ap_sweep_idx:
                    rheobase_value = ps.get("im_mean_pa")
                    break
        elif rheobase_mode == "exact":
            # Im at the exact sample of the first AP's peak. Requires
            # the user to have an Im channel — otherwise NaN.
            if sweeps_im is not None and first_ap_peak_t_s is not None:
                for i, sweep_idx in enumerate(sweep_indices):
                    if sweep_idx == first_ap_sweep_idx and i < len(sweeps_im):
                        sample = int(round(first_ap_peak_t_s * sr))
                        if 0 <= sample < sweeps_im[i].size:
                            # Subtract pre-stim baseline (median of the
                            # first 100 ms of the bounded window) so we
                            # report the injected current, not the
                            # holding level.
                            baseline_samples = min(int(round(0.1 * sr)), sweeps_im[i].size)
                            base = float(np.median(sweeps_im[i][:baseline_samples])) if baseline_samples else 0.0
                            rheobase_value = float(sweeps_im[i][sample] - base)
        elif rheobase_mode == "ramp" and ramp_params and first_ap_peak_t_s is not None:
            t0 = float(ramp_params.get("t_start_s", 0.0))
            t1 = float(ramp_params.get("t_end_s", 0.0))
            i0 = float(ramp_params.get("im_start_pa", 0.0))
            i1 = float(ramp_params.get("im_end_pa", 0.0))
            if t1 > t0 and first_ap_peak_t_s >= t0:
                frac = (first_ap_peak_t_s - t0) / (t1 - t0)
                frac = max(0.0, min(1.0, frac))
                rheobase_value = i0 + (i1 - i0) * frac

    return {
        "per_sweep": per_sweep_out,
        "per_spike": per_spike_out,
        "fi_curve": (
            {"im": fi_im, "rate": fi_rate, "sweep": fi_sweep}
            if fi_im else None
        ),
        "rheobase": (None if spontaneous
                     else {"mode": rheobase_mode, "value": rheobase_value}),
        "spike_times_per_sweep": spike_times_per_sweep,
        "polarity_per_sweep": polarity_per_sweep,
        "mode": "spontaneous" if spontaneous else "evoked",
        "first_ap_sweep": first_ap_sweep_idx,
        "first_ap_peak_t_s": first_ap_peak_t_s,
    }


# ---------------------------------------------------------------------------
# Phase-plot data for one spike
# ---------------------------------------------------------------------------

def phase_plot_for_spike(
    vm: np.ndarray, sr: float,
    *,
    peak_t_s: float,
    window_ms: float,
    interp_factor: int,
) -> dict:
    """Slice ``vm`` around a peak and return Vm, dV/dt + summary metrics
    suitable for the phase-plot tab."""
    if vm.size == 0 or sr <= 0:
        return {"vm": [], "dvdt": [], "metrics": {}}
    half = max(1, int(round(window_ms / 1000.0 * sr)))
    centre = int(round(peak_t_s * sr))
    i0 = max(0, centre - half)
    i1 = min(vm.size, centre + half + 1)
    seg = vm[i0:i1].astype(float)
    if interp_factor and interp_factor > 1 and seg.size >= 4:
        n = seg.size
        x_old = np.arange(n)
        x_new = np.linspace(0, n - 1, n * interp_factor)
        seg = np.interp(x_new, x_old, seg)
        sr_eff = sr * interp_factor
    else:
        sr_eff = sr
    dvdt = np.gradient(seg) * (sr_eff / 1000.0)  # mV/ms
    return {
        "vm": seg.tolist(),
        "dvdt": dvdt.tolist(),
        "metrics": {
            "max_vm": float(np.max(seg)),
            "max_dvdt": float(np.max(dvdt)),
            "min_dvdt": float(np.min(dvdt)),
        },
    }
