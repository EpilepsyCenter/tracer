"""Spectral analysis: power spectral density, band power, line noise, spectrogram.

Everything here is a pure function of sample arrays, so the Spectral window,
Batch and Cohort all share one implementation.

Conventions
-----------
* PSDs are one-sided densities in ``units²/Hz`` (``scaling='density'``), so
  integrating a PSD over a frequency range gives power (variance) in
  ``units²`` and ``sqrt`` of that is an RMS amplitude in ``units``.
* A *region* is a time window inside a range of sweeps. Each sweep's slice is
  analysed on its own and the per-segment spectra are pooled. Sweeps are never
  concatenated (that would put a step at every join) and never averaged in the
  time domain first (that cancels any rhythm that is not phase-locked to the
  sweep start).
* Band powers are integrated with a rectangle rule (``sum(psd) * df``) over
  bins whose centre lies in ``[low, high)``. That is the standard estimator
  for binned spectra and keeps adjacent bands from double-counting a bin.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Optional

import numpy as np
from scipy import signal as sps

from .base import AnalysisBase, register_analysis


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

#: Bands tuned for slice field potentials, including the high-frequency
#: oscillations that matter in epilepsy work. Users can edit the list.
DEFAULT_BANDS: list[dict[str, Any]] = [
    {"name": "delta", "low": 1.0, "high": 4.0},
    {"name": "theta", "low": 4.0, "high": 12.0},
    {"name": "beta", "low": 12.0, "high": 30.0},
    {"name": "low gamma", "low": 30.0, "high": 80.0},
    {"name": "high gamma", "low": 80.0, "high": 150.0},
    {"name": "ripple", "low": 150.0, "high": 250.0},
    {"name": "fast ripple", "low": 250.0, "high": 500.0},
]

DEFAULT_PARAMS: dict[str, Any] = {
    "method": "welch",            # 'welch' | 'periodogram'
    "segment_s": 2.0,             # Welch segment length → 0.5 Hz resolution
    "overlap_pct": 50.0,
    "window": "hann",             # 'hann' | 'hamming' | 'blackman' | 'boxcar'
    "detrend": "constant",        # 'constant' | 'linear' | 'none'
    "average": "mean",            # 'mean' | 'median' (median resists bursts/artefacts)
    "fmin": 1.0,                  # analysis range: total power, relative power,
    "fmax": 500.0,                #   dominant frequency and the stored spectrum
    "bands": DEFAULT_BANDS,
    "line_freq": 50.0,            # mains frequency; 60 in the Americas
    "line_bw_hz": 1.0,            # ± half-width treated as line noise
    "line_harmonics": 5,
    "exclude_line_noise": True,   # interpolate over mains bins in band powers
    "filter_enabled": False,      # optional pre-filter (shapes the spectrum!)
    "filter_type": "bandpass",
    "filter_low": 1.0,
    "filter_high": 500.0,
    "filter_order": 4,
}

#: Max points of a stored / displayed spectrum. Higher resolutions are thinned
#: with a peak-preserving reduction so mains peaks don't vanish from the plot.
MAX_SPECTRUM_POINTS = 4000

#: Segments processed per chunk, to bound memory on hour-long recordings.
_CHUNK_SEGMENTS = 256


def merged_params(params: Optional[dict]) -> dict:
    """Defaults overlaid with whatever the caller sent."""
    out = {**DEFAULT_PARAMS}
    for k, v in (params or {}).items():
        if v is not None:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# Signal preparation
# ---------------------------------------------------------------------------

def prefilter(x: np.ndarray, sr: float, params: dict) -> np.ndarray:
    """Apply the optional pre-filter. Off by default: a filter reshapes the
    spectrum it is meant to measure, so it is only for removing something
    known (e.g. slow drift) before computing a PSD."""
    if not params.get("filter_enabled"):
        return x
    from utils.filters import bandpass_filter, highpass_filter, lowpass_filter

    ftype = params.get("filter_type", "bandpass")
    lo = float(params.get("filter_low") or 0)
    hi = float(params.get("filter_high") or 0)
    order = int(params.get("filter_order") or 4)
    nyq = sr / 2.0
    if hi >= nyq:
        hi = nyq * 0.99
    y = np.asarray(x, dtype=float).copy()
    if ftype == "lowpass" and hi > 0:
        return lowpass_filter(y, hi, sr, order)
    if ftype == "highpass" and lo > 0:
        return highpass_filter(y, lo, sr, order)
    if ftype == "bandpass" and lo > 0 and hi > lo:
        return bandpass_filter(y, lo, hi, sr, order)
    return y


def _detrend_arg(params: dict):
    d = params.get("detrend", "constant")
    return False if d in (None, "none", False) else d


def _median_bias(n: int) -> float:
    """Bias of the median of n chi²(2) variables vs their mean (as in SciPy's
    ``welch(average='median')``)."""
    ii_2 = 2.0 * np.arange(1.0, (n - 1) // 2 + 1)
    return float(1.0 + np.sum(1.0 / (ii_2 + 1.0) - 1.0 / ii_2))


# ---------------------------------------------------------------------------
# PSD
# ---------------------------------------------------------------------------

def compute_psd(pieces: list[np.ndarray], sr: float, params: dict) -> dict:
    """PSD pooled over several 1-D pieces sampled at ``sr``.

    Welch: every piece is cut into overlapping segments of ``segment_s``; all
    segments from all pieces are averaged (mean or bias-corrected median).
    Pieces shorter than one segment are skipped and counted.

    Periodogram: one periodogram per piece on a common FFT length (the longest
    piece), averaged weighted by piece length.

    Returns ``freqs``/``psd`` cropped to ``[0, fmax]`` at full resolution plus
    bookkeeping (``n_segments``, ``freq_res_hz``, ``skipped_pieces``…).
    """
    p = params
    method = p.get("method", "welch")
    window = p.get("window", "hann")
    detrend = _detrend_arg(p)
    fmax = min(float(p.get("fmax") or sr / 2), sr / 2)
    pieces = [np.asarray(x, dtype=float) for x in pieces if x is not None and len(x) > 1]
    total_samples = int(sum(len(x) for x in pieces))
    if not pieces:
        raise ValueError("No data in the selected region")

    if method == "periodogram":
        nfft = max(len(x) for x in pieces)
        acc = None
        weight = 0
        freqs = None
        for x in pieces:
            f, pxx = sps.periodogram(
                x, fs=sr, window=window, nfft=nfft, detrend=detrend,
                scaling="density", return_onesided=True,
            )
            keep = f <= fmax
            f, pxx = f[keep], pxx[keep]
            w = len(x)
            acc = pxx * w if acc is None else acc + pxx * w
            weight += w
            freqs = f
        psd = acc / weight
        return {
            "freqs": freqs,
            "psd": psd,
            "n_segments": len(pieces),
            "n_pieces": len(pieces),
            "skipped_pieces": 0,
            "freq_res_hz": float(sr / nfft),
            "duration_s": total_samples / sr,
            "segment_s": nfft / sr,
        }

    # ---- Welch (pooled across pieces, chunked for memory) ----
    nperseg = int(round(float(p.get("segment_s") or 2.0) * sr))
    nperseg = max(nperseg, 8)
    noverlap = int(round(nperseg * float(p.get("overlap_pct", 50.0)) / 100.0))
    noverlap = min(max(noverlap, 0), nperseg - 1)
    step = nperseg - noverlap
    use_median = p.get("average", "mean") == "median"

    usable = [x for x in pieces if len(x) >= nperseg]
    skipped = len(pieces) - len(usable)
    if not usable:
        shortest = min(len(x) for x in pieces) / sr
        raise ValueError(
            f"The region ({shortest:.3g} s) is shorter than one Welch segment "
            f"({nperseg / sr:.3g} s). Shorten the segment length or select a longer region."
        )

    freqs = None
    keep = None
    total = None
    cols: list[np.ndarray] = []
    n_seg = 0
    chunk_len = (_CHUNK_SEGMENTS - 1) * step + nperseg
    for x in usable:
        n_in_piece = (len(x) - noverlap) // step
        start = 0
        while start + nperseg <= len(x):
            chunk = x[start:start + chunk_len]
            f, _t, sxx = sps.spectrogram(
                chunk, fs=sr, window=window, nperseg=nperseg, noverlap=noverlap,
                detrend=detrend, scaling="density", mode="psd",
                return_onesided=True,
            )
            if freqs is None:
                keep = f <= fmax
                freqs = f[keep]
            sxx = sxx[keep, :]
            if use_median:
                cols.append(sxx)
            else:
                s = sxx.sum(axis=1)
                total = s if total is None else total + s
            n_seg += sxx.shape[1]
            start += sxx.shape[1] * step
        # sanity: we should have consumed every full segment of the piece
        del n_in_piece

    if use_median:
        allcols = np.concatenate(cols, axis=1)
        psd = np.median(allcols, axis=1) / _median_bias(allcols.shape[1])
    else:
        psd = total / n_seg

    return {
        "freqs": freqs,
        "psd": psd,
        "n_segments": int(n_seg),
        "n_pieces": len(usable),
        "skipped_pieces": int(skipped),
        "freq_res_hz": float(sr / nperseg),
        "duration_s": total_samples / sr,
        "segment_s": nperseg / sr,
    }


# ---------------------------------------------------------------------------
# Line noise
# ---------------------------------------------------------------------------

def line_noise_mask(freqs: np.ndarray, params: dict) -> np.ndarray:
    """Boolean mask of bins within ±line_bw of each mains harmonic."""
    lf = float(params.get("line_freq") or 0)
    bw = float(params.get("line_bw_hz") or 1.0)
    nh = int(params.get("line_harmonics") or 5)
    mask = np.zeros(len(freqs), dtype=bool)
    if lf <= 0 or len(freqs) == 0:
        return mask
    # Always cover at least the bin nearest each harmonic, even when the
    # frequency resolution is coarser than the ± half-width.
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else 0.0
    half = max(bw, df * 0.5 + 1e-9)
    for k in range(1, nh + 1):
        h = k * lf
        if h > freqs[-1]:
            break
        mask |= np.abs(freqs - h) <= half
    return mask


def interpolate_over(freqs: np.ndarray, psd: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Replace masked bins by straight-line interpolation in log power, so a
    band integral isn't inflated by mains peaks or deflated by zeros."""
    if not mask.any() or mask.all():
        return psd
    out = psd.copy()
    good = ~mask
    logp = np.log(np.maximum(psd[good], 1e-300))
    out[mask] = np.exp(np.interp(freqs[mask], freqs[good], logp))
    return out


