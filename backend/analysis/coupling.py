"""Two-channel coupling for the Spectral window (e.g. CA3 ↔ CA1).

Computed on the same regions, sweeps and Welch segments as the region PSDs
(`analysis/spectral.py`), so the numbers line up with the band powers.

Sign convention: everything is partner − reference. A positive delay means
the reference channel (e.g. CA3) leads.

Measures, per frequency (pooled over every segment of every sweep):

* **coherence** — magnitude-squared coherence |Sxy|² / (Sxx·Syy), 0–1.
  High whenever the two sites share a signal, including the zero-lag field
  that two nearby electrodes pick up from the same source (volume
  conduction).
* **imaginary coherence** — Im(Sxy) / √(Sxx·Syy). Zero-lag (instantaneous)
  sharing has no imaginary part, so this only reflects lagged coupling.
  Signed: positive = reference leads.
* **wPLI** — weighted phase-lag index, |Σ Im(Sxy)| / Σ |Im(Sxy)| over
  segments, 0–1. Also blind to zero-lag sharing, and less sensitive to
  noise than imaginary coherence (Vinck et al., 2011).
* **phase** — angle of Sxy; a delay τ gives phase −2π·f·τ.

Per band: mean coherence / imaginary coherence / wPLI over the band's bins
(mains bins left out when line-noise exclusion is on), and the delay from
the slope of the unwrapped phase across the band, weighted by coherence —
reported only when the band's mean coherence is at least 0.3.

Cross-correlation (time domain, after a zero-phase band-pass): pooled over
the region's sweeps, normalised so a perfect copy gives r = 1. Reported:
the peak (largest |r|, signed), its lag (sub-sample), and r at zero lag.
"""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
from scipy import signal as sps

from .spectral import _detrend_arg, line_noise_mask

COUPLING_DEFAULTS: dict[str, Any] = {
    "coupling_max_lag_ms": 200.0,     # cross-correlation search range (±)
    "coupling_xcorr_low": 1.0,        # band-pass before cross-correlation
    "coupling_xcorr_high": 100.0,     #   (0 / ≥ Nyquist disables that edge)
    "coupling_min_coherence": 0.3,    # phase-slope delay only above this
}

_CHUNK_SEGMENTS = 256
_MAX_POINTS = 4000
_XCORR_BLOCK_S = 10.0


def _p(params: dict, key: str):
    v = params.get(key)
    return COUPLING_DEFAULTS[key] if v is None else v


# ---------------------------------------------------------------------------
# Cross-spectra
# ---------------------------------------------------------------------------

