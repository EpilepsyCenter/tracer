"""Action potentials against ground truth.

A conductance-based neuron (Na, Kd, M as in Pospischil et al. 2008, plus
leak and Ih) is driven by current steps and simulated at 100 kHz. The trace
goes through a 4-pole Bessel low-pass at 10 kHz, like an amplifier, and is
sampled at 20 kHz for TRACER. The reference measurements below are an
independent implementation of the manual's definitions (ch. 12), applied
to the 100 kHz trace.

Checked:
- spike count per sweep (exact);
- F-I current = the step level, and rheobase 'record' = the first firing
  step, with the analysis bounds over the whole sweep (#20);
- first-spike latency from the step onset (#25), and both of the above
  through the AP endpoint with Manual Im and with the stimulus taken from
  a recorded trace (#28), as the window runs them;
- per spike: threshold, peak, amplitude, rise, decay, half-width, fAHP,
  mAHP, +slope (#21) and −slope (#22), within tolerances that allow for
  sampling at 20 kHz;
- the 200 kHz interpolation keeps its clock (#27).

The model and the reference come from the blind ground-truth validation
of November 2026.

Run from the repo root:  python tests/ap_groundtruth_check.py
"""

import sys
from pathlib import Path

import asyncio

import numpy as np
from scipy import optimize, signal

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from analysis.ap import run_ap, _interp_to_200khz  # noqa: E402
import api.ap as ap_api  # noqa: E402
from readers.models import Recording, Group, Series, Sweep, Trace  # noqa: E402

FS = 100_000.0           # simulation and reference rate
FS_REC = 20_000.0        # what TRACER sees
DT = 1000.0 / FS         # ms
SWEEP_MS, ON_MS, OFF_MS = 600.0, 100.0, 500.0
LEVELS = [-100.0 + 25.0 * k for k in range(14)]     # -100 … +225 pA, as Manual Im steps

# cell03 of the blind test: fires fast enough at the top step that the
# next spike falls inside 100 ms of the previous one.
CELL = dict(C=200.0, gL=7.0, EL=-70.0, na=60.0, k=7.0, m=0.08, gH=4.0, VT=-57.5)
ENA, EK, EH = 50.0, -90.0, -30.0

KINETICS = dict(
    threshold_method="first_deriv_cutoff", threshold_cutoff_mv_ms=20.0,
    threshold_search_ms_before_peak=5.0, sekerli_lower_bound_mv_ms=5.0,
    rise_low_pct=10.0, rise_high_pct=90.0, decay_low_pct=10.0, decay_high_pct=90.0,
    decay_end="to_threshold", fahp_search_start_ms=0.0, fahp_search_end_ms=5.0,
    mahp_search_start_ms=5.0, mahp_search_end_ms=100.0, max_slope_window_ms=0.5,
    interpolate_to_200khz=True, baseline_window_ms=10.0, measure_on="raw",
)
DETECTION = dict(
    method="auto_rec", manual_threshold_mv=-10.0, min_amplitude_mv=50.0,
    pos_dvdt_mv_ms=10.0, neg_dvdt_mv_ms=-10.0, width_ms=5.0, min_distance_ms=2.0,
    bounds_start_s=0.0, bounds_end_s=0.0, filter_enabled=False,
)

# Tolerances (TRACER at 20 kHz vs the reference at 100 kHz).
TOL = dict(threshold_mV=2.0, peak_mV=1.0, amplitude_mV=2.5, rise_ms=0.02,
           decay_ms=0.03, fwhm_ms=0.01, fahp_mV=0.5, mahp_mV=0.5,
           up_rel=0.05, down_rel=0.05, latency_ms=0.1)

fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name}: {detail}")


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def _vtrap(x, y):
    x = np.asarray(x, float)
    small = np.abs(x / y) < 1e-6
    safe = np.where(small, 1.0, x)
    return np.where(small, y * (1 - x / y / 2), safe / np.expm1(safe / y))


def _rates(V, VT):
    am = 0.32 * _vtrap(-(V - VT - 13), 4)
    bm = 0.28 * _vtrap(V - VT - 40, 5)
    ah = 0.128 * np.exp(-(V - VT - 17) / 18)
    bh = 4 / (1 + np.exp(-(V - VT - 40) / 5))
    an = 0.032 * _vtrap(-(V - VT - 15), 5)
    bn = 0.5 * np.exp(-(V - VT - 10) / 40)
    p_inf = 1 / (1 + np.exp(-(V + 35) / 10))
    tau_p = 608 / (3.3 * np.exp((V + 35) / 20) + np.exp(-(V + 35) / 20))
    q_inf = 1 / (1 + np.exp((V + 82) / 9))
    tau_q = 30 + 120 / (np.exp((V + 80) / 12) + np.exp(-(V + 80) / 12))
    return am, bm, ah, bh, an, bn, p_inf, tau_p, q_inf, tau_q