def line_noise_metrics(freqs: np.ndarray, psd: np.ndarray, params: dict) -> dict:
    """Per-harmonic prominence above the local floor, and total mains RMS.

    For each harmonic k·f₀: peak = largest bin within ±bw; floor = median of
    the flanks 2–6 Hz either side. ``prominence_db = 10·log10(peak/floor)``.
    ``rms`` is ``sqrt(Σ (psd − floor)·df)`` over the mains bins: the amplitude
    of the interference itself, in signal units.
    """
    lf = float(params.get("line_freq") or 0)
    bw = float(params.get("line_bw_hz") or 1.0)
    nh = int(params.get("line_harmonics") or 5)
    if lf <= 0 or len(freqs) < 3:
        return {"line_freq": lf, "harmonics": [], "rms": None, "reliable": False}
    df = float(freqs[1] - freqs[0])
    reliable = df <= 1.0
    half = max(bw, df * 0.5 + 1e-9)
    harmonics = []
    excess_power = 0.0
    for k in range(1, nh + 1):
        h = k * lf
        if h + 6.0 > freqs[-1]:
            break
        in_line = np.abs(freqs - h) <= half
        flank = (np.abs(freqs - h) >= 2.0) & (np.abs(freqs - h) <= 6.0)
        if not in_line.any() or flank.sum() < 2:
            continue
        floor = float(np.median(psd[flank]))
        peak = float(psd[in_line].max())
        prom = 10.0 * math.log10(peak / floor) if floor > 0 and peak > 0 else None
        excess = float(np.clip(psd[in_line] - floor, 0, None).sum() * df)
        excess_power += excess
        harmonics.append({
            "freq_hz": h,
            "prominence_db": prom,
            "rms": math.sqrt(excess),
        })
    return {
        "line_freq": lf,
        "harmonics": harmonics,
        "rms": math.sqrt(excess_power) if harmonics else None,
        "reliable": reliable,
    }


