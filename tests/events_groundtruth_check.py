"""Synaptic event detection against ground truth.

Simulated spontaneous EPSCs (biexponential, log-normal amplitudes and time
constants, Poisson times) in band-limited noise, at 100 kHz, through a
4-pole Bessel low-pass at 2.9 kHz like an amplifier, sampled at 20 kHz.
The recording sits on a holding current, and the template carries it as
b0, as one fitted in the Template Generator does.

Checked, for template correlation and deconvolution:
- no two detections on the same sample or closer than the minimum
  interval (candidates were moved onto the same peak and both kept);
- a larger event 8 ms after a small one is counted once, with no extra
  detections (the peak search spanned the whole template, or +/-10 ms
  for deconvolution);
- sensitivity and false positives with a 5 x noise amplitude floor;
- deconvolution ignores the template's baseline offset b0 (it divided by
  a box of b0 with the event on top);
- every auto-detected event deflects in the search direction;
- the biexponential fit keeps tau_rise < tau_decay (it could swap them).

The design follows the blind ground-truth validation of November 2026.

Run from the repo root:  python tests/events_groundtruth_check.py
"""

import sys
from pathlib import Path

import warnings

import numpy as np
from scipy import signal
from scipy.optimize import OptimizeWarning

warnings.simplefilter("ignore", OptimizeWarning)

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from analysis.events import fit_biexponential, render_template, run_events  # noqa: E402

FS_SIM, FS = 100_000.0, 20_000.0
DEC = int(FS_SIM // FS)
HOLD = -20.0                     # pA
SIGMA = 1.0                      # noise SD at 20 kHz, pA
MIN_IEI_MS = 5.0
TOL_S = 0.003

fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name}: {detail}")


def bessel(x):
    b, a = signal.bessel(4, 2900.0, fs=FS_SIM, norm="mag")
    return signal.lfilter(b, a, x)


def kernel(tr, td, ms=80.0):
    t = np.arange(int(ms / 1000 * FS_SIM)) / FS_SIM * 1000
    f = np.exp(-t / td) - np.exp(-t / tr)
    return -f / f.max()


def simulate(rng, dur_s, events):
    """events: list of (onset_s, amp_pA, tau_r_ms, tau_d_ms). Returns the
    20 kHz recording and each event's true peak time (event alone, filtered)."""
    n = int(dur_s * FS_SIM)
    clean = np.zeros(n)
    peaks = []
    for on, amp, tr, td in events:
        k = amp * kernel(tr, td)
        i0 = int(round(on * FS_SIM))
        clean[i0:i0 + k.size] += k[: n - i0]
        kf = bessel(np.r_[k, np.zeros(1000)])
        peaks.append((i0 + int(np.argmin(kf))) / FS_SIM)
    w = rng.standard_normal(n)
    noise = bessel(w)[::DEC]
    noise *= SIGMA / noise.std()
    x = bessel(clean)[::DEC] + noise + HOLD
    return x, np.array(peaks)


def match(det_t, true_t):
    pairs = sorted((abs(a - b), i, j) for i, a in enumerate(det_t)
                   for j in np.flatnonzero(np.abs(true_t - a) <= TOL_S) for b in [true_t[j]])
    ud, ut, n = set(), set(), 0
    for _, i, j in pairs:
        if i not in ud and j not in ut:
            ud.add(i); ut.add(j); n += 1
    return n, ut


def detect(x, method, template, floor):
    cutoff = 0.4 if method == "template_correlation" else 3.5
    recs, _ = run_events(x, FS, method=method, template=template, cutoff=cutoff,
                         deconv_low_hz=1.0, deconv_high_hz=200.0, direction="negative",
                         min_iei_ms=MIN_IEI_MS, avg_peak_ms=0.0, amplitude_min_abs=floor)
    return recs