def simulate(levels):
    c = CELL
    gNa, gK, gM, gH, gL, C = c["na"] * c["C"], c["k"] * c["C"], c["m"] * c["C"], c["gH"], c["gL"], c["C"]

    def ss_current(V):
        am, bm, ah, bh, an, bn, p_inf, _, q_inf, _ = _rates(V, c["VT"])
        m, h, n = am / (am + bm), ah / (ah + bh), an / (an + bn)
        return (gNa * m ** 3 * h * (V - ENA) + gK * n ** 4 * (V - EK) + gM * p_inf * (V - EK)
                + gH * q_inf * (V - EH) + gL * (V - c["EL"]))

    grid = np.linspace(-120, -40, 1601)
    k = int(np.flatnonzero(np.diff(np.sign(ss_current(grid))))[0])
    v0 = optimize.brentq(ss_current, grid[k], grid[k + 1])
    lv = np.asarray(levels, float)
    V = np.full(lv.size, v0)
    am, bm, ah, bh, an, bn, p_inf, tau_p, q_inf, tau_q = _rates(V, c["VT"])
    m, h, n, p, q = am / (am + bm), ah / (ah + bh), an / (an + bn), p_inf.copy(), q_inf.copy()
    steps = int(round(SWEEP_MS / DT))
    i_on, i_off = int(round(ON_MS / DT)), int(round(OFF_MS / DT))
    out = np.empty((lv.size, steps))
    for i in range(steps):
        out[:, i] = V
        I = lv if i_on <= i < i_off else 0.0
        am, bm, ah, bh, an, bn, p_inf, tau_p, q_inf, tau_q = _rates(V, c["VT"])
        tm, th, tn = 1 / (am + bm), 1 / (ah + bh), 1 / (an + bn)
        m = am * tm + (m - am * tm) * np.exp(-DT / tm)
        h = ah * th + (h - ah * th) * np.exp(-DT / th)
        n = an * tn + (n - an * tn) * np.exp(-DT / tn)
        p = p_inf + (p - p_inf) * np.exp(-DT / tau_p)
        q = q_inf + (q - q_inf) * np.exp(-DT / tau_q)
        gna, gk, gh = gNa * m ** 3 * h, gK * n ** 4 + gM * p, gH * q
        gs = gna + gk + gh + gL
        es = gna * ENA + gk * EK + gh * EH + gL * c["EL"]
        V = (V + DT / C * (es + I)) / (1 + DT / C * gs)
    b, a = signal.bessel(4, 10_000.0, fs=FS, norm="mag")
    zi = np.multiply.outer(out[:, 0], signal.lfilter_zi(b, a))
    return signal.lfilter(b, a, out, axis=-1, zi=zi)[0]


# ---------------------------------------------------------------------------
# Reference measurements (manual ch. 12), on the 100 kHz trace
# ---------------------------------------------------------------------------

def _cross(t, y, level, i0, i1, rising=True):
    seg = y[i0:i1]
    idx = np.flatnonzero((seg[:-1] < level) & (seg[1:] >= level)) if rising \
        else np.flatnonzero((seg[:-1] > level) & (seg[1:] <= level))
    if not idx.size:
        return None
    k = i0 + int(idx[0])
    f = (level - y[k]) / (y[k + 1] - y[k])
    return t[k] + f * (t[k + 1] - t[k])


