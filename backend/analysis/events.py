"""Event detection & analysis — spontaneous / evoked postsynaptic events.

Two detection families, sharing the same per-event kinetics pipeline:

1. **Template matching** — fit a biexponential template to an exemplar
   event, then score similarity between template and data at every
   sample. Two algorithms in Phase 1:

     a. *Correlation* (Jonas et al., 1993): Pearson r between template
        and data inside a sliding window. Uses the Clements–Bekkers
        sliding formulation for O(N·W) performance.

     b. *Deconvolution* (Pernía-Andrade et al., 2012): Fourier-domain
        deconvolution of data by template, then Gaussian-ish bandpass
        and threshold expressed as standard deviations of the
        amplitude distribution. Best for closely-spaced events.

2. **Thresholding** — sample-by-sample threshold crossing. Threshold
   can be RMS-based (``baseline ± n × rms_of_quiet_region``) or a
   fixed linear value. Cheaper, good for clean recordings.

Per-event kinetics (common to all detection modes):

- baseline via Jonas 1993 foot-intersect (line through 20–80 % rise
  points back-extrapolated to the pre-event baseline)
- smoothed peak (two-pass: detect on raw, refine on smoothed)
- amplitude, rise time (configurable %), decay time (% of amp),
  half-width (FWHM), AUC

Exclusion filter (applied after kinetics):

- amplitude-min / amplitude-max
- minimum inter-event interval (IEI)

Manual-edit replay: ``run_events`` accepts a dict with ``added``
(list of peak times in seconds) and ``removed_peak_times`` (same
format). Auto-detection runs first, removed peaks are dropped
(nearest auto peak within tolerance wins), added peaks are inserted
as manual events (snapped to the local max/min in a small window).
Each output event carries ``manual: bool`` for UI marker styling.

Unit-agnostic: the algorithms take an ndarray + sampling rate and
don't care whether the signal is pA (VC) or mV (CC). The caller
attaches units for display. All times in output are seconds.

All formulas cited inline. No code ported from copyleft sources.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np
from scipy.optimize import curve_fit
from scipy.signal import butter, sosfiltfilt
from scipy.stats import norm as scipy_norm


# ---------------------------------------------------------------------------
# Biexponential template
# ---------------------------------------------------------------------------

def biexp_event(t: np.ndarray, b0: float, b1: float,
                tau_rise: float, tau_decay: float) -> np.ndarray:
    """Biexponential event model (Jonas 1993 et al., Appendix I of EE).

    f(t) = b0 + b1 · (1 − exp(−t/τ_rise)) · exp(−t/τ_decay)

    ``t`` is in seconds, relative to event foot. ``tau_rise`` and
    ``tau_decay`` are in seconds. ``b1`` carries the sign (negative →
    downward event). ``b0`` is the baseline offset.
    """
    t = np.asarray(t, dtype=float)
    # Avoid overflow for very large t / small decay: the exp factor goes
    # to zero so the product is ~0 regardless of the (1−exp) term.
    with np.errstate(over="ignore", invalid="ignore"):
        rise = 1.0 - np.exp(-t / max(tau_rise, 1e-9))
        decay = np.exp(-t / max(tau_decay, 1e-9))
    return b0 + b1 * rise * decay


@dataclass
class TemplateFit:
    """Result of fitting a biexponential template to an exemplar region."""
    b0: float
    b1: float
    tau_rise_s: float
    tau_decay_s: float
    r_squared: float
    # For plotting back on the main viewer.
    time: np.ndarray            # seconds, relative to region start
    fit_values: np.ndarray      # biexp_event evaluated on `time`


def fit_biexponential(
    time: np.ndarray,
    values: np.ndarray,
    *,
    initial_rise_ms: float = 0.5,
    initial_decay_ms: float = 5.0,
    direction: str = "auto",
) -> TemplateFit:
    """Fit the biexponential event model to a region of data.

    The caller passes a windowed (time, values) pair — typically a
    user-drawn rectangle around a clean exemplar event. The region's
    first sample is treated as the event foot (t=0); the caller should
    drag the left edge to the foot before fitting for best results.

    Direction:
      - ``auto``   — sign of b1 inferred from data (mean < start → negative).
      - ``negative`` — force b1 < 0 (downward events, e.g. EPSCs in VC).
      - ``positive`` — force b1 > 0 (upward events, e.g. IPSPs in CC).
    """
    t = np.asarray(time, dtype=float)
    v = np.asarray(values, dtype=float)
    if t.size < 4 or v.size < 4:
        raise ValueError("Region too short to fit (need ≥ 4 samples)")
    if t.size != v.size:
        raise ValueError("time and values must be same length")

    # Normalise t to start at 0 — makes fitting numerically nice and
    # matches what the model expects.
    t0 = float(t[0])
    tt = t - t0

    # Seed estimates.
    b0_guess = float(np.mean(v[: max(3, len(v) // 10)]))  # baseline = first ~10%
    peak = float(v[np.argmax(np.abs(v - b0_guess))])
    b1_guess = peak - b0_guess
    if direction == "negative" and b1_guess > 0:
        b1_guess = -abs(b1_guess)
    elif direction == "positive" and b1_guess < 0:
        b1_guess = abs(b1_guess)

    tau_r0 = initial_rise_ms / 1000.0
    tau_d0 = initial_decay_ms / 1000.0
    p0 = (b0_guess, b1_guess, tau_r0, tau_d0)

    # Bounds:
    #   - τ_rise:  [0.01 ms, min(span, 100 ms)] — physical range for
    #              synaptic events; cap at span to avoid the fit
    #              drifting to a τ larger than the data window itself.
    #   - τ_decay: [0.1 ms, min(span × 5, 2000 ms)] — allow slow PSPs
    #              but stop the fit landing on absurd half-life values
    #              (e.g. a 270 ms "rise" on an EPSC).
    # b1 sign is either free ("auto") or forced to one side.
    span = max(tt[-1] - tt[0], 1e-3)
    tau_r_lo = 1e-5                # 0.01 ms
    tau_r_hi = min(span, 0.100)    # 100 ms OR data-window length, whichever smaller
    tau_d_lo = 1e-4                # 0.1 ms
    tau_d_hi = min(span * 5.0, 2.0)  # 2 s OR 5× window, whichever smaller
    if direction == "negative":
        b1_lo, b1_hi = -np.inf, 0.0
    elif direction == "positive":
        b1_lo, b1_hi = 0.0, np.inf
    else:
        b1_lo, b1_hi = -np.inf, np.inf
    # τ_decay is fitted as τ_rise + Δ with Δ ≥ 0, so the fit can't
    # swap the two: otherwise it can land on τ_rise > τ_decay with a
    # huge b1, a degenerate solution that describes the shape with the
    # labels the wrong way round.
    lo = (-np.inf, b1_lo, tau_r_lo, 0.0)
    hi = (np.inf, b1_hi, tau_r_hi, tau_d_hi)
    # Clamp the initial-guess τs into the bounds so curve_fit doesn't
    # start outside them (scipy raises if p0 ∉ bounds).
    tau_r0 = min(max(tau_r0, tau_r_lo * 1.01), tau_r_hi * 0.99)
    tau_d0 = min(max(tau_d0, tau_d_lo * 1.01), tau_d_hi * 0.99)
    delta0 = min(max(tau_d0 - tau_r0, tau_d_lo), tau_d_hi * 0.99)
    p0 = (b0_guess, b1_guess, tau_r0, delta0)

    def _model(t_, b0_, b1_, tr_, dd_):
        return biexp_event(t_, b0_, b1_, tr_, tr_ + dd_)

    try:
        popt, _ = curve_fit(
            _model, tt, v, p0=p0, bounds=(lo, hi), maxfev=5000,
        )
    except (RuntimeError, ValueError):
        # Fall back to seed if curve_fit can't converge.
        popt = np.array(p0, dtype=float)

    b0, b1, tau_r, delta = (float(x) for x in popt)
    tau_d = min(tau_r + delta, tau_d_hi)
    fit_v = biexp_event(tt, b0, b1, tau_r, tau_d)

    # R² — 1 - SSres / SStot (>= 0 when fit > mean-model, can go
    # negative for a bad fit, which we report honestly).
    ss_res = float(np.sum((v - fit_v) ** 2))
    ss_tot = float(np.sum((v - np.mean(v)) ** 2))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    return TemplateFit(
        b0=b0, b1=b1,
        tau_rise_s=tau_r, tau_decay_s=tau_d,
        r_squared=r2,
        time=tt,
        fit_values=fit_v,
    )


def render_template(
    b0: float, b1: float, tau_rise_s: float, tau_decay_s: float,
    width_ms: float, sr: float,
) -> np.ndarray:
    """Render the biexponential template over a fixed window.

    ``width_ms`` sets how many samples the template spans (typically
    ~5–10 × τ_decay so the event fully decays within the window).
    The detector uses the returned array directly — its length is
    the sliding-window size W.
    """
    n = max(4, int(round(width_ms / 1000.0 * sr)))
    t = np.arange(n, dtype=float) / sr
    return biexp_event(t, b0, b1, tau_rise_s, tau_decay_s)


# ---------------------------------------------------------------------------
# RMS / baseline helpers
# ---------------------------------------------------------------------------

@dataclass
class RmsResult:
    rms: float
    baseline_mean: float
    n_samples: int


def compute_rms(
    values: np.ndarray,
    start_idx: int,
    end_idx: int,
) -> RmsResult:
    """Compute RMS deviation + mean of a region (typically a quiet span).

    RMS is computed as sqrt(mean((x − mean(x))²)) — i.e. the sample
    standard deviation, numerically. The mean is also returned so the
    caller can use it as the threshold reference level.
    """
    start_idx = max(0, int(start_idx))
    end_idx = min(len(values), int(end_idx))
    if end_idx <= start_idx + 1:
        raise ValueError("RMS region is empty or too short")
    seg = np.asarray(values[start_idx:end_idx], dtype=float)
    mean = float(np.mean(seg))
    rms = float(np.sqrt(np.mean((seg - mean) ** 2)))
    return RmsResult(rms=rms, baseline_mean=mean, n_samples=len(seg))


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------

def _sliding_correlation(
    data: np.ndarray, template: np.ndarray,
) -> np.ndarray:
    """Pearson correlation of template vs data inside every sliding window.

    Output length = len(data) − len(template) + 1. Index i is the
    correlation of ``data[i:i+W]`` against ``template``.

    Clements-Bekkers-style closed form — one FFT convolution + a few
    cumulative-sums, no Python-level loop. O(N log N) time.
    """
    x = np.asarray(data, dtype=float)
    tmpl = np.asarray(template, dtype=float)
    n = len(x)
    w = len(tmpl)
    if w >= n:
        return np.zeros(0)

    tmpl_c = tmpl - np.mean(tmpl)
    tmpl_ss = float(np.sum(tmpl_c ** 2))
    if tmpl_ss <= 0:
        return np.zeros(n - w + 1)

    # Running sum and running sum of squares of the data in each window.
    cx = np.concatenate([[0.0], np.cumsum(x)])
    cx2 = np.concatenate([[0.0], np.cumsum(x * x)])
    win_sum = cx[w:] - cx[:-w]
    win_sum2 = cx2[w:] - cx2[:-w]
    win_mean = win_sum / w
    win_var = win_sum2 / w - win_mean ** 2
    win_std_sqn = np.sqrt(np.maximum(win_var, 0.0) * w)  # == sqrt(sum of squared deviations in window)

    # cross-correlation of centered template with data:
    #   numerator(i) = sum_k (data[i+k] - mean_i) * tmpl_c[k]
    # But (data[i+k] - mean_i)·tmpl_c[k] = data[i+k]·tmpl_c[k]
    # because sum tmpl_c[k] == 0. So we can ignore the mean subtraction.
    num = np.convolve(x, tmpl_c[::-1], mode="valid")

    denom = win_std_sqn * np.sqrt(tmpl_ss)
    # Protect against degenerate constant-data windows.
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(denom > 0, num / denom, 0.0)
    # r is clipped to the valid range by construction, but fp noise can
    # push it slightly out of [-1, 1].
    return np.clip(r, -1.0, 1.0)


def _deconvolve(
    data: np.ndarray, template: np.ndarray, sr: float,
    low_hz: float, high_hz: float,
    scale_template_to_data: bool = True,
) -> np.ndarray:
    """Pernía-Andrade et al. 2012 deconvolution — exact EE parity.

    Data and template go to the Fourier domain (where deconvolution is
    pointwise division), then filtered with an asymmetric Gaussian
    window (hard high-pass cutoff + Gaussian roll-off on the high end)
    before inverse FFT.

    Matches Easy Electrophysiology's implementation verbatim
    (voltage_calc.get_filtered_template_data_deconvolution +
    fft_filter_gaussian_window). In particular:

    - Pure unregularised division ``fft_data / fft_template`` rather
      than a Wiener-style regularisation. The Gaussian window handles
      the spectral-null problem by zeroing low frequencies and
      tapering high ones.
    - Gaussian window: ``1/sqrt(2π·high_hz/fs) · exp(-0.5·(f/high_hz)²)``,
      with frequencies below ``low_hz`` hard-zeroed. ``high_hz`` is
      therefore the Gaussian's σ in Hz, not a sharp cutoff.
    - Template zero-padded to data length before FFT (no reflection-
      padding — EE doesn't do it and the Gaussian filter attenuates
      edge artefacts on its own).

    ``scale_template_to_data`` multiplies the template so its peak
    amplitude matches the data's peak-to-peak range — matches EE's
    `deconvolution_template_detection` pre-scaling and keeps numerical
    conditioning sensible when the user's template b1 is on a wildly
    different scale from the actual events.
    """
    x = np.asarray(data, dtype=float)
    tmpl = np.asarray(template, dtype=float)
    n = len(x)
    if n < 16 or len(tmpl) < 4:
        return np.zeros(n)

    # Deconvolution needs the event shape alone. A template fitted on
    # raw data carries the recording's baseline as b0 (e.g. the holding
    # current); left in, the zero-padded template is a box of b0 with
    # the event on top, and the division finds the box, not the events.
    # (Correlation is unaffected: Pearson r ignores an offset.)
    tmpl = tmpl - tmpl[0]

    # Optional template-to-data rescaling (EE default).
    if scale_template_to_data:
        tmax, tmin = float(np.max(tmpl)), float(np.min(tmpl))
        t_range = tmax - tmin
        if t_range > 0:
            tmpl = tmpl / t_range * (float(np.max(x)) - float(np.min(x)))

    # Zero-pad template to data length.
    tmpl_padded = np.zeros(n, dtype=float)
    tmpl_padded[: len(tmpl)] = tmpl

    fft_data = np.fft.fft(x)
    fft_tmpl = np.fft.fft(tmpl_padded)
    # Unregularised pointwise division. Gaussian window zeros the low
    # bins (where fft_tmpl is tiny and the quotient would blow up) and
    # attenuates everything above the high-hz roll-off.
    with np.errstate(divide="ignore", invalid="ignore"):
        fft_deconv = fft_data / fft_tmpl
    fft_deconv = np.where(np.isfinite(fft_deconv), fft_deconv, 0.0)

    # Gaussian window in the frequency domain — EE's exact formula.
    freqs = np.fft.fftfreq(n, 1.0 / sr)
    with np.errstate(divide="ignore", invalid="ignore"):
        gauss = (1.0 / np.sqrt(2.0 * np.pi * high_hz / sr)
                 * np.exp(-0.5 * (freqs / high_hz) ** 2))
    gauss[np.abs(freqs) < low_hz] = 0.0
    fft_filt = gauss * fft_deconv * sr

    decon = np.real(np.fft.ifft(fft_filt))
    return decon


def _gaussian_fit_to_histogram(
    values: np.ndarray,
) -> tuple[float, float]:
    """Fit a Gaussian to the amplitude histogram, return (mu, sigma).

    EE's approach: bins = sqrt(N); 10× linear interpolation; then fit
    a Gaussian ``a · exp(-(x−mu)²/(2σ²))`` via least-squares. That σ
    is the sigma used for the ``threshold = n × σ`` cutoff.

    Falls back to mean / std of the central 90% of values if the
    Gaussian fit fails.
    """
    x = np.asarray(values, dtype=float).ravel()
    x = x[np.isfinite(x)]
    if x.size < 32:
        return float(np.mean(x) if x.size else 0.0), float(np.std(x) if x.size else 1.0)

    # Trim extremes so the event tail doesn't dominate the bin edges.
    lo, hi = np.percentile(x, [2.5, 97.5])
    if hi <= lo:
        return float(np.mean(x)), float(np.std(x))

    n_bins = max(16, int(np.sqrt(x.size)))
    hist_y, bin_edges = np.histogram(x, bins=n_bins, range=(lo, hi))
    # Bin centers for the x-axis of the Gaussian fit.
    bin_centers = 0.5 * (bin_edges[:-1] + bin_edges[1:])
    if np.max(hist_y) <= 0:
        return float(np.mean(x)), float(np.std(x))

    # Starting estimates.
    a0 = float(np.max(hist_y))
    mu0 = float(bin_centers[int(np.argmax(hist_y))])
    sigma0 = float(np.std(x))

    def gaussian(xx, a, mu, sigma):
        sig = max(float(sigma), 1e-12)
        return a * np.exp(-0.5 * ((xx - mu) / sig) ** 2)

    try:
        popt, _ = curve_fit(
            gaussian, bin_centers, hist_y.astype(float),
            p0=(a0, mu0, sigma0), maxfev=2000,
        )
        _, mu, sigma = popt
        sigma = abs(float(sigma))
        return float(mu), sigma if sigma > 0 else float(np.std(x))
    except (RuntimeError, ValueError):
        return float(np.mean(x)), float(np.std(x))


def _find_peaks_above(
    measure: np.ndarray, cutoff: float, min_dist: int,
    direction: int = 1,
) -> np.ndarray:
    """Find local extrema where ``direction * measure`` crosses cutoff.

    Returns sample indices of extrema (in ``measure``-space), sorted in
    time. Clustering runs above cutoff are each represented by the
    single sample where the measure is most extreme in that run. A
    minimum sample distance between successive extrema is enforced
    (when two extrema violate it, the more extreme one wins).
    """
    m = np.asarray(measure, dtype=float) * direction
    above = m >= cutoff
    if not np.any(above):
        return np.zeros(0, dtype=int)

    # Find contiguous runs above cutoff.
    runs = []
    start = None
    for i in range(len(above)):
        if above[i] and start is None:
            start = i
        elif not above[i] and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(above)))

    # For each run, the peak is argmax of measure within the run.
    peaks = []
    for a, b in runs:
        idx = int(a + np.argmax(m[a:b]))
        peaks.append(idx)
    peaks = np.asarray(peaks, dtype=int)
    if peaks.size <= 1 or min_dist <= 1:
        return peaks

    # Thin with minimum-distance enforcement (largest-first).
    order = np.argsort(-m[peaks])
    keep = np.ones(peaks.size, dtype=bool)
    for i in order:
        if not keep[i]:
            continue
        for j in range(peaks.size):
            if j == i or not keep[j]:
                continue
            if abs(peaks[j] - peaks[i]) < min_dist:
                keep[j] = False
    return np.sort(peaks[keep])


def _template_peak_offset(template: np.ndarray) -> int:
    """Samples from the template's start (the event foot) to its extremum."""
    t = np.asarray(template, dtype=float)
    return int(np.argmax(np.abs(t - t[0])))