def cross_spectra(x_pieces: list[np.ndarray], y_pieces: list[np.ndarray], sr: float,
                  params: dict) -> dict:
    """Pooled auto / cross spectra over Welch segments of every piece pair.

    Uses the region PSD's segment length, overlap, window and detrend.
    Returns frequencies up to ``fmax`` and the per-frequency measures.
    """
    window = params.get("window", "hann")
    detrend = _detrend_arg(params)
    fmax = min(float(params.get("fmax") or sr / 2), sr / 2)
    # Always Welch segments, even when the region PSD uses the periodogram:
    # coherence from a single segment is identically 1.
    nperseg = max(8, int(round(float(params.get("segment_s") or 2.0) * sr)))
    noverlap = min(nperseg - 1, max(0, int(round(nperseg * float(params.get("overlap_pct", 50.0)) / 100.0))))
    step = nperseg - noverlap
    chunk_len = (_CHUNK_SEGMENTS - 1) * step + nperseg

    freqs = None
    keep = None
    sxx = syy = None
    sxy = None
    sum_im = sum_abs_im = None
    n_seg = 0
    for x, y in zip(x_pieces, y_pieces):
        n = min(len(x), len(y))
        start = 0
        while start + nperseg <= n:
            cx = x[start:start + chunk_len]
            cy = y[start:start + chunk_len]
            m = min(len(cx), len(cy))
            cx, cy = cx[:m], cy[:m]
            f, _t, zx = sps.spectrogram(cx, fs=sr, window=window, nperseg=nperseg, noverlap=noverlap,
                                        detrend=detrend, mode="complex")
            _f, _t, zy = sps.spectrogram(cy, fs=sr, window=window, nperseg=nperseg, noverlap=noverlap,
                                         detrend=detrend, mode="complex")
            if freqs is None:
                keep = f <= fmax
                freqs = f[keep]
                z = np.zeros(int(keep.sum()))
                sxx, syy, sum_im, sum_abs_im = z.copy(), z.copy(), z.copy(), z.copy()
                sxy = np.zeros(int(keep.sum()), dtype=complex)
            zx = zx[keep, :]
            zy = zy[keep, :]
            cross = zy * np.conj(zx)              # partner × conj(reference)
            sxx += (np.abs(zx) ** 2).sum(axis=1)
            syy += (np.abs(zy) ** 2).sum(axis=1)
            sxy += cross.sum(axis=1)
            sum_im += cross.imag.sum(axis=1)
            sum_abs_im += np.abs(cross.imag).sum(axis=1)
            n_seg += zx.shape[1]
            start += zx.shape[1] * step
    if freqs is None or n_seg < 2:
        raise ValueError(
            "Coupling needs at least two Welch segments in the region — "
            "use a longer region or a shorter segment length"
        )
    denom = np.sqrt(sxx * syy)
    with np.errstate(invalid="ignore", divide="ignore"):
        coh = np.abs(sxy) ** 2 / (sxx * syy)
        # Sxy = partner × conj(reference) has phase −2πfτ when the reference
        # leads by τ, i.e. a negative imaginary part; flip it so positive
        # means the reference leads, like every other lag here.
        icoh = -sxy.imag / denom
        wpli = np.abs(sum_im) / sum_abs_im
    return {
        "freqs": freqs,
        "coherence": np.nan_to_num(coh, nan=0.0),
        "imag_coherence": np.nan_to_num(icoh, nan=0.0),
        "wpli": np.nan_to_num(wpli, nan=0.0),
        "phase": np.angle(sxy),
        "n_segments": n_seg,
        "freq_res_hz": sr / nperseg,
    }


def phase_slope_delay(freqs: np.ndarray, phase: np.ndarray, weight: np.ndarray) -> Optional[float]:
    """Delay (s) from a weighted straight-line fit of unwrapped phase vs
    frequency: phase = −2π·f·τ. None with fewer than three bins."""
    if len(freqs) < 3 or not np.any(weight > 0):
        return None
    ph = np.unwrap(phase)
    w = np.clip(weight, 0, None)
    W = w.sum()
    fm = (w * freqs).sum() / W
    pm = (w * ph).sum() / W
    var = (w * (freqs - fm) ** 2).sum()
    if var <= 0:
        return None
    slope = (w * (freqs - fm) * (ph - pm)).sum() / var
    return float(-slope / (2 * math.pi))


def band_coupling(cs: dict, params: dict) -> dict:
    freqs = cs["freqs"]
    excl = bool(params.get("exclude_line_noise"))
    lmask = line_noise_mask(freqs, params) if excl else np.zeros(len(freqs), bool)
    min_coh = float(_p(params, "coupling_min_coherence"))
    out: dict[str, Any] = {}
    for b in params.get("bands") or []:
        name = str(b.get("name", "")).strip()
        try:
            lo, hi = float(b["low"]), float(b["high"])
        except (KeyError, TypeError, ValueError):
            continue
        if not name or hi <= lo:
            continue
        m = (freqs >= lo) & (freqs < hi) & ~lmask
        if not m.any():
            out[name] = {"low": lo, "high": hi, "coherence": None, "imag_coherence": None,
                         "wpli": None, "phase_delay_ms": None}
            continue
        coh = float(cs["coherence"][m].mean())
        delay = None
        if coh >= min_coh:
            d = phase_slope_delay(freqs[m], cs["phase"][m], cs["coherence"][m])
            delay = d * 1000.0 if d is not None else None
        out[name] = {
            "low": lo, "high": hi,
            "coherence": coh,
            "imag_coherence": float(cs["imag_coherence"][m].mean()),
            "wpli": float(cs["wpli"][m].mean()),
            "phase_delay_ms": delay,
        }
    return out


# ---------------------------------------------------------------------------
# Cross-correlation
# ---------------------------------------------------------------------------