def reference(v, fs):
    t = np.arange(v.size) / fs * 1000
    d1 = np.gradient(v) * fs / 1000
    w = max(1, int(round(KINETICS["max_slope_window_ms"] * fs / 1000)))
    ds = np.convolve(d1, np.ones(w) / w, mode="same")
    ms = lambda x: int(round(x * fs / 1000))  # noqa: E731
    spikes = []
    for u in np.flatnonzero((v[:-1] < 0) & (v[1:] >= 0)):
        down = np.flatnonzero(v[u + 1:] < 0)
        e = u + 1 + (int(down[0]) if down.size else v.size - u - 2)
        ip = u + 1 + int(np.argmax(v[u + 1:e + 1]))
        n0 = ip - ms(KINETICS["threshold_search_ms_before_peak"])
        it = n0 + int(np.flatnonzero(d1[n0:ip + 1] >= KINETICS["threshold_cutoff_mv_ms"])[0])
        thr, pk = v[it], v[ip]
        amp = pk - thr
        nxt = min(v.size - 1, ip + ms(KINETICS["mahp_search_end_ms"]))
        r_lo = _cross(t, v, thr + 0.1 * amp, it, ip + 1)
        r_hi = _cross(t, v, thr + 0.9 * amp, it, ip + 1)
        d_hi = _cross(t, v, thr + 0.9 * amp, ip, nxt, rising=False)
        d_lo = _cross(t, v, thr + 0.1 * amp, ip, nxt, rising=False)
        h_up = _cross(t, v, thr + 0.5 * amp, it, ip + 1)
        h_dn = _cross(t, v, thr + 0.5 * amp, ip, nxt, rising=False)
        fa = slice(ip, ip + ms(KINETICS["fahp_search_end_ms"]) + 1)
        ma = slice(ip + ms(KINETICS["mahp_search_start_ms"]), min(v.size, nxt + 1))
        fa_min = fa.start + int(np.argmin(v[fa]))
        spikes.append(dict(
            peak_t_s=t[ip] / 1000, threshold_mV=thr, peak_mV=pk, amplitude_mV=amp,
            rise_ms=r_hi - r_lo, decay_ms=d_lo - d_hi, fwhm_ms=h_dn - h_up,
            fahp_mV=v[fa].min(), mahp_mV=v[ma].min(),
            up=ds[it:ip + 1].max(), down=ds[ip:fa_min + 1].min()))
    return spikes


# ---------------------------------------------------------------------------