def _refine_to_data_peak(
    values: np.ndarray, candidates, template: np.ndarray, sr: float,
    direction: str, drop_slopes: bool = True,
) -> np.ndarray:
    """Move each candidate (an index at the event's foot) to the data
    extremum where the template predicts the peak.

    The search runs from ``pre`` before the candidate to ``pre`` past
    the template's own peak (``pre`` = half the template's foot-to-peak
    time, at least 1 ms). A wider window (e.g. the whole template) lets
    a small event be moved onto a larger event that follows it, so the
    small one is lost and the large one counted twice.

    With ``drop_slopes`` (the default), a candidate whose extremum is not
    a peak is dropped: when the data ``pre`` samples before the extremum
    are more extreme, the window sits on the decay of an earlier, larger
    event and the "peak" is just the first sample of the window. Such
    candidates come from the deconvolution's residual on large events
    whose shape differs from the template. With ``drop_slopes=False``
    every candidate gives one peak.
    """
    x = np.asarray(values, dtype=float)
    tp = _template_peak_offset(template)
    pre = max(int(round(0.001 * sr)), tp // 2)
    sign = -1 if direction == "negative" else 1
    out = []
    for c in np.asarray(candidates, dtype=int):
        a = max(0, int(c) - pre)
        b = min(len(x), int(c) + tp + pre + 1)
        if b <= a + 1:
            out.append(int(c))
            continue
        seg = x[a:b]
        k = int(a + (np.argmin(seg) if sign < 0 else np.argmax(seg)))
        if drop_slopes and a > 0:
            back = sign * x[max(0, k - pre):k + 1]
            if int(np.argmax(back)) != back.size - 1:
                continue
        out.append(k)
    return np.asarray(out, dtype=int)


def _enforce_min_interval(
    values: np.ndarray, peaks, min_dist: int, direction: str, tags=None,
):
    """Drop peaks closer than ``min_dist`` samples to a larger one.

    Runs on data-space peaks (after refinement), so two candidates that
    were moved onto the same sample are merged. The most extreme peak
    wins; ties keep the earlier one. Returns sorted peaks, plus the
    matching ``tags`` (e.g. template indices) when given.
    """
    x = np.asarray(values, dtype=float)
    p = np.asarray(peaks, dtype=int)
    tg = list(tags) if tags is not None else [None] * len(p)
    if p.size == 0:
        return (p, []) if tags is not None else p
    order = np.argsort(p, kind="stable")
    p = p[order]
    tg = [tg[i] for i in order]
    # identical samples first
    _, first = np.unique(p, return_index=True)
    p = p[first]
    tg = [tg[i] for i in first]
    if min_dist > 1 and p.size > 1:
        mag = -x[p] if direction == "negative" else x[p]
        keep = np.ones(p.size, dtype=bool)
        for i in np.argsort(-mag, kind="stable"):
            if not keep[i]:
                continue
            lo = np.searchsorted(p, p[i] - min_dist + 1)
            hi = np.searchsorted(p, p[i] + min_dist)
            for j in range(lo, hi):
                if j != i:
                    keep[j] = False
        p = p[keep]
        tg = [t for t, k in zip(tg, keep) if k]
    return (p, tg) if tags is not None else p


def detect_correlation(
    values: np.ndarray, sr: float, template: np.ndarray,
    cutoff: float = 0.4,
    direction: str = "negative",
    min_iei_ms: float = 5.0,
) -> np.ndarray:
    """Return sample indices of candidate event peaks, correlation method.

    The index returned corresponds to the *data peak* (max deviation
    within the detected window), not the correlation maximum — because
    the correlation peak is at the window START, which is ~rise-time
    before the actual event peak.
    """
    r = _sliding_correlation(values, template)
    min_dist = max(1, int(round(min_iei_ms / 1000.0 * sr)))
    # For negative events the template itself is negative, so
    # correlation with a negative data dip gives positive r. We always
    # look for positive r peaks irrespective of event polarity.
    run_starts = _find_peaks_above(r, cutoff, min_dist, direction=1)

    # The correlation peak is where the template's start lines up with
    # the event foot. Move it to the data extremum near the template's
    # own peak, then enforce the minimum interval on the moved peaks.
    peaks = _refine_to_data_peak(values, run_starts, template, sr, direction)
    return _enforce_min_interval(values, peaks, min_dist, direction)


def detect_deconvolution(
    values: np.ndarray, sr: float, template: np.ndarray,
    cutoff_sd: float = 3.5,
    low_hz: float = 1.0,
    high_hz: float = 200.0,
    direction: str = "negative",
    min_iei_ms: float = 5.0,
) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Deconvolution event detection — Pernía-Andrade 2012, EE-compatible.

    Returns ``(peak sample indices, filtered deconvolution trace,
    mu, sigma)``. ``mu`` and ``sigma`` are the parameters of the
    Gaussian fitted to the deconvolution's amplitude histogram —
    callers can reconstruct the exact threshold line as
    ``mu ± cutoff_sd·sigma`` for a viewer overlay.

    For template matching with a biexp template whose b1 is negative
    (EPSC direction), the deconvolved signal has negative peaks at
    event locations. We search ``direction`` accordingly; EE does the
    same sign flip via ``null_wrong_direction_peaks``.
    """
    decon = _deconvolve(values, template, sr, low_hz, high_hz)
    mu, sigma = _gaussian_fit_to_histogram(decon)
    if sigma <= 0:
        return np.zeros(0, dtype=int), decon, mu, sigma

    threshold = cutoff_sd * sigma
    min_dist = max(1, int(round(min_iei_ms / 1000.0 * sr)))

    # EE's key behaviour: for deconvolution, detection ALWAYS searches
    # for POSITIVE peaks in the deconvolved signal. The template's
    # negative polarity (for EPSCs etc.) already inverts things inside
    # the FFT division — the deconv trace has positive spikes at
    # event times regardless of event sign. The user's ``direction``
    # choice only matters for the refinement step where we snap onto
    # the nearest data-space extremum.
    centered = decon - mu
    raw_peaks = _find_peaks_above(centered, threshold, min_dist, direction=1)
    if raw_peaks.size == 0:
        return np.zeros(0, dtype=int), decon, mu, sigma

    # Refine each deconvolution peak (at the event foot) to the data
    # extremum near the template's rise-to-peak time, as EE scales its
    # search region by the rise-to-peak samples. A fixed ±10 ms window
    # moved several candidates onto the same large event (duplicates).
    # The minimum interval is enforced again on the moved peaks.
    refined = _refine_to_data_peak(values, raw_peaks, template, sr, direction)
    return _enforce_min_interval(values, refined, min_dist, direction), decon, mu, sigma


def detect_threshold(
    values: np.ndarray, sr: float,
    *,
    threshold: float,
    direction: str = "negative",
    min_iei_ms: float = 5.0,
) -> np.ndarray:
    """Threshold-crossing event detection.

    Any sample on the "more extreme than threshold" side opens an event
    region; region closes on the return crossing. Peak within region
    is the most-extreme sample.
    """
    x = np.asarray(values, dtype=float)
    n = len(x)
    if direction == "negative":
        above = x <= threshold
    else:
        above = x >= threshold

    min_dist = max(1, int(round(min_iei_ms / 1000.0 * sr)))
    # Walk through runs.
    runs = []
    start = None
    for i in range(n):
        if above[i] and start is None:
            start = i
        elif not above[i] and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, n))

    peaks = []
    for a, b in runs:
        if direction == "negative":
            peaks.append(int(a + np.argmin(x[a:b])))
        else:
            peaks.append(int(a + np.argmax(x[a:b])))
    peaks = np.asarray(peaks, dtype=int)
    if peaks.size <= 1:
        return peaks

    # Thin with min-IEI enforcement (keep most extreme).
    order = np.argsort(-(x[peaks] if direction == "positive" else -x[peaks]))
    keep = np.ones(peaks.size, dtype=bool)
    for i in order:
        if not keep[i]:
            continue
        for j in range(peaks.size):
            if j == i or not keep[j]:
                continue
            if abs(peaks[j] - peaks[i]) < min_dist:
                keep[j] = False
    return np.sort(peaks[keep])


# ---------------------------------------------------------------------------
# Per-event kinetics — Jonas 1993 foot-intersect + standard metrics
# ---------------------------------------------------------------------------

@dataclass
class EventKinetics:
    peak_idx: int
    peak_val: float
    foot_idx: int
    baseline_val: float
    amplitude: float           # peak - baseline (signed)
    rise_time_ms: Optional[float]
    decay_time_ms: Optional[float]
    half_width_ms: Optional[float]
    auc: Optional[float]       # trapezoidal integral over (foot, decay endpoint)
    decay_endpoint_idx: Optional[int]
    # Per-event monoexponential decay fit: ``y = baseline + a · exp(-t/τ)``
    # fit to samples from peak → decay_endpoint. ``decay_tau_ms`` is the
    # τ in milliseconds; None when the fit can't run (too few samples,
    # degenerate amplitude, or scipy convergence failure).
    decay_tau_ms: Optional[float] = None
    # Per-event biexponential fit: ``y = b0 + b1·(1-exp(-t/τ_r))·exp(-t/τ_d)``
    # fit to the full event window (foot → decay_endpoint). Gives a
    # per-event τ_rise that the percent-crossing rise_time_ms can't
    # deliver on noisy events. All four parameters are reported so
    # the caller can validate fit quality (e.g. r² not stored yet but
    # a follow-up can add it). None when the fit fails.
    biexp_tau_rise_ms: Optional[float] = None
    biexp_tau_decay_ms: Optional[float] = None
    biexp_b0: Optional[float] = None
    biexp_b1: Optional[float] = None
    # Goodness-of-fit on the biexp — 1 = perfect, 0 = no better than
    # mean-model, negative = worse than mean-model. Used by the
    # "min R²" exclusion filter in ``run_events`` and to label the
    # fit overlay's quality in the UI.
    biexp_r2: Optional[float] = None


def _find_rise_crossing(
    seg: np.ndarray, baseline: float, target: float,
    rising: bool,
) -> Optional[int]:
    """Return the first index in ``seg`` where the signal reaches ``target``.

    ``rising=True`` is for the pre-peak rise (baseline → peak direction);
    ``rising=False`` is for the post-peak decay (peak → baseline).
    Linear interpolation is implicit in that we just return the nearest
    *index* — the caller converts to time. For sub-sample accuracy the
    caller can interpolate between adjacent samples.
    """
    if seg.size == 0:
        return None
    # "target crossed" means: (signal − target) changes sign.
    # Use robust direction-aware comparison.
    if (target - baseline) > 0:  # upward event: target above baseline
        crossed = seg >= target if rising else seg <= target
    else:                         # downward event: target below baseline
        crossed = seg <= target if rising else seg >= target
    idxs = np.flatnonzero(crossed)
    if idxs.size == 0:
        return None
    return int(idxs[0])


def _find_rise_crossing_near_peak(
    pre: np.ndarray, baseline: float, target: float,
) -> Optional[int]:
    """Rise-crossing nearest to the peak, scanning backward from the end.

    ``pre`` is a pre-peak window, ordered baseline → peak. This walks
    backward from the last sample and returns the latest index where
    ``pre[i]`` is still on the PEAK side of ``target``. That's the
    rise-crossing closest to the peak, which is what we want for
    computing rise time.

    Forward-scanning (via :func:`_find_rise_crossing`) returns the
    *first* crossing — which is wrong when baseline noise early in
    ``pre`` dips below the threshold, producing a false crossing far
    from the actual rise. This function ignores those excursions by
    construction.
    """
    n = pre.size
    if n == 0:
        return None
    upward = (target - baseline) > 0
    # "On peak side" means the signal has crossed past target toward peak.
    if upward:
        on_peak_side = pre >= target
    else:
        on_peak_side = pre <= target
    # End of pre (nearest sample to peak) is expected to be on peak
    # side. If it isn't, the rise-crossing hasn't happened inside this
    # window — tell the caller.
    if not on_peak_side[n - 1]:
        return None
    # Walk backward until we find the first sample that is NOT on peak
    # side. The crossing is the sample immediately after it.
    for i in range(n - 2, -1, -1):
        if not on_peak_side[i]:
            return i + 1
    # Whole window is on peak side — crossing sits before pre starts.
    return 0


def fit_polynomial_baseline(
    values: np.ndarray, sr: float, order: int, direction: str,
    *, percentile: float = 20.0,
) -> np.ndarray:
    """Fit a low-order polynomial baseline curve robust to events.

    ``order`` of 1–5 covers most drift shapes; higher orders quickly
    start tracking the events themselves. The fit uses only samples on
    the *opposite* side of the events: for ``direction='negative'``
    (downward EPSCs) we drop the bottom ``percentile`` of samples
    before fitting, so events don't drag the baseline down. Returns a
    float array of the same length as ``values`` ready to be indexed
    by per-event foot index.
    """
    n = len(values)
    if n == 0:
        return np.zeros(0, dtype=float)
    order = max(1, int(order))
    if n < order + 1:
        return np.full(n, float(np.mean(values)), dtype=float)
    t = np.arange(n, dtype=float) / sr
    pct = float(np.clip(percentile, 0.0, 49.0))
    if direction == "negative":
        # Negative events pull the trace below the baseline → drop the
        # bottom `pct` percent of samples (the event-side tail).
        thresh = float(np.percentile(values, pct))
        mask = values >= thresh
    else:
        thresh = float(np.percentile(values, 100.0 - pct))
        mask = values <= thresh
    if mask.sum() < order + 1:
        coeffs = np.polyfit(t, values, order)
    else:
        coeffs = np.polyfit(t[mask], values[mask], order)
    return np.polyval(coeffs, t).astype(float)


def measure_event_kinetics(
    values: np.ndarray, sr: float, peak_idx: int,
    *,
    direction: str = "negative",
    baseline_search_ms: float = 10.0,
    avg_baseline_ms: float = 1.0,
    # Default 0 → no boxcar smoothing on peak refinement. A uniform
    # kernel is SYMMETRIC but the EPSC / IPSC shape is NOT — fast
    # rise, slow decay — so convolving with a 1 ms kernel shifts the
    # extremum toward the decay side by ~½ kernel width and the
    # reported peak lands a couple of samples late. Opt in by setting
    # avg_peak_ms > 0 when you WANT the denoised position (e.g. very
    # noisy recordings where the raw sample argmin jitters).
    avg_peak_ms: float = 0.0,
    rise_low_pct: float = 10.0,
    rise_high_pct: float = 90.0,
    decay_pct: float = 37.0,
    decay_search_ms: float = 30.0,
    # How the decay endpoint is chosen post-peak:
    #   'first_cross' — first sample that returns to baseline within
    #     the search window (closest fallback if no crossing). Default;
    #     matches the prior behaviour and EE's "First Baseline Cross".
    #   'entire'      — endpoint is fixed at peak + decay_search_ms,
    #     regardless of where the trace actually returns to baseline.
    #     Matches EE's "Entire Search Region". Useful when events
    #     overlap heavily and crossings are ambiguous — gives a
    #     consistent integration window.
    decay_endpoint_method: str = "first_cross",
    # Pre-computed per-sample baseline curve (e.g. polynomial drift
    # estimate). When supplied, ``baseline`` is read off this curve at
    # the foot index instead of averaging the local pre-event window —
    # gives a drift-aware baseline for slow-baseline-trend recordings.
    # Length must equal ``len(values)``.
    baseline_curve: Optional[np.ndarray] = None,
    # Manual kinetics edits — when a value is provided, the auto-detected
    # landmark is REPLACED with the user-supplied sample index and the
    # downstream measurements (amplitude, rise, decay, FWHM, AUC, fit τ)
    # are recomputed against it. Used by the Edit-Kinetics drag mode.
    foot_idx_override: Optional[int] = None,
    decay_endpoint_idx_override: Optional[int] = None,
) -> EventKinetics:
    """Compute per-event kinetics around a detected peak.

    Follows EE's Jonas 1993 foot-intersect method for baseline / foot
    estimation:

    1. Find a rough pre-event baseline in the ``baseline_search_ms``
       window before the peak — the local extremum (min for downward
       events, max for upward) on the same side as the peak.
    2. Compute the 20 % and 80 % rise-amplitude points between baseline
       and peak (on raw data).
    3. Fit a line through those two points; where that line intersects
       the baseline-level is the event foot.
    4. Average a ``avg_baseline_ms`` window ending at the foot for the
       baseline Im value.

    Peak is refined to the average of a ``avg_peak_ms`` window around
    the raw peak to reduce noise bias (EE's approach).
    """
    n = len(values)
    if n == 0 or peak_idx < 0 or peak_idx >= n:
        return EventKinetics(
            peak_idx=peak_idx, peak_val=float("nan"),
            foot_idx=peak_idx, baseline_val=float("nan"),
            amplitude=float("nan"),
            rise_time_ms=None, decay_time_ms=None,
            half_width_ms=None, auc=None, decay_endpoint_idx=None,
        )

    sign = -1 if direction == "negative" else 1

    # ---- Refine peak ----
    #
    # Two paths depending on ``avg_peak_ms``:
    #
    # (a) ``avg_peak_ms > 0`` — boxcar-smooth a ± avg_peak window
    #     around the raw peak, take the argmin/max of the smoothed
    #     segment. Matches EE's original behaviour for noisy data
    #     where the raw-sample extremum jitters. CAUTION: the
    #     uniform kernel is symmetric but the event shape is not, so
    #     this biases the peak toward the decay side by ≈½ kernel
    #     width. Leave off unless recordings are very noisy.
    #
    # (b) ``avg_peak_ms == 0`` (default) — keep the raw-sample
    #     extremum index and parabola-interpolate peak_val across the
    #     three samples around it. Gives sub-sample-accurate peak
    #     value without the asymmetric-smoothing lag. peak_idx stays
    #     on the nearest integer sample; the stored peak_val is the
    #     parabola vertex.
    avg_peak_samples = int(round(avg_peak_ms / 1000.0 * sr)) if avg_peak_ms > 0 else 0
    if avg_peak_samples >= 1:
        # (a) smoothed-window refinement
        search = avg_peak_samples * 3
        s_a = max(0, peak_idx - search)
        s_b = min(n, peak_idx + search + 1)
        if s_b - s_a > 2 * avg_peak_samples:
            k = 2 * avg_peak_samples + 1
            pad = s_a
            local = np.asarray(values[s_a:s_b], dtype=float)
            if k >= local.size:
                smoothed = np.full_like(local, float(np.mean(local)))
            else:
                kernel = np.ones(k) / float(k)
                smoothed = np.convolve(local, kernel, mode="same")
            rel = int(np.argmin(smoothed)) if sign < 0 else int(np.argmax(smoothed))
            peak_idx = pad + rel
            peak_val = float(smoothed[rel])
        else:
            peak_val = float(values[peak_idx])
    else:
        # (b) parabolic sub-sample refinement — unbiased on
        # asymmetric events.
        if 0 < peak_idx < n - 1:
            y0 = float(values[peak_idx - 1])
            y1 = float(values[peak_idx])
            y2 = float(values[peak_idx + 1])
            denom = y0 - 2.0 * y1 + y2
            if denom != 0.0:
                # Vertex offset in samples, in (-0.5, 0.5) for a real peak.
                dx = 0.5 * (y0 - y2) / denom
                if -1.0 < dx < 1.0:
                    peak_val = y1 - 0.25 * (y0 - y2) * dx
                else:
                    peak_val = y1
            else:
                peak_val = y1
        else:
            peak_val = float(values[peak_idx])

    # ---- Rough pre-event baseline (Jonas step 1) ----
    bl_samples = max(1, int(round(baseline_search_ms / 1000.0 * sr)))
    bl_a = max(0, peak_idx - bl_samples)
    pre = values[bl_a:peak_idx]
    if pre.size < 2:
        rough_baseline = float(values[peak_idx])
    else:
        # Use the 25th percentile on the "less extreme" side — more
        # robust than min/max, less swayed by the rising edge.
        rough_baseline = float(np.percentile(pre, 75 if sign < 0 else 25))

    # ---- Rise 20/80 points between rough_baseline and peak ----
    #
    # Scan the pre-window BACKWARD from the peak side so baseline-noise
    # excursions earlier in the window can't masquerade as the rise.
    # The old forward scan returned the first crossing of t20 — which
    # for clean fast-rise events often landed deep in the pre-window
    # (on a noise sample) and inflated the reported rise time to tens
    # of ms. Walking back from peak picks the crossing nearest to the
    # peak, which is the ACTUAL rise onset.
    amp_rough = peak_val - rough_baseline
    if amp_rough == 0:
        foot_idx = max(0, peak_idx - 1)
        baseline = rough_baseline
    else:
        t20 = rough_baseline + 0.20 * amp_rough
        t80 = rough_baseline + 0.80 * amp_rough
        idx20 = _find_rise_crossing_near_peak(pre, rough_baseline, t20)
        idx80 = _find_rise_crossing_near_peak(pre, rough_baseline, t80)
        if idx20 is None or idx80 is None or idx80 <= idx20:
            # Fall back to the rough pre-event lookup.
            foot_idx = bl_a
            baseline = rough_baseline
        else:
            # Line through (idx20, t20) and (idx80, t80) back to
            # rough_baseline level → foot sample index.
            slope = (t80 - t20) / (idx80 - idx20)
            if abs(slope) < 1e-12:
                foot_rel = idx20
            else:
                foot_rel = idx20 + (rough_baseline - t20) / slope
            foot_idx = int(np.clip(bl_a + round(foot_rel), 0, peak_idx))
            # Average `avg_baseline_ms` window ending at the foot.
            bl_avg_samples = max(1, int(round(avg_baseline_ms / 1000.0 * sr)))
            ba = max(0, foot_idx - bl_avg_samples)
            bb = max(ba + 1, foot_idx + 1)
            baseline = float(np.mean(values[ba:bb]))

    # User foot override — Edit-Kinetics drag mode. Takes precedence
    # over auto-detected foot. Baseline is recomputed as the local mean
    # ending at the new foot (or read off baseline_curve below).
    if foot_idx_override is not None:
        try:
            new_foot = int(np.clip(int(foot_idx_override), 0, max(0, peak_idx)))
            foot_idx = new_foot
            bl_avg_samples = max(1, int(round(avg_baseline_ms / 1000.0 * sr)))
            ba = max(0, foot_idx - bl_avg_samples)
            bb = max(ba + 1, foot_idx + 1)
            baseline = float(np.mean(values[ba:bb]))
        except (TypeError, ValueError):
            pass

    # Drift-aware baseline override — when a per-sample baseline curve
    # was passed in (typically a polynomial fit to the whole sweep),
    # read the baseline value off that curve at the foot index. Skips
    # the local-mean step since the polynomial already captures the
    # slow-trend baseline. The foot index itself is unchanged — it's
    # still the Jonas line-intersect; only the *value* is replaced.
    if baseline_curve is not None and len(baseline_curve) == n:
        try:
            baseline = float(baseline_curve[foot_idx])
        except (IndexError, ValueError):
            pass

    amplitude = peak_val - baseline  # signed

    # ---- Rise time on refined baseline/peak ----
    if amplitude == 0:
        rise_time_ms: Optional[float] = None
    else:
        t_lo = baseline + (rise_low_pct / 100.0) * amplitude
        t_hi = baseline + (rise_high_pct / 100.0) * amplitude
        seg = values[foot_idx:peak_idx + 1]
        i_lo = _find_rise_crossing(seg, baseline, t_lo, rising=True)
        i_hi = _find_rise_crossing(seg, baseline, t_hi, rising=True)
        if i_lo is not None and i_hi is not None and i_hi > i_lo:
            rise_time_ms = (i_hi - i_lo) / sr * 1000.0
        else:
            rise_time_ms = None

    # ---- Decay endpoint — first sample back to baseline (or end of search window) ----
    # The helper's ``baseline`` parameter means the reference level to
    # compare direction against — always the per-event baseline here,
    # NOT the peak. Passing peak_val would make the helper think the
    # peak is itself "on the baseline side of target" and return the
    # very first sample (decay = 0 ms bug).
    decay_samples = max(1, int(round(decay_search_ms / 1000.0 * sr)))
    dec_a = peak_idx
    dec_b = min(n, peak_idx + decay_samples + 1)
    post = values[dec_a:dec_b]
    decay_endpoint_idx: Optional[int] = None
    if decay_endpoint_method == "entire":
        # Fixed endpoint at the far edge of the search window. EE's
        # "Entire Search Region" — gives a deterministic integration
        # window when events overlap and baseline crossings are noisy.
        if dec_b > dec_a:
            decay_endpoint_idx = int(dec_b - 1)
    elif post.size > 1:
        i_back = _find_rise_crossing(post, baseline, baseline, rising=False)
        if i_back is not None:
            decay_endpoint_idx = int(dec_a + i_back)
        else:
            # No full return — use the sample closest to baseline.
            decay_endpoint_idx = int(dec_a + np.argmin(np.abs(post - baseline)))

    # User decay-endpoint override — Edit-Kinetics drag mode. Takes
    # precedence over auto-detected endpoint. Clamp to (peak, n) so a
    # nonsense click can't break the downstream slicing.
    if decay_endpoint_idx_override is not None:
        try:
            new_dep = int(np.clip(int(decay_endpoint_idx_override),
                                  peak_idx + 1, n - 1))
            decay_endpoint_idx = new_dep
        except (TypeError, ValueError):
            pass

    # ---- Decay time to decay_pct of amplitude ----
    if amplitude == 0 or decay_endpoint_idx is None:
        decay_time_ms: Optional[float] = None
    else:
        t_decay = baseline + (decay_pct / 100.0) * amplitude
        seg = values[peak_idx:decay_endpoint_idx + 1]
        i_dec = _find_rise_crossing(seg, baseline, t_decay, rising=False)
        decay_time_ms = (i_dec / sr * 1000.0) if i_dec is not None else None

    # ---- Half-width (FWHM on raw data) ----
    half_width_ms: Optional[float] = None
    if amplitude != 0:
        half = baseline + 0.5 * amplitude
        # Pre-peak crossing (rising side).
        pre_seg = values[foot_idx:peak_idx + 1]
        i_pre = _find_rise_crossing(pre_seg, baseline, half, rising=True)
        # Post-peak crossing (decay side) — pass baseline, not peak.
        post_seg = values[peak_idx:(decay_endpoint_idx or dec_b) + 1]
        i_post = _find_rise_crossing(post_seg, baseline, half, rising=False)
        if i_pre is not None and i_post is not None:
            t_pre = (foot_idx + i_pre) / sr
            t_post = (peak_idx + i_post) / sr
            if t_post > t_pre:
                half_width_ms = (t_post - t_pre) * 1000.0

    # ---- AUC (trapezoidal, over foot → decay endpoint, baseline-subtracted) ----
    auc: Optional[float] = None
    if decay_endpoint_idx is not None and decay_endpoint_idx > foot_idx:
        seg = values[foot_idx:decay_endpoint_idx + 1] - baseline
        dt = 1.0 / sr
        # NumPy 2.0 renamed trapz → trapezoid; use the new name.
        auc = float(np.trapezoid(seg, dx=dt))

    # ---- Per-event decay τ (monoexponential fit, peak → endpoint) ----
    # Fit ``y = baseline + a · exp(-t/τ)`` to the decay phase. Reports
    # the decay time constant directly, rather than the percent-drop
    # heuristic used for ``decay_time_ms``. Matches EE's per-event τ
    # column. Fails silently (returns None) on short windows or
    # degenerate data — those events just don't get a τ column value.
    decay_tau_ms: Optional[float] = None
    if (decay_endpoint_idx is not None
            and decay_endpoint_idx > peak_idx + 2
            and amplitude != 0):
        dec_seg = np.asarray(values[peak_idx:decay_endpoint_idx + 1], dtype=float)
        t_dec = np.arange(dec_seg.size, dtype=float) / sr
        try:
            # Model with fixed baseline — leaves just (a, τ). Seed a
            # from the peak's baseline-subtracted amplitude; seed τ
            # from the decay_time_ms (percent-drop) estimate if we
            # have one, else a tenth of the window.
            a0 = float(dec_seg[0]) - baseline
            if a0 == 0:
                a0 = amplitude  # fallback
            tau0 = (decay_time_ms / 1000.0) if decay_time_ms else max(
                1e-4, t_dec[-1] / 10.0)
            def _monoexp(t, a, tau):
                return baseline + a * np.exp(-t / max(tau, 1e-9))
            bounds_lo = (-np.inf, 1e-5)
            bounds_hi = (np.inf, max(t_dec[-1] * 5.0, 1e-4))
            popt, _ = curve_fit(
                _monoexp, t_dec, dec_seg,
                p0=(a0, min(max(tau0, bounds_lo[1] * 1.01), bounds_hi[1] * 0.99)),
                bounds=(bounds_lo, bounds_hi),
                maxfev=1000,
            )
            tau_s = float(popt[1])
            if tau_s > 0:
                decay_tau_ms = tau_s * 1000.0
        except (RuntimeError, ValueError):
            decay_tau_ms = None

    # ---- Per-event biexponential fit (foot → endpoint) ----
    # Uses the shared `fit_biexponential` helper, same model as the
    # template generator. Gives us a per-event τ_rise — the
    # percent-threshold rise_time_ms is useful for a quick-look but
    # misbehaves on noisy events where the 10 %/90 % crossings don't
    # reflect the real kinetics. Direction comes from the sign of the
    # amplitude so the fit knows where to put b1.
    biexp_tau_rise_ms: Optional[float] = None
    biexp_tau_decay_ms: Optional[float] = None
    biexp_b0: Optional[float] = None
    biexp_b1: Optional[float] = None
    biexp_r2: Optional[float] = None
    if (decay_endpoint_idx is not None
            and decay_endpoint_idx - foot_idx >= 6
            and amplitude != 0):
        try:
            seg_t = np.arange(decay_endpoint_idx - foot_idx + 1,
                              dtype=float) / sr
            seg_v = np.asarray(values[foot_idx:decay_endpoint_idx + 1], dtype=float)
            direction = "negative" if amplitude < 0 else "positive"
            fit = fit_biexponential(
                seg_t, seg_v,
                initial_rise_ms=max(0.2, (rise_time_ms or 0.5) * 0.5),
                initial_decay_ms=max(1.0, decay_tau_ms or
                                     (decay_time_ms or 5.0)),
                direction=direction,
            )
            biexp_b0 = fit.b0
            biexp_b1 = fit.b1
            biexp_tau_rise_ms = fit.tau_rise_s * 1000.0
            biexp_tau_decay_ms = fit.tau_decay_s * 1000.0
            biexp_r2 = float(fit.r_squared)
        except (RuntimeError, ValueError):
            pass

    return EventKinetics(
        peak_idx=peak_idx,
        peak_val=peak_val,
        foot_idx=foot_idx,
        baseline_val=baseline,
        amplitude=amplitude,
        rise_time_ms=rise_time_ms,
        decay_time_ms=decay_time_ms,
        half_width_ms=half_width_ms,
        auc=auc,
        decay_endpoint_idx=decay_endpoint_idx,
        decay_tau_ms=decay_tau_ms,
        biexp_tau_rise_ms=biexp_tau_rise_ms,
        biexp_tau_decay_ms=biexp_tau_decay_ms,
        biexp_b0=biexp_b0,
        biexp_b1=biexp_b1,
        biexp_r2=biexp_r2,
    )


# ---------------------------------------------------------------------------
# Top-level pipeline
# ---------------------------------------------------------------------------

@dataclass
class EventRecord:
    """One detected event with full kinetics, ready for the results table."""
    sweep: int                 # index into the series's sweep list
    peak_idx: int              # sample index within that sweep
    peak_time_s: float         # absolute time in the sweep
    peak_val: float
    foot_idx: int
    foot_time_s: float
    baseline_val: float
    amplitude: float
    rise_time_ms: Optional[float]
    decay_time_ms: Optional[float]
    half_width_ms: Optional[float]
    auc: Optional[float]
    decay_endpoint_idx: Optional[int]
    decay_tau_ms: Optional[float] = None
    # Per-event biexp fit coefficients — see EventKinetics docstring.
    biexp_tau_rise_ms: Optional[float] = None
    biexp_tau_decay_ms: Optional[float] = None
    biexp_b0: Optional[float] = None
    biexp_b1: Optional[float] = None
    # R² of the per-event biexp fit. ``None`` when the fit didn't run
    # (window too short, degenerate amplitude, scipy failure). Used by
    # the "min R²" filter and surfaced in the UI as fit-quality colour.
    biexp_r2: Optional[float] = None
    manual: bool = False
    # Multi-template detection only — 0-based index into the templates
    # list at run time identifying which template's similarity measure
    # produced this peak. None for single-template, threshold method,
    # and manually-added events. Persists round-trip so the UI can
    # color peaks by template across windows / sessions.
    template_idx: Optional[int] = None
    # User-assigned curation group (1–5; None = ungrouped). Used for
    # filtering / coloring in the results table + viewer markers.
    # Round-trips through the .tracer sidecar like every other
    # field. Detection never sets this; assignment is purely manual.
    group: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "sweep": int(self.sweep),
            "peak_idx": int(self.peak_idx),
            "peak_time_s": float(self.peak_time_s),
            "peak_val": float(self.peak_val),
            "foot_idx": int(self.foot_idx),
            "foot_time_s": float(self.foot_time_s),
            "baseline_val": float(self.baseline_val),
            "amplitude": float(self.amplitude),
            "rise_time_ms": None if self.rise_time_ms is None else float(self.rise_time_ms),
            "decay_time_ms": None if self.decay_time_ms is None else float(self.decay_time_ms),
            "half_width_ms": None if self.half_width_ms is None else float(self.half_width_ms),
            "auc": None if self.auc is None else float(self.auc),
            "decay_endpoint_idx": (
                None if self.decay_endpoint_idx is None else int(self.decay_endpoint_idx)
            ),
            "decay_tau_ms": None if self.decay_tau_ms is None else float(self.decay_tau_ms),
            "biexp_tau_rise_ms": None if self.biexp_tau_rise_ms is None
                else float(self.biexp_tau_rise_ms),
            "biexp_tau_decay_ms": None if self.biexp_tau_decay_ms is None
                else float(self.biexp_tau_decay_ms),
            "biexp_b0": None if self.biexp_b0 is None else float(self.biexp_b0),
            "biexp_b1": None if self.biexp_b1 is None else float(self.biexp_b1),
            "biexp_r2": None if self.biexp_r2 is None else float(self.biexp_r2),
            "manual": bool(self.manual),
            "template_idx": None if self.template_idx is None else int(self.template_idx),
            "group": None if self.group is None else int(self.group),
        }


def run_events(
    values: np.ndarray, sr: float,
    *,
    method: str,                            # 'template_correlation' | 'template_deconvolution' | 'threshold'
    # template params (used for the two template methods)
    template: Optional[np.ndarray] = None,
    # Optional multi-template detection (EE parity). When supplied with
    # ≥ 2 entries, detection runs independently for each template and
    # the peak sets are merged (correlation: pointwise max of r(t);
    # deconvolution: union of detected peaks, with min_iei enforced on
    # the merged set). The first entry becomes the "primary" template
    # whose detection measure is returned for overlay display.
    templates: Optional[list[np.ndarray]] = None,
    cutoff: float = 0.4,                    # correlation cutoff OR deconvolution SD cutoff
    deconv_low_hz: float = 0.1,
    deconv_high_hz: float = 200.0,
    # threshold params (used for 'threshold')
    threshold_value: Optional[float] = None,
    # common
    direction: str = "negative",
    min_iei_ms: float = 5.0,
    # kinetics params (forwarded)
    baseline_search_ms: float = 10.0,
    avg_baseline_ms: float = 1.0,
    avg_peak_ms: float = 1.0,
    rise_low_pct: float = 10.0,
    rise_high_pct: float = 90.0,
    decay_pct: float = 37.0,
    decay_search_ms: float = 30.0,
    # Per-event baseline detection method:
    #   'auto'       — Jonas line-intersect + local mean (default)
    #   'polynomial' — fit a low-order polynomial to the whole sweep
    #                  (events excluded by percentile clipping) and
    #                  read the baseline off the curve at each foot.
    # Useful for recordings with slow drift the rolling-median detrend
    # over-smooths.
    baseline_method: str = "auto",
    baseline_poly_order: int = 2,
    # Decay-endpoint method: 'first_cross' (default) or 'entire'.
    # See measure_event_kinetics docstring.
    decay_endpoint_method: str = "first_cross",
    # exclusion
    amplitude_min_abs: float = 5.0,
    amplitude_max_abs: float = 2000.0,
    # Reject events whose biexp R² falls below this. None disables.
    # Auto-detected events only — manual adds always pass.
    biexp_min_r2: Optional[float] = None,
    auc_min_abs: Optional[float] = None,
    rise_max_ms: Optional[float] = None,
    decay_max_ms: Optional[float] = None,
    fwhm_max_ms: Optional[float] = None,
    # Manual skip regions — list of (start_s, end_s). Peaks whose time
    # lies inside ANY region get dropped. Applied AFTER detection but
    # BEFORE manual adds, so users can still force-add an event inside
    # a skip region (rare but useful).
    skip_regions: Optional[list[list[float]]] = None,
    # manual edits
    manual_added_times: Optional[list[float]] = None,   # seconds within this sweep
    manual_removed_times: Optional[list[float]] = None,
    removed_tol_ms: float = 2.0,
    sweep_index: int = 0,
    # Optional within-sweep progress callback. Called with a float in
    # [0, 1] at a few points: ~0.05 right after detection finishes,
    # then incrementally through the kinetics loop, and finally 1.0
    # when the sweep is fully processed. The streaming /detect_stream
    # endpoint forwards these to the UI so single-sweep detections
    # also show a moving progress bar (per-sweep granularity alone
    # gave one tick at the end, useless for single-sweep work).
    progress_cb: Optional[Callable[[float], None]] = None,
) -> tuple[list[EventRecord], Optional[np.ndarray]]:
    """Run the full event-detection + kinetics pipeline on one sweep.

    Returns (events, detection_measure). The detection measure is the
    correlation or deconvolution trace (for plotting overlay); None for
    the threshold method.
    """
    # Helper that swallows callback errors so a buggy UI hook can
    # never crash detection. Also clamps to [0, 1].
    def _tick(frac: float) -> None:
        if progress_cb is None:
            return
        try:
            progress_cb(max(0.0, min(1.0, float(frac))))
        except Exception:
            pass
    x = np.asarray(values, dtype=float)
    detection_measure: Optional[np.ndarray] = None

    # ---- Step 1: candidate peak indices ----
    # Multi-template consolidation. If the caller supplied a list of
    # templates (EE's up-to-3 detection), run detection per template
    # and merge the peak sets; the "primary" template's detection
    # measure is what we return for the overlay (arbitrary but
    # consistent — it's the one the UI has the cutoff slider wired to).
    tmpl_list: list[np.ndarray] = []
    if templates:
        tmpl_list = [np.asarray(t, dtype=float) for t in templates
                     if t is not None and len(t) >= 4]
    if not tmpl_list and template is not None and len(template) >= 4:
        tmpl_list = [np.asarray(template, dtype=float)]

    # Per-peak template index — populated only for multi-template runs
    # so the frontend can color markers by which template fired. ``None``
    # entries (single-template / threshold / manual) leave the marker at
    # the default color.
    peak_template_idxs: list[Optional[int]] = []
    if method == "template_correlation":
        if not tmpl_list:
            raise ValueError("template_correlation requires a template of ≥ 4 samples")
        if len(tmpl_list) == 1:
            peak_idxs = detect_correlation(
                x, sr, tmpl_list[0],
                cutoff=cutoff, direction=direction, min_iei_ms=min_iei_ms,
            )
            detection_measure = _sliding_correlation(x, tmpl_list[0])
            peak_template_idxs = [None] * len(peak_idxs)
        else:
            # Pointwise max of correlation traces across templates.
            # Align to shortest output length (len N − W_max + 1).
            r_traces = [_sliding_correlation(x, t) for t in tmpl_list]
            min_len = min(len(r) for r in r_traces)
            stacked = np.stack([r[:min_len] for r in r_traces])
            r_max = np.max(stacked, axis=0)
            # Find peaks in the max trace — EE's behaviour (positive
            # peaks because correlation is always positive for aligned
            # events regardless of polarity).
            min_dist = max(1, int(round(min_iei_ms / 1000.0 * sr)))
            peak_idxs_raw = _find_peaks_above(r_max, cutoff, min_dist, direction=1)
            # Refine each peak by snapping to the local extremum of the
            # RAW trace — otherwise peak_idx might sit on a correlation
            # lobe rather than the trace extremum.
            peak_idxs = []
            for pi in peak_idxs_raw:
                # Tag template by argmax across templates AT the raw
                # peak position (where r_max was found) — that's where
                # the per-template r is the actual contributor, not the
                # snapped sample which may be a few ms off.
                t_idx = int(np.argmax(stacked[:, pi]))
                peak_template_idxs.append(t_idx)
                # Move to the data extremum near that template's peak.
                ref = _refine_to_data_peak(x, [pi], tmpl_list[t_idx], sr, direction)
                if ref.size == 0:          # on the decay of a larger event
                    peak_template_idxs.pop()
                    continue
                peak_idxs.append(int(ref[0]))
            detection_measure = r_traces[0]  # primary template's DM for overlay
    elif method == "template_deconvolution":
        if not tmpl_list:
            raise ValueError("template_deconvolution requires a template of ≥ 4 samples")
        if len(tmpl_list) == 1:
            peak_idxs, decon, _mu, _sigma = detect_deconvolution(
                x, sr, tmpl_list[0],
                cutoff_sd=cutoff, low_hz=deconv_low_hz, high_hz=deconv_high_hz,
                direction=direction, min_iei_ms=min_iei_ms,
            )
            detection_measure = decon
            peak_template_idxs = [None] * len(peak_idxs)
        else:
            # Union of per-template peak sets. Deconvolution traces
            # differ in amplitude per template (different b1) so we
            # can't just stack + max; detect per-template and merge.
            # Track which template each candidate came from so we can
            # carry the tag through the merge step.
            sign = -1 if direction == "negative" else 1
            all_peaks: list[tuple[int, int]] = []   # (peak_idx, template_idx)
            primary_decon: Optional[np.ndarray] = None
            for i, t in enumerate(tmpl_list):
                pidxs, decon_i, _mu, _sigma = detect_deconvolution(
                    x, sr, t,
                    cutoff_sd=cutoff, low_hz=deconv_low_hz, high_hz=deconv_high_hz,
                    direction=direction, min_iei_ms=min_iei_ms,
                )
                if i == 0:
                    primary_decon = decon_i
                all_peaks.extend((int(p), i) for p in pidxs)
            # Merge: sort by peak idx, then enforce min_iei — when two
            # peaks from different templates are within min_iei_ms of
            # each other, keep the one whose trace extremum is larger.
            all_peaks.sort(key=lambda pt: pt[0])
            min_dist = max(1, int(round(min_iei_ms / 1000.0 * sr)))
            merged: list[tuple[int, int]] = []
            for pi, tidx in all_peaks:
                if merged and pi - merged[-1][0] < min_dist:
                    prev_v = abs(float(x[merged[-1][0]]))
                    this_v = abs(float(x[pi]))
                    if this_v > prev_v:
                        merged[-1] = (pi, tidx)
                else:
                    merged.append((pi, tidx))
            peak_idxs = [pi for pi, _ in merged]
            peak_template_idxs = [tidx for _, tidx in merged]
            detection_measure = primary_decon
    elif method == "threshold":
        if threshold_value is None:
            raise ValueError("threshold method requires threshold_value")
        peak_idxs = detect_threshold(
            x, sr,
            threshold=threshold_value, direction=direction,
            min_iei_ms=min_iei_ms,
        )
        peak_template_idxs = [None] * len(peak_idxs)
    else:
        raise ValueError(f"Unknown method: {method!r}")

    # Sanity: the template-idx list MUST be the same length as the peak
    # list at every transformation step below. Re-pad here in case any
    # detector forgot to populate it (defensive — shouldn't happen).
    if len(peak_template_idxs) != len(peak_idxs):
        peak_template_idxs = [None] * len(peak_idxs)

    # No two detections closer than the minimum interval, measured on
    # the final (data-space) peaks. Covers the multi-template merges,
    # whose candidates are refined per template.
    _md = max(1, int(round(min_iei_ms / 1000.0 * sr)))
    peak_idxs, peak_template_idxs = _enforce_min_interval(
        x, peak_idxs, _md, direction, tags=peak_template_idxs)
    peak_template_idxs = list(peak_template_idxs)

    # ---- Step 1.5: apply manual skip regions ----
    # Drop any detected peak whose time falls inside a skip region.
    # Applied BEFORE manual adds so the user can still force-add an
    # event inside a skip region if the region was too aggressive.
    peak_idxs = list(peak_idxs)
    if skip_regions:
        kept_idx: list[int] = []
        kept_tidx: list[Optional[int]] = []
        for pi, ti in zip(peak_idxs, peak_template_idxs):
            t = pi / sr
            drop = False
            for r in skip_regions:
                if len(r) >= 2 and r[0] <= t <= r[1]:
                    drop = True
                    break
            if not drop:
                kept_idx.append(pi)
                kept_tidx.append(ti)
        peak_idxs = kept_idx
        peak_template_idxs = kept_tidx

    # ---- Step 2: apply manual edits (remove first, then add) ----
    manual_added_times = list(manual_added_times or [])
    manual_removed_times = list(manual_removed_times or [])
    manual_flags = [False] * len(peak_idxs)

    if manual_removed_times and peak_idxs:
        rem_samples = [int(round(t * sr)) for t in manual_removed_times]
        tol = max(1, int(round(removed_tol_ms / 1000.0 * sr)))
        kept_idx2: list[int] = []
        kept_manual: list[bool] = []
        kept_tidx2: list[Optional[int]] = []
        for pi, mf, ti in zip(peak_idxs, manual_flags, peak_template_idxs):
            drop = any(abs(pi - rs) <= tol for rs in rem_samples)
            if not drop:
                kept_idx2.append(pi)
                kept_manual.append(mf)
                kept_tidx2.append(ti)
        peak_idxs = kept_idx2
        manual_flags = kept_manual
        peak_template_idxs = kept_tidx2

    if manual_added_times:
        sign = -1 if direction == "negative" else 1
        snap = max(1, int(round(0.5 * min_iei_ms / 1000.0 * sr)))  # ±½·min_IEI
        for t in manual_added_times:
            c = int(round(t * sr))
            a = max(0, c - snap)
            b = min(len(x), c + snap + 1)
            if b <= a + 1:
                continue
            seg = x[a:b]
            pi = int(a + (np.argmin(seg) if sign < 0 else np.argmax(seg)))
            # Dedup against existing peaks (closer than min_iei tolerance).
            tol = max(1, int(round(0.5 * min_iei_ms / 1000.0 * sr)))
            if any(abs(pi - existing) <= tol for existing in peak_idxs):
                continue
            peak_idxs.append(pi)
            manual_flags.append(True)
            peak_template_idxs.append(None)  # manual events have no template

    # Sort by time for downstream stability.
    order = np.argsort(peak_idxs)
    peak_idxs = [peak_idxs[i] for i in order]
    manual_flags = [manual_flags[i] for i in order]
    peak_template_idxs = [peak_template_idxs[i] for i in order]

    # ---- Step 3: per-event kinetics ----
    # Detection has finished; tell the caller we're entering kinetics
    # (the slow phase for high-event-rate sweeps). We allocate the
    # range [0.30, 1.00] to kinetics — detection itself is reported
    # as "0..0.30" by the caller (the API generator) since it
    # happens BEFORE this function is invoked for the threshold
    # method, or interleaved with the FFT for template methods.
    _tick(0.30)
    # Compute the polynomial baseline curve once per sweep (if asked) —
    # cheaper than re-fitting around each event, and the curve is
    # explicitly meant to capture the slow trend across the whole
    # recording. Done after detection so we know the events list (we
    # don't actually use the events here, but in a future iteration we
    # could mask them out for an even cleaner fit).
    baseline_curve: Optional[np.ndarray] = None
    if baseline_method == "polynomial":
        try:
            baseline_curve = fit_polynomial_baseline(
                x, sr, baseline_poly_order, direction,
            )
        except Exception:
            # Fitting can fail on degenerate data — fall back to auto
            # silently rather than killing the whole detection.
            baseline_curve = None
    records: list[EventRecord] = []
    n_total = len(peak_idxs)
    # Aim for ~20 ticks per sweep regardless of event count: tiny N
    # (< 20) ticks every event; large N ticks every ``N/20``. The
    # API-side queue coalesces bursts so over-ticking doesn't flood
    # the network — under-ticking (the previous default of 40) made
    # single-sweep progress look stuck for several seconds at a time.
    tick_every = max(1, n_total // 20)
    for i_ev, (pi, mf, tidx) in enumerate(zip(peak_idxs, manual_flags, peak_template_idxs)):
        if n_total > 0 and (i_ev % tick_every) == 0:
            _tick(0.30 + 0.65 * (i_ev / n_total))
        k = measure_event_kinetics(
            x, sr, pi,
            direction=direction,
            baseline_search_ms=baseline_search_ms,
            avg_baseline_ms=avg_baseline_ms,
            avg_peak_ms=avg_peak_ms,
            rise_low_pct=rise_low_pct,
            rise_high_pct=rise_high_pct,
            decay_pct=decay_pct,
            decay_search_ms=decay_search_ms,
            decay_endpoint_method=decay_endpoint_method,
            baseline_curve=baseline_curve,
        )
        # ---- Step 4: exclusion (manual-added events bypass amp/auc guards) ----
        amp_abs = abs(k.amplitude)
        if not mf:
            # An auto-detected event must deflect in the search
            # direction. A peak placed on the decay of a larger event
            # can measure a small amplitude of the opposite sign, which
            # the |amplitude| filter alone would let through.
            if (direction == "negative" and k.amplitude > 0) or \
                    (direction == "positive" and k.amplitude < 0):
                continue
            if amp_abs < amplitude_min_abs:
                continue
            if amp_abs > amplitude_max_abs:
                continue
            if auc_min_abs is not None and (k.auc is None or abs(k.auc) < auc_min_abs):
                continue
            # Max-kinetic filters: drop events with implausibly slow
            # rise / decay / half-width — usually indicates a merged
            # double-peak or noise cluster that the detector mistook
            # for one event.
            if rise_max_ms is not None and k.rise_time_ms is not None \
                    and k.rise_time_ms > rise_max_ms:
                continue
            if decay_max_ms is not None and k.decay_time_ms is not None \
                    and k.decay_time_ms > decay_max_ms:
                continue
            if fwhm_max_ms is not None and k.half_width_ms is not None \
                    and k.half_width_ms > fwhm_max_ms:
                continue
            # Biexp goodness-of-fit guard. We only check when the user
            # opted in AND the fit actually ran (None r2 = couldn't
            # fit; that's separate from a low-quality fit and we don't
            # want to silently drop events whose window was too short).
            if biexp_min_r2 is not None and k.biexp_r2 is not None \
                    and k.biexp_r2 < biexp_min_r2:
                continue

        records.append(EventRecord(
            sweep=sweep_index,
            peak_idx=k.peak_idx,
            peak_time_s=k.peak_idx / sr,
            peak_val=k.peak_val,
            foot_idx=k.foot_idx,
            foot_time_s=k.foot_idx / sr,
            baseline_val=k.baseline_val,
            amplitude=k.amplitude,
            rise_time_ms=k.rise_time_ms,
            decay_time_ms=k.decay_time_ms,
            half_width_ms=k.half_width_ms,
            auc=k.auc,
            decay_endpoint_idx=k.decay_endpoint_idx,
            decay_tau_ms=k.decay_tau_ms,
            biexp_tau_rise_ms=k.biexp_tau_rise_ms,
            biexp_tau_decay_ms=k.biexp_tau_decay_ms,
            biexp_b0=k.biexp_b0,
            biexp_b1=k.biexp_b1,
            biexp_r2=k.biexp_r2,
            manual=mf,
            template_idx=tidx,
        ))
    _tick(1.0)
    return records, detection_measure


# ---------------------------------------------------------------------------
# Refine template: fit biexp to the average of detected events
# ---------------------------------------------------------------------------

def average_detected_events(
    values: np.ndarray, sr: float,
    events: list[EventRecord],
    *,
    align: str = "peak",            # 'peak' | 'foot' | 'rise_halfwidth'
    window_before_ms: float = 5.0,
    window_after_ms: float = 50.0,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Align events on a chosen reference and return (time, avg_values, n).

    Window bounds are relative to the reference sample. Events whose
    full window doesn't fit in the sweep are skipped.
    """
    n_before = max(0, int(round(window_before_ms / 1000.0 * sr)))
    n_after = max(1, int(round(window_after_ms / 1000.0 * sr)))
    n_total = n_before + n_after + 1

    stack = []
    for e in events:
        if align == "peak":
            ref = e.peak_idx
        elif align == "foot":
            ref = e.foot_idx
        elif align == "rise_halfwidth":
            # Reference = sample at 50 % amplitude on the rise.
            half = e.baseline_val + 0.5 * e.amplitude
            seg = values[e.foot_idx:e.peak_idx + 1]
            pre = _find_rise_crossing(seg, e.baseline_val, half, rising=True)
            ref = e.foot_idx + (pre if pre is not None else 0)
        else:
            ref = e.peak_idx
        a = ref - n_before
        b = ref + n_after + 1
        if a < 0 or b > len(values):
            continue
        stack.append(values[a:b])

    if not stack:
        return (
            np.arange(n_total, dtype=float) / sr - n_before / sr,
            np.zeros(n_total, dtype=float),
            0,
        )
    avg = np.mean(np.asarray(stack, dtype=float), axis=0)
    time = np.arange(n_total, dtype=float) / sr - n_before / sr
    return time, avg, len(stack)


__all__ = [
    # templates
    "biexp_event", "fit_biexponential", "render_template", "TemplateFit",
    # rms
    "compute_rms", "RmsResult",
    # detection
    "detect_correlation", "detect_deconvolution", "detect_threshold",
    # kinetics
    "measure_event_kinetics", "EventKinetics",
    # pipeline
    "run_events", "EventRecord",
    # refine
    "average_detected_events",
]
