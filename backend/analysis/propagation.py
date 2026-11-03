"""Dual-site propagation: pair discharges detected on two channels of the
same series (e.g. CA3 and CA1) and measure how each one travels.

Inputs are the two burst lists the Burst Detection window already produces
(one per channel, each curated by the user), so whatever the user accepted
as a discharge is what gets paired.

Sign convention: every lag is ``partner − reference``. Positive means the
reference channel (e.g. CA3) leads.

Three lag measures, because they answer slightly different questions:

* **onset** — difference of the times each discharge first rises to 20 % of
  its peak (above its pre-discharge baseline), found on the pre-filtered
  signal. Not the detector's start time: that is extended back to wherever
  the signal returns to baseline and can wander by 100 ms or more.
* **peak** — difference of peak times. Simple; broad peaks make it noisy.
* **xcorr** — the shift that best lines the partner's waveform up with the
  reference's over the discharge (normalised cross-correlation, refined
  below one sample by a parabola through the peak). Uses the whole shape,
  so it is the most robust; default.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Optional

import numpy as np
from scipy import signal as sps

from .bursts import _apply_pre_detection_filter

DEFAULT_PROPAGATION_PARAMS: dict[str, Any] = {
    "max_lag_ms": 100.0,       # pairing window (peak times) and xcorr search range (±)
    "onset_fraction": 0.2,     # onset = first rise to this fraction of the peak
    "xcorr_pre_ms": 20.0,      # waveform window starts this long before onset
    "xcorr_max_ms": 500.0,     # …and lasts the discharge, capped at this
    "polarity": "auto",        # 'auto' | 'same' | 'opposite'
    "primary": "xcorr",        # lag used for 'leads' fraction + distribution
    "avg_pre_ms": 100.0,       # aligned-average window around reference onset
    "avg_post_ms": 400.0,
}

LAG_METHODS = ("onset", "peak", "xcorr")
_MAX_AVG_POINTS = 1000


def merged_params(params: Optional[dict]) -> dict:
    out = {**DEFAULT_PROPAGATION_PARAMS}
    for k, v in (params or {}).items():
        if v is not None:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# Pairing
# ---------------------------------------------------------------------------

def pair_events(ref: list[dict], partner: list[dict], max_lag_s: float,
                time_key: str = "peakTimeS") -> list[tuple[int, int]]:
    """One-to-one pairs ``(ref_idx, partner_idx)`` within the same sweep
    whose peak times are at most ``max_lag_s`` apart. Closest peaks are
    paired first (greedy on |Δt|), so a busy stretch can't chain-mismatch.

    Peaks, not the detector's start times: the start is extended back to
    where the signal returns to baseline, so the same discharge can start
    100+ ms apart on two channels while its peaks are a few ms apart."""
    cands: list[tuple[float, int, int]] = []
    by_sweep: dict[int, list[int]] = {}
    for j, p in enumerate(partner):
        by_sweep.setdefault(int(p.get("sweepIndex", 0)), []).append(j)
    for i, r in enumerate(ref):
        sw = int(r.get("sweepIndex", 0))
        tr = float(r[time_key])
        for j in by_sweep.get(sw, ()):
            d = float(partner[j][time_key]) - tr
            if abs(d) <= max_lag_s:
                cands.append((abs(d), i, j))
    cands.sort()
    used_r: set[int] = set()
    used_p: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _, i, j in cands:
        if i in used_r or j in used_p:
            continue
        used_r.add(i)
        used_p.add(j)
        pairs.append((i, j))
    pairs.sort()
    return pairs


# ---------------------------------------------------------------------------
# Cross-correlation lag
# ---------------------------------------------------------------------------

def xcorr_lag(x_ref: np.ndarray, x_part: np.ndarray, sr: float,
              i0: int, i1: int, max_lag: int, sign: float = 1.0,
              ) -> tuple[Optional[float], Optional[float], bool]:
    """Lag (s) of ``x_part`` relative to ``x_ref`` over ``x_ref[i0:i1]``.

    Normalised cross-correlation over integer lags in ``[-max_lag, max_lag]``
    (partner energy normalised per lag), then a parabola through the peak and
    its neighbours for sub-sample precision. Returns ``(lag_s, r, at_edge)``;
    ``at_edge`` means the best match sits on the search limit, so the true lag
    may lie outside it and ``lag_s`` is ``None``.
    """
    n = len(x_ref)
    i0 = max(0, i0)
    i1 = min(n, i1)
    lo = max(0, i0 - max_lag)
    hi = min(len(x_part), i1 + max_lag)
    # Shrink the search to what the data allows at the recording edges.
    kmin = -(i0 - lo)
    kmax = hi - i1
    if i1 - i0 < 8 or kmax - kmin < 2:
        return None, None, False
    a = np.asarray(x_ref[i0:i1], dtype=float)
    a = a - a.mean()
    b = np.asarray(x_part[lo:hi], dtype=float) * sign
    b = b - b[(i0 - lo):(i0 - lo) + len(a)].mean()
    m = len(a)
    c = sps.correlate(b, a, mode="valid", method="fft")      # length kmax-kmin+1
    cs = np.concatenate(([0.0], np.cumsum(b * b)))
    eb = cs[m:] - cs[:-m]                                     # partner energy per lag
    ea = float(np.dot(a, a))
    with np.errstate(invalid="ignore", divide="ignore"):
        r = c / np.sqrt(ea * eb)
    r = np.nan_to_num(r, nan=-np.inf)
    j = int(np.argmax(r))
    rpk = float(r[j])
    if not math.isfinite(rpk):
        return None, None, False
    if j == 0 or j == len(r) - 1:
        # On the edge of the allowed range: report as unresolved.
        at_limit = (j == 0 and kmin == -max_lag) or (j == len(r) - 1 and kmax == max_lag)
        return None, rpk, at_limit
    y0, y1, y2 = r[j - 1], r[j], r[j + 1]
    denom = y0 - 2 * y1 + y2
    frac = 0.5 * (y0 - y2) / denom if denom != 0 else 0.0
    frac = float(np.clip(frac, -0.5, 0.5))
    k = kmin + j + frac
    return k / sr, rpk, False


def rise_onset(x: np.ndarray, sr: float, ev: dict, sign: float, fraction: float,
               max_back_s: float = 0.5) -> Optional[float]:
    """Time (s) the discharge first reaches ``fraction`` of its peak.

    Deviation is measured from the pre-discharge baseline (median of the
    100 ms before the detector's start), signed by ``sign``. Walks back from
    the peak to the last sample below the level and interpolates the
    crossing between that sample and the next.
    """
    n = len(x)
    pk = int(round(float(ev["peakTimeS"]) * sr))
    if pk <= 1 or pk >= n:
        return None
    st = int(round(float(ev.get("startS", ev["peakTimeS"])) * sr))
    b0 = max(0, st - int(0.1 * sr))
    base = float(np.median(x[b0:max(b0 + 1, st)])) if st > b0 else float(x[max(0, pk - 1)])
    # Refine the peak to the local extremum within ±5 ms of the record.
    w = max(1, int(0.005 * sr))
    seg = (x[max(0, pk - w):min(n, pk + w + 1)] - base) * sign
    pk = max(0, pk - w) + int(np.argmax(seg))
    amp = (x[pk] - base) * sign
    if not amp > 0:
        return None
    level = fraction * amp
    lo = max(0, pk - int(max_back_s * sr))
    dev = (x[lo:pk + 1] - base) * sign
    below = np.nonzero(dev < level)[0]
    if below.size == 0:
        return None
    i = int(below[-1])                      # last sample below, before peak
    if i + 1 >= dev.size:
        return (lo + i) / sr
    d0, d1 = dev[i], dev[i + 1]
    frac = (level - d0) / (d1 - d0) if d1 != d0 else 0.0
    return (lo + i + float(np.clip(frac, 0.0, 1.0))) / sr


def _polarity_sign(mode: str, ref_ev: dict, part_ev: dict) -> float:
    if mode == "same":
        return 1.0
    if mode == "opposite":
        return -1.0
    a = float(ref_ev.get("peakSigned") or 0.0)
    b = float(part_ev.get("peakSigned") or 0.0)
    return -1.0 if a * b < 0 else 1.0


# ---------------------------------------------------------------------------
# Summary helpers
# ---------------------------------------------------------------------------

def _stats(vals: list[Optional[float]]) -> dict:
    v = np.array([x for x in vals if x is not None and math.isfinite(x)], dtype=float)
    if v.size == 0:
        return {"n": 0, "median": None, "mean": None, "q25": None, "q75": None, "sd": None}
    return {
        "n": int(v.size),
        "median": float(np.median(v)),
        "mean": float(v.mean()),
        "q25": float(np.percentile(v, 25)),
        "q75": float(np.percentile(v, 75)),
        "sd": float(v.std(ddof=1)) if v.size > 1 else None,
    }


def _block_mean(x: np.ndarray, k: int) -> np.ndarray:
    if k <= 1:
        return x
    m = (len(x) // k) * k
    return x[:m].reshape(-1, k).mean(axis=1)


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def analyse_propagation(
    series, ref_channel: int, partner_channel: int,
    ref_bursts: list[dict], partner_bursts: list[dict],
    ref_params: dict, partner_params: dict, params: Optional[dict],
    excluded: Iterable[int], scaled_fn,
) -> dict:
    """Pair the two event lists and measure every pair.

    Waveforms are taken after each channel's own detection pre-filter, so
    the cross-correlation sees the same signal the user curated events on.
    Events on excluded sweeps are ignored.
    """
    p = merged_params(params)
    ex = set(int(i) for i in excluded or ())
    ref_ok = [i for i, b in enumerate(ref_bursts) if int(b.get("sweepIndex", 0)) not in ex]
    part_ok = [j for j, b in enumerate(partner_bursts) if int(b.get("sweepIndex", 0)) not in ex]
    ref_l = [ref_bursts[i] for i in ref_ok]
    part_l = [partner_bursts[j] for j in part_ok]

    max_lag_s = float(p["max_lag_ms"]) / 1000.0
    local_pairs = pair_events(ref_l, part_l, max_lag_s)

    sweeps_needed = sorted({int(ref_l[i].get("sweepIndex", 0)) for i, _ in local_pairs})
    # Total analysed duration (included sweeps that have both channels).
    duration_s = 0.0
    sr_any: Optional[float] = None
    for si in range(series.sweep_count):
        if si in ex:
            continue
        sw = series.sweeps[si]
        if max(ref_channel, partner_channel) >= sw.trace_count:
            continue
        tr = sw.traces[ref_channel]
        duration_s += len(tr.data) / float(tr.sampling_rate)
        sr_any = float(tr.sampling_rate)

    pre_s = float(p["xcorr_pre_ms"]) / 1000.0
    frac_on = float(p.get("onset_fraction") or 0.2)
    win_max_s = float(p["xcorr_max_ms"]) / 1000.0
    avg_pre = float(p["avg_pre_ms"]) / 1000.0
    avg_post = float(p["avg_post_ms"]) / 1000.0

    pair_rows: list[dict] = []
    avg_ref: list[np.ndarray] = []
    avg_part: list[np.ndarray] = []
    units_ref = units_part = ""
    sr_avg: Optional[float] = None
    pairs_by_sweep: dict[int, list[tuple[int, int]]] = {}
    for i, j in local_pairs:
        pairs_by_sweep.setdefault(int(ref_l[i].get("sweepIndex", 0)), []).append((i, j))

    for si in sweeps_needed:
        sw = series.sweeps[si]
        tr_r = sw.traces[ref_channel]
        tr_p = sw.traces[partner_channel]
        sr = float(tr_r.sampling_rate)
        if abs(float(tr_p.sampling_rate) - sr) > 1e-6:
            raise ValueError("The two channels have different sampling rates")
        units_ref, units_part = tr_r.units, tr_p.units
        xr = _apply_pre_detection_filter(np.asarray(scaled_fn(tr_r), dtype=float), sr, ref_params or {})
        xp = _apply_pre_detection_filter(np.asarray(scaled_fn(tr_p), dtype=float), sr, partner_params or {})
        L = max(1, int(round(max_lag_s * sr)))
        na, nb = int(round(avg_pre * sr)), int(round(avg_post * sr))
        for i, j in pairs_by_sweep[si]:
            r_ev, p_ev = ref_l[i], part_l[j]
            t0 = float(r_ev["startS"])
            t1 = min(float(r_ev.get("endS", t0)), t0 + win_max_s)
            i0 = int(round((t0 - pre_s) * sr))
            i1 = max(i0 + 8, int(round(t1 * sr)))
            sgn = _polarity_sign(str(p["polarity"]), r_ev, p_ev)
            lag, rr, edge = xcorr_lag(xr, xp, sr, i0, i1, L, sgn)
            amp_r = float(r_ev.get("peakAmplitude") or 0.0)
            amp_p = float(p_ev.get("peakAmplitude") or 0.0)
            sr_sign = -1.0 if float(r_ev.get("peakSigned") or 1.0) < 0 else 1.0
            on_r = rise_onset(xr, sr, r_ev, sr_sign, frac_on)
            on_p = rise_onset(xp, sr, p_ev, sr_sign * sgn, frac_on)
            pair_rows.append({
                "ref_idx": ref_ok[i],
                "partner_idx": part_ok[j],
                "sweep": si,
                "ref_start_s": t0,
                "partner_start_s": float(p_ev["startS"]),
                "ref_peak_s": float(r_ev["peakTimeS"]),
                "partner_peak_s": float(p_ev["peakTimeS"]),
                "onset_lag_ms": (on_p - on_r) * 1000.0 if on_r is not None and on_p is not None else None,
                "peak_lag_ms": (float(p_ev["peakTimeS"]) - float(r_ev["peakTimeS"])) * 1000.0,
                "xcorr_lag_ms": lag * 1000.0 if lag is not None else None,
                "xcorr_r": rr,
                "xcorr_at_limit": edge,
                "amp_ratio": amp_p / amp_r if amp_r > 0 else None,
                "polarity": "opposite" if sgn < 0 else "same",
            })
            # Aligned average around the reference ONSET (20 % of its peak),
            # not the detector's start: that start wanders by up to ~100 ms
            # and smears the average. Both channels are cut at the same
            # instants, so the delay between the two curves is preserved.
            # Baseline = mean of each cut's pre-onset window.
            if on_r is None:
                continue
            c = int(round(on_r * sr))
            a0, a1 = c - na, c + nb
            if a0 >= 0 and a1 <= len(xr) and a1 <= len(xp) and na > 0:
                sr_avg = sr
                seg_r = xr[a0:a1]
                seg_p = xp[a0:a1] * sgn
                avg_ref.append(seg_r - seg_r[:na].mean())
                avg_part.append(seg_p - seg_p[:na].mean())

    paired_ref = {row["ref_idx"] for row in pair_rows}
    paired_part = {row["partner_idx"] for row in pair_rows}
    ref_only = [i for i in ref_ok if i not in paired_ref]
    partner_only = [j for j in part_ok if j not in paired_part]

    lag_stats = {m: _stats([row[f"{m}_lag_ms"] for row in pair_rows]) for m in LAG_METHODS}
    primary = p["primary"] if p["primary"] in LAG_METHODS else "xcorr"
    prim_vals = [row[f"{primary}_lag_ms"] for row in pair_rows]
    prim_clean = [v for v in prim_vals if v is not None]
    leads = (sum(1 for v in prim_clean if v > 0) / len(prim_clean)) if prim_clean else None
    minutes = duration_s / 60.0 if duration_s > 0 else None

    average = None
    if avg_ref and sr_avg:
        R = np.vstack(avg_ref)
        P = np.vstack(avg_part)
        k = max(1, int(math.ceil(R.shape[1] / _MAX_AVG_POINTS)))
        t = (np.arange(R.shape[1]) - int(round(avg_pre * sr_avg))) / sr_avg * 1000.0
        sem = (lambda M: M.std(axis=0, ddof=1) / math.sqrt(M.shape[0])) if R.shape[0] > 1 \
            else (lambda M: np.zeros(M.shape[1]))
        average = {
            "t_ms": _block_mean(t, k).tolist(),
            "ref_mean": _block_mean(R.mean(axis=0), k).tolist(),
            "ref_sem": _block_mean(sem(R), k).tolist(),
            "partner_mean": _block_mean(P.mean(axis=0), k).tolist(),
            "partner_sem": _block_mean(sem(P), k).tolist(),
            "n": int(R.shape[0]),
            "partner_flipped": any(row["polarity"] == "opposite" for row in pair_rows),
        }

    n_ref, n_part, n_pairs = len(ref_ok), len(part_ok), len(pair_rows)
    return {
        "params": p,
        "pairs": pair_rows,
        "ref_only": ref_only,
        "partner_only": partner_only,
        "summary": {
            "n_ref": n_ref,
            "n_partner": n_part,
            "n_pairs": n_pairs,
            "propagation_fraction": n_pairs / n_ref if n_ref else None,
            "partner_only_fraction": len(partner_only) / n_part if n_part else None,
            "partner_only_per_min": len(partner_only) / minutes if minutes else None,
            "ref_leads_fraction": leads,
            "primary": primary,
            "lag_ms": lag_stats,
            "amp_ratio": _stats([row["amp_ratio"] for row in pair_rows]),
            "xcorr_r": _stats([row["xcorr_r"] for row in pair_rows]),
            "n_xcorr_at_limit": sum(1 for row in pair_rows if row["xcorr_at_limit"]),
            "duration_s": duration_s,
        },
        "average": average,
        "units_ref": units_ref,
        "units_partner": units_part,
        "sampling_rate": sr_any,
    }