def main():
    # #27: index k of the interpolated track is at k / (sr * factor).
    ramp = np.arange(6, dtype=float)
    track, sr_i = _interp_to_200khz(ramp, FS_REC)
    k = np.arange(track.size)
    check("interp clock", np.allclose(track, k * FS_REC / sr_i), "samples not at k/(sr·factor)")

    v100 = simulate(LEVELS)
    dec = int(FS // FS_REC)
    v20 = [row[::dec].copy() for row in v100]
    n = v20[0].size
    tt = np.arange(n) / FS_REC
    on, off = ON_MS / 1000, OFF_MS / 1000
    # As the AP window builds Manual Im (api/ap.py), with its step window.
    im = [np.where((tt >= on) & (tt < off), lv, 0.0) for lv in LEVELS]
    res = run_ap(
        sweeps_vm=v20, sweeps_im=im, sweep_indices=list(range(len(LEVELS))), sr=FS_REC,
        detection=DETECTION, kinetics=KINETICS, rheobase_mode="record", ramp_params=None,
        im_onset_s=on, im_windows_s=[(on, off)] * len(LEVELS),
    )
    truth = [reference(row, FS) for row in v100]

    counts = [len(s) for s in truth]
    check("some sweeps fire, some don't", 0 in counts and max(counts) >= 4, f"counts {counts}")
    # The −slope trap (#22) needs the next spike within the 100 ms decay search.
    top = [s["peak_t_s"] for s in truth[-1]]
    check("top step fires within 100 ms", len(top) > 1 and min(np.diff(top)) < 0.1, f"peaks {top}")
    for i, ps in enumerate(res["per_sweep"]):
        check(f"sweep {i + 1} spike count", ps["spike_count"] == counts[i],
              f"{ps['spike_count']} vs {counts[i]}")
        check(f"sweep {i + 1} F-I current", ps["im_mean_pa"] is not None
              and abs(ps["im_mean_pa"] - LEVELS[i]) < 1e-9, f"{ps['im_mean_pa']} vs {LEVELS[i]}")
        if counts[i]:
            lat = ps.get("first_spike_latency_s")
            want = truth[i][0]["peak_t_s"] - on
            check(f"sweep {i + 1} latency", lat is not None and abs(lat - want) * 1000 < TOL["latency_ms"],
                  f"{lat} vs {want}")
    first = next(i for i, c in enumerate(counts) if c)
    check("rheobase record", res["rheobase"]["value"] == LEVELS[first],
          f"{res['rheobase']['value']} vs {LEVELS[first]}")

    worst = {}
    for sp in res["per_spike"]:
        g = min(truth[sp["sweep"]], key=lambda x: abs(x["peak_t_s"] - sp["peak_t_s"]))
        pairs = dict(threshold_mV=(sp["threshold_vm"], g["threshold_mV"]),
                     peak_mV=(sp["peak_vm"], g["peak_mV"]),
                     amplitude_mV=(sp["amplitude_mv"], g["amplitude_mV"]),
                     rise_ms=(None if sp["rise_time_s"] is None else sp["rise_time_s"] * 1000, g["rise_ms"]),
                     decay_ms=(None if sp["decay_time_s"] is None else sp["decay_time_s"] * 1000, g["decay_ms"]),
                     fwhm_ms=(None if sp["half_width_s"] is None else sp["half_width_s"] * 1000, g["fwhm_ms"]),
                     fahp_mV=(sp["fahp_vm"], g["fahp_mV"]), mahp_mV=(sp["mahp_vm"], g["mahp_mV"]))
        for key, (got, want) in pairs.items():
            err = None if got is None else abs(got - want)
            worst[key] = max(worst.get(key, 0.0), float("inf") if err is None else err)
        for key, got, want in (("up_rel", sp["max_rise_slope_mv_ms"], g["up"]),
                               ("down_rel", sp["max_decay_slope_mv_ms"], g["down"])):
            err = float("inf") if got is None else abs(got / want - 1)
            worst[key] = max(worst.get(key, 0.0), err)
    for key, err in worst.items():
        check(key, err <= TOL[key], f"worst error {err:.4g} > {TOL[key]}")

    # #21: a later threshold (Sekerli I) leaves a rising phase shorter than
    # the 0.5 ms slope window at 20 kHz; +slope must still be there. The
    # steepest point lies after either threshold, so the reference holds.
    sek = run_ap(
        sweeps_vm=v20, sweeps_im=im, sweep_indices=list(range(len(LEVELS))), sr=FS_REC,
        detection=DETECTION, kinetics={**KINETICS, "threshold_method": "sekerli_I"},
        rheobase_mode="record", ramp_params=None, im_onset_s=on, im_windows_s=[(on, off)] * len(LEVELS),
    )
    for sp in sek["per_spike"]:
        g = min(truth[sp["sweep"]], key=lambda x: abs(x["peak_t_s"] - sp["peak_t_s"]))
        up = sp["max_rise_slope_mv_ms"]
        check("+slope with Sekerli I", up is not None and abs(up / g["up"] - 1) <= TOL["up_rel"],
              f"{up} vs {g['up']:.1f}")

    # Through the endpoint: Manual Im, analysis bounds over the whole sweep,
    # no protocol (as for ABF / NWB files).
    # The recording also carries its stimulus as a channel, as an NWB
    # file does (trace 1, in A → pA after the reader's scaling).
    rec = Recording(file_path="synthetic.nwb", file_name="synthetic.nwb", format="NWB", groups=[
        Group(index=0, series_list=[Series(index=0, label="CC_steps", sweeps=[
            Sweep(index=i, traces=[Trace(data=v, sampling_rate=FS_REC, units="mV", label="Vm"),
                                   Trace(data=im[i], sampling_rate=FS_REC, units="pA", label="Stimulus")])
            for i, v in enumerate(v20)])])])
    ap_api.get_current_recording = lambda: rec
    common = dict(group=0, series=0, trace=0, detection=DETECTION, kinetics=KINETICS, rheobase_mode="record")
    runs = {
        "Manual Im": ap_api.APRunRequest(
            **common, manual_im_enabled=True, manual_im_start_s=on, manual_im_end_s=off,
            manual_im_start_pa=LEVELS[0], manual_im_step_pa=LEVELS[1] - LEVELS[0]),
        "recorded trace": ap_api.APRunRequest(**common, im_trace=1),          # #28
    }
    for how, req in runs.items():
        api_res = asyncio.run(ap_api.ap_run(req))
        for i, ps in enumerate(api_res["per_sweep"]):
            check(f"endpoint ({how}) sweep {i + 1} F-I current", ps["im_mean_pa"] is not None
                  and abs(ps["im_mean_pa"] - LEVELS[i]) < 1e-9, f"{ps['im_mean_pa']} vs {LEVELS[i]}")
            if counts[i]:
                lat = ps.get("first_spike_latency_s")
                want = truth[i][0]["peak_t_s"] - on
                check(f"endpoint ({how}) sweep {i + 1} latency", lat is not None
                      and abs(lat - want) * 1000 < TOL["latency_ms"], f"{lat} vs {want}")
        check(f"endpoint ({how}) rheobase", api_res["rheobase"]["value"] == LEVELS[first],
              f"{api_res['rheobase']['value']} vs {LEVELS[first]}")

    if fails:
        print("FAIL")
        for f in fails:
            print("  " + f)
        sys.exit(1)
    print(f"OK  ({len(res['per_spike'])} spikes; worst: "
          + ", ".join(f"{k} {v:.3g}" for k, v in worst.items()) + ")")


if __name__ == "__main__":
    main()