def main():
    rng = np.random.default_rng(20261109)
    # Template as the Template Generator would store it: fitted on the raw
    # trace, so b0 is the holding current.
    tmpl = render_template(HOLD, -12.0, 0.0010, 0.0045, 30.0, FS)
    tmpl0 = render_template(0.0, -12.0, 0.0010, 0.0045, 30.0, FS)
    floor = 5 * SIGMA

    # --- 1. spontaneous events, 30 s at 5 Hz, mean amplitude 12 pA ---
    dur = 30.0
    t, ev = 0.1, []
    while True:
        t += rng.exponential(0.2)
        if t > dur - 0.2:
            break
        s2 = np.log(1 + 0.35 ** 2)
        amp = rng.lognormal(np.log(12.0) - s2 / 2, np.sqrt(s2))
        tr, td = (rng.lognormal(np.log(m) - np.log(1 + 0.09) / 2, np.sqrt(np.log(1.09))) for m in (0.5, 5.0))
        ev.append((t, amp, tr, max(td, 2 * tr)))
    x, true_t = simulate(rng, dur, ev)
    big = np.array([e[1] for e in ev]) >= 2 * floor          # clearly above the floor
    min_dist = int(round(MIN_IEI_MS / 1000 * FS))
    for method in ("template_correlation", "template_deconvolution"):
        recs = detect(x, method, tmpl, floor)
        idx = np.array([r.peak_idx for r in recs])
        check(f"{method}: no duplicate peaks", idx.size == np.unique(idx).size,
              f"{idx.size - np.unique(idx).size} duplicates")
        check(f"{method}: minimum interval", idx.size < 2 or np.diff(np.sort(idx)).min() >= min_dist,
              f"closest {np.diff(np.sort(idx)).min() if idx.size > 1 else '-'} samples")
        det_t = np.array([r.peak_time_s for r in recs])
        hits, ut = match(det_t, true_t)
        sens_big = np.mean([j in ut for j in np.flatnonzero(big)])
        fp_min = (len(recs) - hits) / (dur / 60)
        check(f"{method}: sensitivity (events >= 2x floor)", sens_big >= 0.95, f"{sens_big:.3f}")
        check(f"{method}: false positives", fp_min <= 4.0, f"{fp_min:.1f}/min")
        check(f"{method}: direction", all(r.amplitude < 0 for r in recs),
              f"{sum(r.amplitude >= 0 for r in recs)} events of the wrong sign")
        sw = [r for r in recs if r.biexp_tau_rise_ms is not None and r.biexp_tau_decay_ms is not None
              and r.biexp_tau_rise_ms > r.biexp_tau_decay_ms]
        check(f"{method}: per-event biexp keeps tau_rise < tau_decay", not sw, f"{len(sw)} swapped")
        if method == "template_deconvolution":
            r0 = detect(x, method, tmpl0, floor)
            check("deconvolution ignores template b0",
                  [r.peak_idx for r in r0] == idx.tolist(), f"{len(r0)} vs {len(recs)} events")
        print(f"  {method}: {len(recs)} events, sensitivity {sens_big:.3f} (>= 2x floor), "
              f"{fp_min:.1f} false/min", flush=True)

    # --- 2. a small event 8 ms before a larger one; pairs 300 ms apart ---
    # The old peak search (whole template for correlation, +/-10 ms for
    # deconvolution) moved candidates onto the larger peak and kept them
    # all (20 extra detections here). Each larger event must be found
    # once and nothing added. Whether the small one is found depends on
    # the method's own sensitivity: correlation's 30 ms window holds the
    # larger event, so r stays low at the small one (see the manual).
    pairs = []
    for k in range(20):
        t0 = 0.2 + 0.3 * k
        pairs += [(t0, 10.0, 0.5, 5.0), (t0 + 0.008, 40.0, 0.5, 5.0)]
    x2, t2 = simulate(rng, 6.4, pairs)
    for method in ("template_correlation", "template_deconvolution"):
        recs = detect(x2, method, tmpl, floor)
        det_t = np.array([r.peak_time_s for r in recs])
        hits, ut = match(det_t, t2)
        large = np.mean([j in ut for j in range(1, len(t2), 2)])
        check(f"{method}: larger event of each pair found", large >= 0.95, f"{large:.2f}")
        check(f"{method}: pairs, no extra detections", len(recs) - hits <= 1, f"{len(recs) - hits} extra")

    # --- 3. template fit on single noisy events ---
    swapped, err = 0, []
    for k in range(40):
        tr, td = 0.5 + 0.5 * rng.random(), 3.0 + 4.0 * rng.random()
        tt = np.arange(int(0.03 * FS)) / FS
        y = -15.0 * (np.exp(-tt * 1e3 / td) - np.exp(-tt * 1e3 / tr)) + rng.normal(0, 1.5, tt.size)
        f = fit_biexponential(tt, y, direction="negative")
        swapped += f.tau_rise_s > f.tau_decay_s
    check("fit_biexponential keeps tau_rise < tau_decay", swapped == 0, f"{swapped}/40 swapped")
    tt = np.arange(int(0.03 * FS)) / FS
    y = -15.0 * (1 - np.exp(-tt / 0.0008)) * np.exp(-tt / 0.005)
    f = fit_biexponential(tt, y, direction="negative")
    check("fit_biexponential recovers a clean event",
          abs(f.tau_rise_s / 0.0008 - 1) < 0.02 and abs(f.tau_decay_s / 0.005 - 1) < 0.02,
          f"tau_rise {f.tau_rise_s * 1e3:.3f} ms, tau_decay {f.tau_decay_s * 1e3:.3f} ms")

    if fails:
        print("FAIL")
        for m in fails:
            print("  " + m)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