def _bandpass(x: np.ndarray, sr: float, lo: float, hi: float) -> np.ndarray:
    nyq = sr / 2
    lo = lo if lo and lo > 0 else 0.0
    hi = hi if hi and 0 < hi < nyq * 0.99 else 0.0
    if lo and hi and hi > lo:
        sos = sps.butter(4, [lo, hi], btype="bandpass", fs=sr, output="sos")
    elif lo:
        sos = sps.butter(4, lo, btype="highpass", fs=sr, output="sos")
    elif hi:
        sos = sps.butter(4, hi, btype="lowpass", fs=sr, output="sos")
    else:
        return x
    return sps.sosfiltfilt(sos, x)


def cross_correlation(x_pieces: list[np.ndarray], y_pieces: list[np.ndarray], sr: float,
                      params: dict) -> dict:
    """Pooled normalised cross-correlation r(τ) of partner vs reference for
    τ in ±max_lag. r(τ) = Σ x(t)·y(t+τ) / √(Σx²·Σy²) after band-pass and
    mean removal; computed in blocks so hour-long regions stay cheap."""
    L = max(1, int(round(float(_p(params, "coupling_max_lag_ms")) / 1000.0 * sr)))
    lo = float(_p(params, "coupling_xcorr_low") or 0)
    hi = float(_p(params, "coupling_xcorr_high") or 0)
    B = max(4 * L, int(_XCORR_BLOCK_S * sr))
    acc = np.zeros(2 * L + 1)
    ex = ey = 0.0
    for x, y in zip(x_pieces, y_pieces):
        n = min(len(x), len(y))
        if n < 2 * L + 8:
            continue
        xf = _bandpass(np.asarray(x[:n], float), sr, lo, hi)
        yf = _bandpass(np.asarray(y[:n], float), sr, lo, hi)
        xf -= xf.mean()
        yf -= yf.mean()
        # Blocks of the reference; the partner is taken L samples wider on
        # each side so every lag has full overlap.
        for i0 in range(L, n - L, B):
            i1 = min(n - L, i0 + B)
            xb = xf[i0:i1]
            yb = yf[i0 - L:i1 + L]
            acc += sps.correlate(yb, xb, mode="valid", method="fft")
            ex += float(np.dot(xb, xb))
            ey += float(np.dot(yf[i0:i1], yf[i0:i1]))
    if ex <= 0 or ey <= 0:
        raise ValueError("Region too short for the cross-correlation lag range")
    r = acc / math.sqrt(ex * ey)
    lags = np.arange(-L, L + 1) / sr
    j = int(np.argmax(np.abs(r)))
    lag = float(lags[j])
    if 0 < j < len(r) - 1:
        y0, y1, y2 = r[j - 1], r[j], r[j + 1]
        den = y0 - 2 * y1 + y2
        if den != 0:
            lag += float(np.clip(0.5 * (y0 - y2) / den, -0.5, 0.5)) / sr
    at_limit = j == 0 or j == len(r) - 1
    k = max(1, int(math.ceil(len(r) / 2000)))
    return {
        "lags_ms": (lags[::k] * 1000.0).tolist(),
        "r": r[::k].tolist(),
        "peak_r": float(r[j]),
        "peak_lag_ms": None if at_limit else lag * 1000.0,
        "peak_at_limit": at_limit,
        "zero_lag_r": float(r[L]),
        "max_lag_ms": L / sr * 1000.0,
        "band_hz": [lo or None, hi or None],
    }


# ---------------------------------------------------------------------------
# Region entry
# ---------------------------------------------------------------------------

def _thin(arrays: dict[str, np.ndarray], n: int) -> dict[str, list]:
    k = max(1, int(math.ceil(n / _MAX_POINTS)))
    return {key: np.asarray(v)[::k].tolist() for key, v in arrays.items()}


def analyse_coupling(x_pieces: list[np.ndarray], y_pieces: list[np.ndarray], sr: float,
                     params: dict) -> dict:
    """Coupling block for one region (reference pieces x, partner pieces y,
    same sweeps and times)."""
    cs = cross_spectra(x_pieces, y_pieces, sr, params)
    xc = cross_correlation(x_pieces, y_pieces, sr, params)
    spectra = _thin({
        "freqs": cs["freqs"], "coherence": cs["coherence"],
        "imag_coherence": cs["imag_coherence"], "wpli": cs["wpli"], "phase": cs["phase"],
    }, len(cs["freqs"]))
    return {
        **spectra,
        "bands": band_coupling(cs, params),
        "xcorr": xc,
        "n_segments": cs["n_segments"],
        "freq_res_hz": cs["freq_res_hz"],
    }
