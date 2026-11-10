"""Resistance (Rs, Rin, tau, Cm) against ground truth.

A passive cell (Rm, Cm) behind a series resistance Rs is stepped by
-10 mV in voltage clamp; the current is solved analytically. Checked:

- unfiltered at 100 kHz: Rs, Rin = Rs + Rm, tau and Cm exact (within
  1-2 %), which tests the formulas, including Cm = tau * (Rs + Rm) /
  (Rs * Rm) (it was tau / Rs, which reads low by Rm / (Rs + Rm));
- through a 2.9 kHz 4-pole Bessel at 20 kHz, with noise, as in the blind
  ground-truth test: tau within 2 % with a monoexponential over 5 tau,
  Rin within 2 %, and Rs high / Cm low only by the filter's blunting of
  the peak (bounded here).

Run from the repo root:  python tests/resistance_groundtruth_check.py
"""

import sys
import warnings
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.optimize import OptimizeWarning

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from analysis.resistance import ResistanceAnalysis  # noqa: E402

warnings.simplefilter("ignore", OptimizeWarning)
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name}: {detail}")


def vc_current(Rs, Rm, Cm, fs, vstep=-10.0, on=0.05, off=0.25, dur=0.4):
    """Pipette current (pA) for a step from 0 to vstep (mV) relative to rest."""
    t = np.arange(int(dur * fs)) / fs
    tau = Rs * Rm / (Rs + Rm) * Cm * 1e-3            # ms
    vss = vstep * Rm / (Rs + Rm)
    vm = np.zeros_like(t)
    a = (t >= on) & (t < off)
    vm[a] = vss * (1 - np.exp(-(t[a] - on) * 1e3 / tau))
    vend = vss * (1 - np.exp(-(off - on) * 1e3 / tau))
    b = t >= off
    vm[b] = vend * np.exp(-(t[b] - off) * 1e3 / tau)
    vcmd = np.where(a, vstep, 0.0)
    return 1000.0 * (vcmd - vm) / Rs, tau


def run(i, fs, fit_ms):
    return ResistanceAnalysis().run(i, fs, dict(
        v_step=-10.0, baselineStart=0.0, baselineEnd=0.0495, peakStart=0.05, peakEnd=0.25,
        n_exp=1, fit_duration_ms=fit_ms))


CELLS = [  # Rs MOhm, Rm MOhm, Cm pF (the six cells of the blind test)
    (12.0, 118.0, 150.0), (8.0, 159.3, 110.0), (15.0, 84.0, 200.0),
    (10.0, 167.7, 130.0), (20.0, 101.1, 170.0), (6.0, 142.2, 120.0),
]

rng = np.random.default_rng(1)
worst = dict(rs_f=0.0, cm_f=0.0)
for Rs, Rm, Cm in CELLS:
    # 1. formulas: unfiltered, 100 kHz, sample right at the step
    fs = 100_000.0
    i, tau = vc_current(Rs, Rm, Cm, fs)
    r = run(i, fs, 5 * tau)
    check(f"Rs {Rs}", abs(r["rs"] / Rs - 1) < 0.01, f"{r['rs']:.3f}")
    check(f"Rin {Rs}+{Rm}", abs(r["rin"] / (Rs + Rm) - 1) < 0.01, f"{r['rin']:.2f}")
    check(f"tau {tau:.3f}", abs(r["tau"] / tau - 1) < 0.02, f"{r['tau']:.4f}")
    check(f"Cm {Cm} (full formula)", abs(r["cm"] / Cm - 1) < 0.02, f"{r['cm']:.1f}")

    # 2. recording chain: Bessel 2.9 kHz at 400 kHz, sampled at 20 kHz, noise
    fsim = 400_000.0
    i, tau = vc_current(Rs, Rm, Cm, fsim)
    bb, aa = signal.bessel(4, 2900.0, fs=fsim, norm="mag")
    rec = signal.lfilter(bb, aa, i)[::20] + rng.normal(0, 2.0, i.size // 20)
    r = run(rec, 20_000.0, 15.0)
    check(f"filtered tau {tau:.3f}", abs(r["tau"] / tau - 1) < 0.02, f"{r['tau']:.4f}")
    check(f"filtered Rin {Rs}+{Rm}", abs(r["rin"] / (Rs + Rm) - 1) < 0.02, f"{r['rin']:.2f}")
    e_rs, e_cm = r["rs"] / Rs - 1, r["cm"] / Cm - 1
    worst["rs_f"] = max(worst["rs_f"], abs(e_rs)); worst["cm_f"] = max(worst["cm_f"], abs(e_cm))
    check(f"filtered Rs {Rs} (filter blunts the peak)", 0 <= e_rs < 0.25, f"{100 * e_rs:+.1f} %")
    check(f"filtered Cm {Cm}", -0.2 < e_cm <= 0.01, f"{100 * e_cm:+.1f} %")

if fails:
    print("FAIL")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print(f"OK  (2.9 kHz filter: Rs up to +{100 * worst['rs_f']:.0f} %, Cm down to -{100 * worst['cm_f']:.0f} %)")