# ---------------------------------------------------------------------------
# Band power
# ---------------------------------------------------------------------------

def _power_in(freqs: np.ndarray, psd: np.ndarray, lo: float, hi: float, df: float) -> float:
    m = (freqs >= lo) & (freqs < hi)
    return float(psd[m].sum() * df) if m.any() else 0.0


def band_metrics(freqs: np.ndarray, psd: np.ndarray, params: dict) -> dict:
    """Total / band powers, relative powers and peak frequencies.

    ``fmin``–``fmax`` is the analysis range: total power, relative power and
    the dominant frequency all refer to it. Bands that fall outside the
    computed spectrum come back with ``power=None`` rather than 0, so a missing
    value is never mistaken for "no power".
    """
    if len(freqs) < 2:
        return {"total_power": None, "dominant_freq_hz": None, "bands": {}}
    df = float(freqs[1] - freqs[0])
    fmin = float(params.get("fmin") or 0.0)
    fmax = float(params.get("fmax") or freqs[-1])
    nyq_edge = float(freqs[-1]) + df / 2

    excl = bool(params.get("exclude_line_noise"))
    lmask = line_noise_mask(freqs, params) if excl else np.zeros(len(freqs), bool)
    clean = interpolate_over(freqs, psd, lmask)

    total = _power_in(freqs, clean, fmin, fmax, df)
    rng = (freqs >= fmin) & (freqs < fmax) & ~lmask
    dominant = float(freqs[rng][np.argmax(psd[rng])]) if rng.any() else None

    bands: dict[str, Any] = {}
    for b in params.get("bands") or []:
        name = str(b.get("name", "")).strip()
        try:
            lo, hi = float(b["low"]), float(b["high"])
        except (KeyError, TypeError, ValueError):
            continue
        if not name or hi <= lo:
            continue
        if hi > nyq_edge + 1e-9 or lo < float(freqs[0]):
            bands[name] = {"low": lo, "high": hi, "power": None, "relative": None,
                           "peak_freq_hz": None, "note": "outside computed spectrum"}
            continue
        pw = _power_in(freqs, clean, lo, hi, df)
        m = (freqs >= lo) & (freqs < hi) & ~lmask
        peak = float(freqs[m][np.argmax(psd[m])]) if m.any() else None
        inside_range = lo >= fmin - 1e-9 and hi <= fmax + 1e-9
        bands[name] = {
            "low": lo, "high": hi,
            "power": pw,
            # Relative power only makes sense for bands inside the
            # analysis range — otherwise it can exceed 1.
            "relative": (pw / total) if (total and inside_range) else None,
            "peak_freq_hz": peak,
        }
    return {
        "total_power": total,
        "dominant_freq_hz": dominant,
        "bands": bands,
        "line_noise_excluded": excl,
    }


