"""Burst detection algorithms for field-potential and intracellular recordings.

Three detection methods, all sharing a common detrending + baseline-estimation
front end (see ``_estimate_baseline``):

1. ``threshold``   — detect epochs where |signal − baseline| exceeds threshold
                     on a smoothed rectified signal.
2. ``oscillation`` — bandpass + Hilbert envelope, threshold the envelope.
3. ``isi``         — detect spikes, cluster them by inter-spike interval.

The threshold and oscillation methods expose the same baseline mode selector:

- ``percentile``  (default) — baseline = Nth percentile of the sweep,
                  threshold = baseline + n_sd × 1.4826 × MAD. Robust to long
                  drifting traces because no windowing is involved and the
                  percentile is unaffected by the bursts themselves as long as
                  they occupy a minority of the sweep.
- ``robust``      — baseline = median of the sweep, same MAD-based threshold.
                  Good for bidirectional or balanced signals.
- ``rolling``     — sliding-window median (default 5 s) subtracted from the
                  signal before threshold comparison. Accommodates drifting
                  baselines explicitly.
- ``fixed_start`` — legacy behaviour: mean + SD of the first 10 % of the sweep.

Every returned burst has: start_idx, end_idx, start_s, end_s, duration_ms,
peak_amplitude, peak_time_s, mean_amplitude, integral, mean_frequency_hz.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt, hilbert, find_peaks
from scipy.ndimage import uniform_filter1d, median_filter

from .base import AnalysisBase, register_analysis
from utils.filters import lowpass_filter, highpass_filter, bandpass_filter


# Max bursts returned in one response. Long recordings can legitimately produce
# thousands of events — cap only as a safety net against pathological params.
MAX_BURSTS_RETURNED = 10000


def _mad(x: np.ndarray) -> float:
    """Median absolute deviation, scaled to be a consistent estimator of SD
    for Gaussian noise (factor 1.4826)."""
    m = np.median(x)
    return float(1.4826 * np.median(np.abs(x - m)))


def _drift_safe_noise(x: np.ndarray) -> float:
    """Robust noise estimate that ignores slow baseline drift.

    MAD of the first-differences: for white noise with SD sigma, the first
    differences have SD sigma*sqrt(2). We divide out the sqrt(2) so the
    returned value is directly comparable to a sample-level SD, and scale
    by 1.4826 so MAD approximates that SD for Gaussian noise.
    """
    if len(x) < 2:
        return 0.0
    d = np.diff(x)
    return float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2))


def _noise_estimate(signal: np.ndarray, method: str = "sd") -> float:
    """Compute the noise floor of ``signal`` using the user's preferred
    estimator. Call on the DETRENDED / FILTERED signal — all three methods
    assume drift/DC has been removed.

    - ``sd``        — classical standard deviation (numpy). Sensitive to
                      burst outliers but that's what the user asked for;
                      with a bandpass filter applied the raw signal is
                      clean enough for SD to behave well.
    - ``mad``       — median absolute deviation × 1.4826. Robust to bursts.
    - ``mad_diff``  — MAD of first-differences. Robust to bursts AND drift.
    """
    if len(signal) < 2:
        return 0.0
    if method == "mad":
        return _mad(signal)
    if method == "mad_diff":
        return _drift_safe_noise(signal)
    # default: 'sd' / 'rms' (equivalent after DC removal)
    return float(np.std(signal))


def _apply_pre_detection_filter(data: np.ndarray, sr: float, params: dict) -> np.ndarray:
    """Optionally filter the raw signal before detection runs on it. The
    filter config mirrors the top-level viewer's filter panel — bandpass /
    lowpass / highpass via Butterworth, zero-phase via sosfiltfilt.

    If no filter is requested (or params are invalid), returns ``data``
    unchanged.
    """
    if not params.get("filter_enabled", False):
        return data
    ftype = str(params.get("filter_type", "")).lower()
    low = float(params.get("filter_low", 0))
    high = float(params.get("filter_high", 0))
    order = int(params.get("filter_order", 4))
    try:
        if ftype == "lowpass" and high > 0:
            return lowpass_filter(data, high, sr, order)
        if ftype == "highpass" and low > 0:
            return highpass_filter(data, low, sr, order)
        if ftype == "bandpass" and low > 0 and high > 0:
            return bandpass_filter(data, low, high, sr, order)
    except Exception:
        pass
    return data


def _estimate_baseline(
    signal: np.ndarray,
    sr: float,
    mode: str,
    params: dict,
) -> tuple[np.ndarray, float, float]:
    """Return (detrended_signal, baseline_value, noise_value).

    ``baseline_value`` and ``noise_value`` are scalars summarising the estimate
    for the overlay lines on the viewer; ``detrended_signal`` is what the
    detector should threshold against (baseline subtracted when mode=rolling,
    identical to the input otherwise).
    """
    noise_method = str(params.get("noise_method", "sd"))

    if mode == "percentile":
        pct = float(params.get("baseline_percentile", 10.0))
        pct = max(0.0, min(100.0, pct))
        baseline = float(np.percentile(signal, pct))
        noise = _noise_estimate(signal, noise_method)
        return signal, baseline, noise

    if mode == "robust":
        baseline = float(np.median(signal))
        noise = _noise_estimate(signal, noise_method)
        return signal, baseline, noise

    if mode == "rolling":
        win_s = float(params.get("baseline_window_s", 5.0))
        win_samples = max(3, int(win_s * sr))
        if win_samples % 2 == 0:
            win_samples += 1
        rolling = median_filter(signal, size=win_samples, mode="reflect")
        detrended = signal - rolling
        baseline = 0.0  # after detrending
        noise = _noise_estimate(detrended, noise_method)
        return detrended, baseline, noise

    # fixed_start (legacy)
    baseline_end_s = float(params.get("baseline_end_s", len(signal) / sr * 0.1))
    bl_end = max(100, min(int(baseline_end_s * sr), len(signal)))
    baseline = float(np.mean(signal[:bl_end]))
    noise = _noise_estimate(signal[:bl_end], noise_method)
    return signal, baseline, noise


def _extract_epochs(above: np.ndarray, min_dur: int, min_gap: int, sr: float) -> list[dict]:
    """Extract contiguous True-epochs from a boolean mask; merge close ones
    within ``min_gap`` samples and drop any shorter than ``min_dur``."""
    diff = np.diff(above.astype(np.int8))
    starts = np.where(diff == 1)[0] + 1
    ends = np.where(diff == -1)[0] + 1

    if above[0]:
        starts = np.concatenate(([0], starts))
    if above[-1]:
        ends = np.concatenate((ends, [len(above)]))

    if len(starts) == 0 or len(ends) == 0:
        return []

    n = min(len(starts), len(ends))
    pairs = list(zip(starts[:n], ends[:n]))

    # Merge near-neighbours.
    merged: list[tuple[int, int]] = []
    for start, end in pairs:
        if merged and (start - merged[-1][1]) < min_gap:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))

    bursts: list[dict] = []
    for start, end in merged:
        duration = end - start
        if duration >= min_dur:
            bursts.append({
                "start_idx": int(start),
                "end_idx": int(end),
                "start_s": float(start / sr),
                "end_s": float(end / sr),
                "duration_ms": float(duration / sr * 1000.0),
            })
    return bursts


def detect_threshold_epochs(data: np.ndarray, sr: float, params: dict) -> dict:
    """Noise-relative threshold detection, shared by the Burst window's
    ``threshold`` method and the AP window's ``noise_threshold`` method.

    Pipeline: optional pre-detection filter → baseline + noise estimate
    (``baseline_mode`` / ``noise_method``) → |signal − baseline| →
    moving-average smoothing (``smooth_ms``) → epochs where the smoothed
    trace exceeds ``n_sd × noise`` → merge epochs closer than
    ``min_gap_ms`` → drop epochs shorter than ``min_duration_ms``.

    Returns the epochs (start/end idx + seconds + duration) together with
    the filtered signal and the scalar baseline / noise / threshold so
    callers can measure on the same trace the detector saw.
    """
    n_sd = float(params.get("n_sd", 2.0))
    smooth_ms = float(params.get("smooth_ms", 10.0))
    min_duration_ms = float(params.get("min_duration_ms", 50.0))
    min_gap_ms = float(params.get("min_gap_ms", 100.0))
    baseline_mode = params.get("baseline_mode", "percentile")

    smooth_samples = max(1, int(smooth_ms / 1000 * sr))
    min_dur_samples = int(min_duration_ms / 1000 * sr)
    min_gap_samples = int(min_gap_ms / 1000 * sr)

    # Pre-detection filter: clean up drift + high-freq noise before we
    # threshold.
    filtered = _apply_pre_detection_filter(data, sr, params)

    # Baseline on the filtered signal, then rectify+smooth for detection.
    detrended, baseline_value, noise_value = _estimate_baseline(
        filtered, sr, baseline_mode, params,
    )
    rectified = np.abs(detrended - baseline_value)
    smoothed = uniform_filter1d(rectified, smooth_samples)

    threshold_value = n_sd * noise_value
    above = smoothed > threshold_value
    epochs = _extract_epochs(above, min_dur_samples, min_gap_samples, sr)
    return {
        "epochs": epochs,
        "filtered": filtered,
        "detrended": detrended,
        "baseline_mode": baseline_mode,
        "baseline_value": float(baseline_value),
        "noise_value": float(noise_value),
        "threshold_value": float(threshold_value),
    }


class BurstDetection(AnalysisBase):
    name = "bursts"
    description = (
        "Burst detection on field-potential or intracellular recordings. "
        "Supports threshold, oscillation-envelope, and ISI-clustering methods "
        "with percentile / robust / rolling / fixed-start baselines."
    )

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        method = params.get("method", "threshold")

        if method == "threshold":
            result = self._threshold_method(data, sampling_rate, params)
        elif method == "isi":
            result = self._isi_method(data, sampling_rate, params)
        elif method == "oscillation":
            result = self._oscillation_method(data, sampling_rate, params)
        else:
            return {"error": f"Unknown method: {method}"}

        # Attach signal-scale diagnostics to every response so the UI can show
        # the user WHY detection returned few/no bursts (e.g. signal barely
        # deviates from baseline).
        med = float(np.median(data))
        max_abs_dev = float(np.max(np.abs(data - med)))
        result["signal_diag"] = {
            "median": med,
            "min": float(np.min(data)),
            "max": float(np.max(data)),
            "mad": _mad(data),
            "max_abs_dev": max_abs_dev,
            "n_samples": int(len(data)),
            "duration_s": float(len(data) / sampling_rate),
        }
        return result

    # ------------------------------------------------------------------
    # Threshold method
    # ------------------------------------------------------------------
    def _threshold_method(self, data, sr, params):
        """Detect bursts on a smoothed |signal − baseline| trace."""
        det = detect_threshold_epochs(data, sr, params)
        bursts = det["epochs"]
        filtered = det["filtered"]
        baseline_mode = det["baseline_mode"]
        baseline_value = det["baseline_value"]
        noise_value = det["noise_value"]
        threshold_value = det["threshold_value"]

        # Measure amplitudes on the FILTERED signal so viewer markers line up
        # with what the user sees when the mini-viewer displays the filtered
        # trace. Bursts were detected on `filtered`; their y-values are
        # relative to `filtered`.
        self._populate_burst_fields(bursts, filtered, sr,
                                    pre_burst_window_ms=float(params.get("pre_burst_window_ms", 100.0)),
                                    peak_direction=str(params.get("peak_direction", "auto")))

        return {
            "method": "threshold",
            "baseline_mode": baseline_mode,
            "n_bursts": len(bursts),
            "bursts": bursts[:MAX_BURSTS_RETURNED],
            # Absolute values (in signal units) that the viewer overlays.
            # For threshold method, the comparison was on |signal − baseline|,
            # so the envelope threshold is ``baseline ± threshold_value``.
            "baseline_value": float(baseline_value),
            "threshold_value": float(threshold_value),
            "threshold_high": float(baseline_value + threshold_value),
            "threshold_low": float(baseline_value - threshold_value),
            "noise_value": float(noise_value),
            "total_burst_time_s": sum(b["duration_ms"] for b in bursts) / 1000.0,
        }

    # ------------------------------------------------------------------
    # Oscillation-envelope method
    # ------------------------------------------------------------------
    def _oscillation_method(self, data, sr, params):
        """Bandpass + Hilbert envelope, threshold the envelope."""
        low_freq = float(params.get("low_freq", 4.0))
        high_freq = float(params.get("high_freq", 30.0))
        n_sd = float(params.get("n_sd", 2.0))
        min_duration_ms = float(params.get("min_duration_ms", 100.0))
        min_gap_ms = float(params.get("min_gap_ms", 200.0))
        smooth_ms = float(params.get("smooth_ms", 50.0))
        baseline_mode = params.get("baseline_mode", "percentile")

        # Allow an optional pre-detection filter to run BEFORE the
        # oscillation bandpass. Usually redundant, but lets the user e.g.
        # drop 50/60 Hz line noise via a notch before running.
        data_in = _apply_pre_detection_filter(data, sr, params)

        nyq = sr / 2
        if high_freq >= nyq:
            high_freq = nyq * 0.9
        sos = butter(4, [low_freq / nyq, high_freq / nyq], btype="band", output="sos")
        filtered = sosfiltfilt(sos, data_in, padtype="constant")

        analytic = hilbert(filtered)
        envelope = np.abs(analytic)

        smooth_samples = max(1, int(smooth_ms / 1000 * sr))
        envelope_smooth = uniform_filter1d(envelope, smooth_samples)

        # Baseline of the envelope (not the raw signal).
        _, baseline_value, noise_value = _estimate_baseline(
            envelope_smooth, sr, baseline_mode, params,
        )
        threshold_value = baseline_value + n_sd * noise_value

        above = envelope_smooth > threshold_value
        min_dur_samples = int(min_duration_ms / 1000 * sr)
        min_gap_samples = int(min_gap_ms / 1000 * sr)

        bursts = self._extract_epochs(above, min_dur_samples, min_gap_samples, sr)
        # Oscillation method: amplitudes on the pre-filtered (pre-bandpass)
        # signal — the bandpass that defines "oscillation" is an internal
        # detection step, not something the user means to measure against.
        self._populate_burst_fields(bursts, data_in, sr,
                                    pre_burst_window_ms=float(params.get("pre_burst_window_ms", 100.0)),
                                    peak_direction=str(params.get("peak_direction", "auto")))

        # Extra: band power for each burst.
        for burst in bursts:
            i0, i1 = burst["start_idx"], burst["end_idx"]
            burst["mean_power"] = float(np.mean(envelope_smooth[i0:i1]))
            burst["peak_power"] = float(np.max(envelope_smooth[i0:i1]))

        return {
            "method": "oscillation",
            "baseline_mode": baseline_mode,
            "band": [low_freq, high_freq],
            "n_bursts": len(bursts),
            "bursts": bursts[:MAX_BURSTS_RETURNED],
            # These apply to the ENVELOPE, so the viewer draws them on a
            # secondary reference when rendering the raw signal. We still
            # include them for numeric readout.
            "envelope_baseline_value": float(baseline_value),
            "envelope_threshold_value": float(threshold_value),
            "noise_value": float(noise_value),
            # For convenience, also report where the signal median sits so the
            # viewer can show a raw-signal baseline line too.
            "baseline_value": float(np.median(data)),
            "threshold_value": 0.0,  # not applicable in signal units
            "total_burst_time_s": sum(b["duration_ms"] for b in bursts) / 1000.0,
        }

    # ------------------------------------------------------------------
    # ISI method
    # ------------------------------------------------------------------
    def _isi_method(self, data, sr, params):
        """Detect spikes, cluster by inter-spike interval."""
        # Apply pre-detection filter for spike detection (e.g. highpass to
        # remove DC drift before find_peaks). Cluster bursts on the
        # filtered signal, but measure amplitudes on raw.
        filtered = _apply_pre_detection_filter(data, sr, params)
        # Spikes are found as excursions from the FILTERED signal's
        # median, so report that as the baseline (same as the threshold
        # method): the baseline / threshold lines then sit on the trace
        # the burst viewer draws (it applies the same filter).
        baseline_value = float(np.median(filtered))

        raw_thresh = params.get("spike_threshold", None)
        centered = np.abs(filtered - baseline_value)
        # Treat None, 0, and negative values all as "auto" — the frontend
        # sends 0 as its sentinel for auto because JSON has no undefined.
        if raw_thresh is None or float(raw_thresh) <= 0:
            spike_threshold = 4.0 * _mad(filtered)
        else:
            spike_threshold = float(raw_thresh)

        min_spike_dist_s = float(params.get("min_spike_dist_ms", 2.0)) / 1000.0
        peaks, _ = find_peaks(
            centered,
            height=spike_threshold,
            distance=int(min_spike_dist_s * sr),
        )

        if len(peaks) < 2:
            return {
                "method": "isi",
                "n_bursts": 0,
                "bursts": [],
                "n_spikes": int(len(peaks)),
                "baseline_value": baseline_value,
                "threshold_value": float(spike_threshold),
                "threshold_high": baseline_value + float(spike_threshold),
                "threshold_low": baseline_value - float(spike_threshold),
            }

        max_isi_ms = float(params.get("max_isi_ms", 100.0))
        min_spikes = int(params.get("min_spikes_per_burst", 3))

        isis = np.diff(peaks) / sr * 1000.0

        bursts = []
        current = [peaks[0]]
        for i, isi in enumerate(isis):
            if isi <= max_isi_ms:
                current.append(peaks[i + 1])
            else:
                if len(current) >= min_spikes:
                    bursts.append(self._spike_cluster_to_burst(current, sr, data))
                current = [peaks[i + 1]]
        if len(current) >= min_spikes:
            bursts.append(self._spike_cluster_to_burst(current, sr, data))

        # Measure amplitudes on the filtered signal (ISI detection ran on it)
        # so the mini-viewer markers line up with the displayed filtered trace.
        self._populate_burst_fields(bursts, filtered, sr,
                                    pre_burst_window_ms=float(params.get("pre_burst_window_ms", 100.0)),
                                    peak_direction=str(params.get("peak_direction", "auto")))
        # For ISI bursts, prefer the spike-rate-based frequency.
        for b in bursts:
            isi_freq = b.pop("_isi_frequency_hz", None)
            if isi_freq is not None:
                b["mean_frequency_hz"] = isi_freq

        if len(bursts) > 1:
            ibis = [bursts[i + 1]["start_s"] - bursts[i]["end_s"] for i in range(len(bursts) - 1)]
            mean_ibi = float(np.mean(ibis))
        else:
            mean_ibi = 0.0

        return {
            "method": "isi",
            "n_bursts": len(bursts),
            "n_spikes_total": int(len(peaks)),
            "bursts": bursts[:MAX_BURSTS_RETURNED],
            "mean_ibi_s": mean_ibi,
            "baseline_value": baseline_value,
            "threshold_value": float(spike_threshold),
            "threshold_high": baseline_value + float(spike_threshold),
            "threshold_low": baseline_value - float(spike_threshold),
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _extract_epochs(self, above: np.ndarray, min_dur: int, min_gap: int, sr: float) -> list[dict]:
        return _extract_epochs(above, min_dur, min_gap, sr)

    def _populate_burst_fields(
        self,
        bursts: list[dict],
        data: np.ndarray,
        sr: float,
        pre_burst_window_ms: float = 100.0,
        tail_fraction: float = 0.10,
        max_extend_ms: float = 500.0,
        peak_direction: str = "auto",
    ) -> None:
        """Compute per-burst metrics on the raw signal.

        After detection, each burst's window is EXTENDED outward until the
        signal returns near its pre-burst baseline — because bursts typically
        continue decaying after they re-cross the detection threshold, and
        we want "duration" and "integral" to reflect the true event, not just
        the above-threshold portion. Extension stops when:
          - |signal − pre_baseline| drops below ``tail_fraction`` × peak, or
          - we hit an adjacent burst's original start/end, or
          - we've extended by more than ``max_extend_ms``.

        Then all metrics are computed on the extended segment.

        Metrics per burst:
          - peak_amplitude        : max |signal − pre_baseline|
          - peak_time_s           : time of that peak
          - mean_amplitude        : mean |signal − pre_baseline| over burst
          - integral              : ∫|signal − pre_baseline|·dt  (units·s)
          - rise_time_10_90_ms    : time from 10% to 90% of peak (ascending)
          - decay_half_time_ms    : time from peak to 50% of peak (descending)
          - mean_frequency_hz     : # of prominent local maxima / duration
          - pre_burst_baseline    : the local reference value
          - duration_ms / start_s / end_s reflect the EXTENDED window.
        """
        pre_window_samples = max(1, int(pre_burst_window_ms / 1000.0 * sr))
        max_extend_samples = max(1, int(max_extend_ms / 1000.0 * sr))
        global_median = float(np.median(data)) if len(data) > 0 else 0.0
        n_data = len(data)

        # Cache original detection bounds so per-burst extension doesn't run
        # into extended versions of neighbours.
        orig_bounds = [(b["start_idx"], b["end_idx"]) for b in bursts]

        for idx, burst in enumerate(bursts):
            i0, i1 = burst["start_idx"], burst["end_idx"]
            if i1 <= i0 or i1 > n_data:
                burst["peak_amplitude"] = 0.0
                burst["peak_time_s"] = float(burst.get("start_s", 0))
                burst["mean_amplitude"] = 0.0
                burst["integral"] = 0.0
                burst["rise_time_10_90_ms"] = None
                burst["decay_half_time_ms"] = None
                burst["pre_burst_baseline"] = global_median
                burst["mean_frequency_hz"] = None
                continue

            # ---- Local pre-burst baseline (window just before i0) ----
            pre_lo = max(0, i0 - pre_window_samples)
            pre_hi = i0
            if pre_hi - pre_lo < max(3, pre_window_samples // 10):
                pre_lo = i1
                pre_hi = min(n_data, i1 + pre_window_samples)
            if pre_hi > pre_lo:
                pre_baseline = float(np.mean(data[pre_lo:pre_hi]))
            else:
                pre_baseline = global_median

            # ---- Approximate peak from the above-threshold segment ----
            # Used only as the reference for the "tail_fraction × peak" cut-off.
            core = data[i0:i1]
            pk_approx = float(np.max(np.abs(core - pre_baseline))) if len(core) > 0 else 0.0

            # ---- Extend outward until signal returns near pre_baseline ----
            tail_abs = tail_fraction * pk_approx
            prev_end = orig_bounds[idx - 1][1] if idx > 0 else 0
            next_start = orig_bounds[idx + 1][0] if idx + 1 < len(orig_bounds) else n_data

            # Backward from i0
            lo_bound = max(prev_end, i0 - max_extend_samples, 0)
            ext_start = i0
            for i in range(i0 - 1, lo_bound - 1, -1):
                if abs(data[i] - pre_baseline) < tail_abs:
                    ext_start = i
                    break
            else:
                ext_start = lo_bound

            # Forward from i1
            hi_bound = min(next_start, i1 + max_extend_samples, n_data)
            ext_end = i1
            for i in range(i1, hi_bound):
                if abs(data[i] - pre_baseline) < tail_abs:
                    ext_end = i
                    break
            else:
                ext_end = hi_bound

            # Fall back safely if the extension collapsed (shouldn't happen).
            if ext_end <= ext_start:
                ext_start, ext_end = i0, i1

            # ---- Metrics on the extended segment ----
            segment = data[ext_start:ext_end]
            dev = segment - pre_baseline
            abs_dev = np.abs(dev)
            # Peak-finding direction:
            #   "auto"     → largest |deviation|, preserves sign (default).
            #   "positive" → argmax of dev (only look at upward excursions).
            #                Useful when spike-and-wave events have an
            #                initial brief downward spike followed by a
            #                larger upward wave — we want the wave's peak.
            #   "negative" → argmin of dev.
            if peak_direction == "positive":
                pk_i = int(np.argmax(dev)) if dev.size > 0 else 0
            elif peak_direction == "negative":
                pk_i = int(np.argmin(dev)) if dev.size > 0 else 0
            else:
                pk_i = int(np.argmax(abs_dev)) if abs_dev.size > 0 else 0
            pk_val = float(abs_dev[pk_i])

            # Write back extended bounds so the table + overlay use them.
            burst["start_idx"] = int(ext_start)
            burst["end_idx"] = int(ext_end)
            burst["start_s"] = float(ext_start / sr)
            burst["end_s"] = float(ext_end / sr)
            burst["duration_ms"] = float((ext_end - ext_start) / sr * 1000.0)

            burst["peak_amplitude"] = pk_val
            # Signed peak — positive for upward deflection, negative for
            # downward. Needed so viewers can place the peak dot on the
            # correct side of pre_burst_baseline.
            burst["peak_signed"] = float(dev[pk_i])
            burst["peak_time_s"] = float((ext_start + pk_i) / sr)
            burst["mean_amplitude"] = float(np.mean(abs_dev))
            burst["integral"] = float(np.sum(abs_dev) / sr)
            burst["pre_burst_baseline"] = pre_baseline

            burst["rise_time_10_90_ms"] = _rise_time_10_90_ms(abs_dev, pk_i, pk_val, sr)
            burst["decay_half_time_ms"] = _decay_half_time_ms(abs_dev, pk_i, pk_val, sr)
            burst["mean_frequency_hz"] = _burst_peak_frequency(abs_dev, pk_val, sr)

    def _spike_cluster_to_burst(self, spike_indices, sr: float, data: np.ndarray) -> dict:
        """Convert a cluster of spike indices into a burst dict.

        Only fills geometry + spike-count fields; peak/mean/integral
        amplitude fields are (re)computed by ``_populate_burst_fields`` with
        a proper local pre-burst baseline. We override mean_frequency_hz
        here with the ISI-based value since for spike clusters the rate is
        more meaningful than zero-crossings.
        """
        spikes = np.asarray(spike_indices)
        isis = np.diff(spikes) / sr * 1000.0
        i0 = int(spikes[0])
        i1 = int(spikes[-1])
        mean_isi = float(np.mean(isis)) if len(isis) > 0 else 0.0
        return {
            "start_idx": i0,
            "end_idx": i1,
            "start_s": float(i0 / sr),
            "end_s": float(i1 / sr),
            "duration_ms": float((i1 - i0) / sr * 1000.0),
            "n_spikes": int(len(spikes)),
            "mean_isi_ms": mean_isi,
            # ISI-based frequency (overridden after _populate_burst_fields
            # unless we patch it back — see _isi_method caller).
            "_isi_frequency_hz": float(1000.0 / mean_isi) if mean_isi > 0 else None,
        }


def _rise_time_10_90_ms(abs_dev: np.ndarray, pk_i: int, pk_val: float, sr: float) -> float | None:
    """10-90% rise time on the ascending limb of a burst.

    Operates on ``abs_dev`` = |signal − pre_baseline| so direction (up vs
    down) doesn't matter. Returns None when the peak is at sample 0 or
    the crossings can't be located (too short, too noisy).
    """
    if pk_i < 2 or pk_val <= 0:
        return None
    ascending = abs_dev[:pk_i + 1]
    thr_10 = 0.1 * pk_val
    thr_90 = 0.9 * pk_val
    # argmax returns the first index where the boolean is True.
    hit_10 = np.argmax(ascending >= thr_10)
    hit_90 = np.argmax(ascending >= thr_90)
    if hit_90 <= hit_10:
        return None
    return float((hit_90 - hit_10) / sr * 1000.0)


def _decay_half_time_ms(abs_dev: np.ndarray, pk_i: int, pk_val: float, sr: float) -> float | None:
    """Time from the peak to the first sample where |dev| falls below 50%
    of the peak. Returns None if the burst never decays below 50% within
    its detected window."""
    if pk_i >= len(abs_dev) - 1 or pk_val <= 0:
        return None
    descending = abs_dev[pk_i:]
    below = np.where(descending < 0.5 * pk_val)[0]
    if len(below) == 0:
        return None
    return float(below[0] / sr * 1000.0)


def _burst_peak_frequency(abs_dev: np.ndarray, pk_val: float, sr: float) -> float | None:
    """Estimate frequency as (# prominent local maxima) / (burst duration).

    A peak is accepted only if it:
      - exceeds ~50% of the burst's global peak (filters noise),
      - has a prominence of ≥ 30% of the global peak — i.e. stands out from
        surrounding valleys by a meaningful fraction (this is what
        distinguishes a real sub-peak from envelope ripple),
      - is ≥ 20 ms from any other accepted peak (typical minimum spike
        spacing for epileptiform bursts),
      - survives 10 ms of light smoothing first.

    With this configuration a simple 2-peaks-at-the-top burst reports
    ~5–15 Hz; a dense spike-cluster burst reports up to ~30–50 Hz; pure
    noise envelopes typically report None.
    """
    n = len(abs_dev)
    if n < 8 or pk_val <= 0:
        return None
    smooth_win = max(3, min(n - 1, int(0.010 * sr)))
    smoothed = uniform_filter1d(abs_dev, smooth_win)
    min_dist = max(3, int(0.020 * sr))      # 20 ms between accepted peaks
    peaks, _ = find_peaks(
        smoothed,
        height=0.5 * pk_val,
        prominence=0.3 * pk_val,
        distance=min_dist,
    )
    n_peaks = len(peaks)
    duration_s = n / sr
    if n_peaks < 1 or duration_s <= 0:
        return None
    return float(n_peaks / duration_s)


register_analysis(BurstDetection())