# ---------------------------------------------------------------------------
# Display thinning
# ---------------------------------------------------------------------------

def thin_spectrum(freqs: np.ndarray, psd: np.ndarray, max_points: int = MAX_SPECTRUM_POINTS):
    """Reduce a long spectrum for display/storage, keeping the max of each
    bin group (so narrow peaks such as mains survive). Analysis numbers are
    always computed on the full-resolution spectrum before this."""
    n = len(freqs)
    if n <= max_points:
        return freqs, psd
    k = int(math.ceil(n / max_points))
    m = (n // k) * k
    f2 = freqs[:m].reshape(-1, k)
    p2 = psd[:m].reshape(-1, k)
    idx = np.argmax(p2, axis=1)
    rows = np.arange(len(idx))
    f_out, p_out = f2[rows, idx], p2[rows, idx]
    if m < n:
        j = m + int(np.argmax(psd[m:]))
        f_out = np.append(f_out, freqs[j])
        p_out = np.append(p_out, psd[j])
    return f_out, p_out


# ---------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------

def region_warnings(series, trace_idx: int, region: dict) -> list[str]:
    """What a region asks for that this recording doesn't have: a sweep
    range past its last sweep, or a time window past the sweep's end.
    The region is then analysed on what exists — so say so (a template's
    regions copied by Batch onto a shorter recording)."""
    out: list[str] = []
    n = series.sweep_count
    s0, s1 = region.get("sweep_from"), region.get("sweep_to")
    if s0 is not None and int(s0) > n - 1:
        out.append(f"starts at sweep {int(s0) + 1}, but this series has {n}")
    elif s1 is not None and int(s1) > n - 1:
        out.append(f"asks for sweeps up to {int(s1) + 1}; this series has {n}, so it stops at {n}")
    t1 = region.get("t_end")
    if t1 is not None and n > 0:
        first = int(s0 or 0) if s0 is not None and int(s0) < n else 0
        sw = series.sweeps[first]
        if trace_idx < sw.trace_count:
            tr = sw.traces[trace_idx]
            dur = tr.data.size / float(tr.sampling_rate) if tr.sampling_rate else 0.0
            if dur and float(t1) > dur + 1e-9:
                out.append(f"ends at {float(t1):g} s, but sweeps are {dur:g} s long, so it stops at {dur:g} s")
    return out


def region_sweeps(region: dict, sweep_count: int, excluded: Iterable[int] = ()) -> list[int]:
    """Sweeps covered by a region (1-based in the UI, 0-based here),
    minus the series' excluded sweeps."""
    ex = set(int(i) for i in excluded or ())
    s0 = region.get("sweep_from")
    s1 = region.get("sweep_to")
    s0 = 0 if s0 is None else max(0, int(s0))
    s1 = sweep_count - 1 if s1 is None else min(sweep_count - 1, int(s1))
    return [i for i in range(s0, s1 + 1) if i not in ex]


def region_pieces(series, trace_idx: int, region: dict, excluded: Iterable[int],
                  params: dict, scaled_fn) -> tuple[list[np.ndarray], float, str, list[int]]:
    """Slice one piece per sweep for a region. Filtering (if on) runs on the
    full sweep before slicing so region edges carry no filter transient."""
    sweeps = region_sweeps(region, series.sweep_count, excluded)
    pieces: list[np.ndarray] = []
    sr = None
    units = ""
    used: list[int] = []
    for si in sweeps:
        sw = series.sweeps[si]
        if trace_idx >= sw.trace_count:
            continue
        tr = sw.traces[trace_idx]
        if sr is None:
            sr, units = float(tr.sampling_rate), tr.units
        elif abs(float(tr.sampling_rate) - sr) > 1e-6:
            raise ValueError("Sweeps in this region have different sampling rates")
        x = prefilter(scaled_fn(tr), sr, params)
        t0 = region.get("t_start")
        t1 = region.get("t_end")
        i0 = 0 if t0 is None else max(0, int(round(float(t0) * sr)))
        i1 = len(x) if t1 is None else min(len(x), int(round(float(t1) * sr)))
        if i1 - i0 > 1:
            pieces.append(np.asarray(x[i0:i1], dtype=float))
            used.append(si)
    if sr is None:
        raise ValueError("No sweeps with this channel in the region")
    return pieces, sr, units, used


def analyse_region(pieces: list[np.ndarray], sr: float, params: dict) -> dict:
    """Full result for one region: spectrum (thinned), bands, line noise, RMS."""
    psd_info = compute_psd(pieces, sr, params)
    freqs, psd = psd_info["freqs"], psd_info["psd"]
    bands = band_metrics(freqs, psd, params)
    line = line_noise_metrics(freqs, psd, params)

    # Time-domain RMS after the same detrend the PSD uses (so it is the
    # broadband noise level, not the DC offset of the recording).
    detrend = _detrend_arg(params)
    ss, n = 0.0, 0
    for x in pieces:
        y = sps.detrend(x, type=detrend) if detrend else x
        ss += float(np.dot(y, y))
        n += len(y)
    rms = math.sqrt(ss / n) if n else None

    tf, tp = thin_spectrum(freqs, psd)
    return {
        "freqs": tf.tolist(),
        "psd": tp.tolist(),
        "n_segments": psd_info["n_segments"],
        "n_pieces": psd_info["n_pieces"],
        "skipped_pieces": psd_info["skipped_pieces"],
        "freq_res_hz": psd_info["freq_res_hz"],
        "duration_s": psd_info["duration_s"],
        "segment_s": psd_info["segment_s"],
        "rms": rms,
        **bands,
        "line_noise": line,
    }


def run_regions(series, trace_idx: int, regions: list[dict], params: dict,
                excluded: Iterable[int], scaled_fn) -> list[dict]:
    """Analyse every region. A failing region returns ``{"error": ...}``
    instead of aborting the others."""
    p = merged_params(params)
    partner = p.get("coupling_channel")
    coupling_on = bool(p.get("coupling_enabled")) and isinstance(partner, int) and partner != trace_idx
    out = []
    for r in regions:
        base = {"region_id": r.get("id"), "label": r.get("label")}
        warns = region_warnings(series, trace_idx, r)
        if warns:
            base["warnings"] = warns
        try:
            pieces, sr, units, used = region_pieces(series, trace_idx, r, excluded, p, scaled_fn)
            res = analyse_region(pieces, sr, p)
            row = {**base, **res, "units": units, "sampling_rate": sr, "sweeps_used": used}
            if coupling_on:
                row["coupling"] = _region_coupling(series, partner, r, excluded, p, scaled_fn,
                                                   pieces, used, sr)
            out.append(row)
        except Exception as e:  # noqa: BLE001 — surfaced per region in the UI
            out.append({**base, "error": str(e)})
    return out


def _region_coupling(series, partner: int, region: dict, excluded, p: dict, scaled_fn,
                     ref_pieces: list[np.ndarray], ref_used: list[int], sr: float) -> dict:
    """Coupling of the reference pieces with the partner channel over the
    same sweeps and times. Errors are returned in the block, not raised, so
    the region's own spectrum still shows."""
    from .coupling import analyse_coupling
    try:
        p_pieces, p_sr, p_units, p_used = region_pieces(series, partner, region, excluded, p, scaled_fn)
        if abs(p_sr - sr) > 1e-6:
            raise ValueError("The two channels have different sampling rates")
        by_sweep = dict(zip(p_used, p_pieces))
        xs, ys = [], []
        for si, x in zip(ref_used, ref_pieces):
            y = by_sweep.get(si)
            if y is None:
                continue
            n = min(len(x), len(y))
            xs.append(x[:n])
            ys.append(y[:n])
        if not xs:
            raise ValueError("The partner channel has no data in this region")
        block = analyse_coupling(xs, ys, sr, p)
        block["partner_channel"] = partner
        block["partner_units"] = p_units
        return block
    except Exception as e:  # noqa: BLE001
        return {"error": str(e), "partner_channel": partner}


# ---------------------------------------------------------------------------
# Band power over time
# ---------------------------------------------------------------------------

#: Upper bound on time bins per request, so a tiny step on a long
#: recording can't stall the backend.
MAX_TIMECOURSE_BINS = 20_000


def band_timecourse(series, trace_idx: int, params: dict, excluded: Iterable[int],
                    scaled_fn, bin_s: float, step_s: Optional[float] = None) -> dict:
    """Band powers in consecutive time bins, for every included sweep.

    Each bin is analysed exactly like a region (Welch with the current
    segment settings, then ``band_metrics``), so a bin's numbers are
    directly comparable with the region table. Bins never straddle two
    sweeps. Times are seconds within each sweep; ``sweep_offsets`` places
    sweeps end to end for plotting.
    """
    p = merged_params(params)
    bin_s = float(bin_s)
    step_s = float(step_s) if step_s else bin_s
    if bin_s <= 0 or step_s <= 0:
        raise ValueError("Bin length and step must be positive")
    if p.get("method", "welch") == "welch" and bin_s < float(p.get("segment_s") or 2.0):
        raise ValueError(
            f"Bin length ({bin_s:g} s) is shorter than the Welch segment "
            f"({float(p.get('segment_s') or 2.0):g} s). Use a longer bin or a shorter segment."
        )
    sweeps = region_sweeps({}, series.sweep_count, excluded)
    times: list[float] = []
    sweep_of: list[int] = []
    totals: list[Optional[float]] = []
    dominant: list[Optional[float]] = []
    rms: list[Optional[float]] = []
    band_pw: dict[str, list[Optional[float]]] = {}
    band_rel: dict[str, list[Optional[float]]] = {}
    sweep_offsets: dict[int, float] = {}
    sweep_durations: dict[int, float] = {}
    offset = 0.0
    units, sr0 = "", None
    detrend = _detrend_arg(p)
    for si in sweeps:
        sw = series.sweeps[si]
        if trace_idx >= sw.trace_count:
            continue
        tr = sw.traces[trace_idx]
        sr = float(tr.sampling_rate)
        units, sr0 = tr.units, sr
        x = prefilter(scaled_fn(tr), sr, p)
        dur = len(x) / sr
        sweep_offsets[si] = offset
        sweep_durations[si] = dur
        offset += dur
        nb = int(round(bin_s * sr))
        ns = max(1, int(round(step_s * sr)))
        start = 0
        while start + nb <= len(x):
            if len(times) >= MAX_TIMECOURSE_BINS:
                raise ValueError("Too many time bins — use a longer step")
            piece = np.asarray(x[start:start + nb], dtype=float)
            info = compute_psd([piece], sr, p)
            bm = band_metrics(info["freqs"], info["psd"], p)
            y = sps.detrend(piece, type=detrend) if detrend else piece
            times.append((start + nb / 2) / sr)
            sweep_of.append(si)
            totals.append(bm["total_power"])
            dominant.append(bm["dominant_freq_hz"])
            rms.append(float(np.sqrt(np.mean(y * y))))
            for name, b in bm["bands"].items():
                band_pw.setdefault(name, []).append(b.get("power"))
                band_rel.setdefault(name, []).append(b.get("relative"))
            start += ns
    if sr0 is None:
        raise ValueError("No sweeps with this channel")
    if not times:
        raise ValueError(f"Every sweep is shorter than one bin ({bin_s:g} s)")
    return {
        "times": times,
        "sweeps": sweep_of,
        "sweep_offsets": {str(k): v for k, v in sweep_offsets.items()},
        "sweep_durations": {str(k): v for k, v in sweep_durations.items()},
        "total_power": totals,
        "dominant_freq_hz": dominant,
        "rms": rms,
        "bands": {n: {"power": band_pw[n], "relative": band_rel.get(n)} for n in band_pw},
        "band_order": list(band_pw.keys()),
        "bin_s": bin_s,
        "step_s": step_s,
        "units": units,
        "sampling_rate": sr0,
    }


# ---------------------------------------------------------------------------
# Spectrogram
# ---------------------------------------------------------------------------

def compute_spectrogram(
    x: np.ndarray, sr: float, t_offset: float, params: dict,
    max_cols: int = 1200, max_rows: int = 256, max_cells: int = 3_000_000,
) -> dict:
    """Short-time PSD of one stretch of signal, reduced for display.

    The signal is first decimated (anti-aliased, zero-phase) when the
    requested ``fmax`` is far below Nyquist — hour-long 20 kHz recordings
    viewed to 100 Hz don't need 10 000 frequency bins. Columns are then
    averaged in power (not dB) down to ``max_cols``.
    """
    win_s = float(params.get("spec_window_s") or 1.0)
    ov = float(params.get("spec_overlap_pct") or 75.0)
    fmax = float(params.get("spec_fmax") or 100.0)
    fmin = float(params.get("spec_fmin") or 0.0)
    window = params.get("window", "hann")
    detrend = _detrend_arg(params)

    x = np.asarray(x, dtype=float)
    fs = sr
    fmax = min(fmax, sr / 2)
    # Decimate in stages of ≤ 10 down to ~2.5 × fmax.
    q_total = int(sr // (2.5 * fmax)) if fmax > 0 else 1
    while q_total >= 2 and len(x) > 64:
        q = min(q_total, 10)
        x = sps.decimate(x, q, ftype="fir", zero_phase=True)
        fs /= q
        q_total //= q
    nperseg = max(8, int(round(win_s * fs)))
    if len(x) < nperseg:
        raise ValueError(
            f"Visible stretch ({len(x) / fs:.3g} s) is shorter than the spectrogram "
            f"window ({win_s:g} s). Zoom out or shorten the window."
        )
    noverlap = min(nperseg - 1, int(round(nperseg * ov / 100.0)))
    f, t, sxx = sps.spectrogram(
        x, fs=fs, window=window, nperseg=nperseg, noverlap=noverlap,
        detrend=detrend, scaling="density", mode="psd",
    )
    keep = (f >= fmin) & (f <= fmax)
    f, sxx = f[keep], sxx[keep, :]

    # Reduce rows (frequency) by averaging power.
    if sxx.shape[0] > max_rows:
        k = int(math.ceil(sxx.shape[0] / max_rows))
        m = (sxx.shape[0] // k) * k
        sxx = sxx[:m, :].reshape(-1, k, sxx.shape[1]).mean(axis=1)
        f = f[:m].reshape(-1, k).mean(axis=1)

    # Reduce columns (time) by averaging power, keeping the matrix under
    # ``max_cells`` so a whole hour-long sweep stays a few MB.
    max_cols = max(50, min(max_cols, max_cells // max(1, sxx.shape[0])))
    if sxx.shape[1] > max_cols:
        k = int(math.ceil(sxx.shape[1] / max_cols))
        m = (sxx.shape[1] // k) * k
        head = sxx[:, :m].reshape(sxx.shape[0], -1, k).mean(axis=2)
        th = t[:m].reshape(-1, k).mean(axis=1)
        if m < sxx.shape[1]:
            head = np.concatenate([head, sxx[:, m:].mean(axis=1, keepdims=True)], axis=1)
            th = np.append(th, t[m:].mean())
        sxx, t = head, th
    db = 10.0 * np.log10(np.maximum(sxx, 1e-300))
    finite = db[np.isfinite(db)]
    return {
        "freqs": f.tolist(),
        "times": (t + t_offset).tolist(),
        "power_db": db.astype(np.float32),     # rows = freqs, cols = times
        "db_min": float(np.percentile(finite, 2)) if finite.size else 0.0,
        "db_max": float(np.percentile(finite, 99.5)) if finite.size else 1.0,
        "window_s": nperseg / fs,
        "freq_res_hz": fs / nperseg,
        "analysis_rate_hz": fs,
    }


# ---------------------------------------------------------------------------
# Legacy generic-endpoint wrapper
# ---------------------------------------------------------------------------

class SpectralAnalysis(AnalysisBase):
    """Kept so ``/api/analysis/run`` with ``analysis_type='spectral'`` still
    works on a single trace (whole sweep). The Spectral window uses
    ``/api/spectral/*`` instead."""

    name = "spectral"
    description = "Power spectral density, band power and line noise"

    def run(self, data: np.ndarray, sampling_rate: float, params: dict) -> dict:
        p = merged_params(params)
        x = prefilter(data, sampling_rate, p)
        return analyse_region([x], sampling_rate, p)


register_analysis(SpectralAnalysis())
