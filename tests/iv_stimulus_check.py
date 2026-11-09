"""I-V with a recorded stimulus trace, and the voltage-clamp reversal.

Passive cells with known answers, held in memory:
- current clamp: V = EL + R·I with a membrane time constant;
- voltage clamp: I = (V − EL) / R from a holding potential, so the true
  reversal is EL, not the holding potential.

Checked:
- utils.stimulus.find_step / steps_for_series on clean and noisy steps,
  and a 0 pA sweep (no step) taking its neighbours' timing (#28);
- the I-V endpoint with ``stim_trace``: levels, unit (#28);
- Manual Im in voltage clamp reports the levels in mV (#24);
- Cohort's reversal potential: EL in voltage clamp, from the absolute
  currents; none in current clamp (#24).

Run from the repo root:  python tests/iv_stimulus_check.py
"""

import asyncio
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import api.iv as iv_api  # noqa: E402
from analysis.cohort import extract_iv  # noqa: E402
from readers.models import Recording, Group, Series, Sweep, Trace  # noqa: E402
from utils.stimulus import find_step, steps_for_series  # noqa: E402

SR = 20_000.0
N = int(0.6 * SR)
ON, OFF = 0.1, 0.5
t = np.arange(N) / SR
step = (t >= ON) & (t < OFF)
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name}: {detail}")


def iv(rec, **kw):
    iv_api.get_current_recording = lambda: rec
    args = dict(group=0, series=0, trace=0, baseline_start_s=0.0, baseline_end_s=0.09,
                peak_start_s=0.4, peak_end_s=0.49, sweeps=None, manual_im_enabled=False,
                manual_im_start_s=0.0, manual_im_end_s=0.0, manual_im_start_pa=0.0,
                manual_im_step_pa=0.0, stim_trace=None)
    args.update(kw)
    return asyncio.run(iv_api.run_iv(**args))


def as_sidecar(res):
    """The I-V entry as the window stores it (camelCase), for Cohort."""
    return dict(responseMetric="steady", stimUnit=res["stim_unit"], responseUnit=res["response_unit"],
                points=[dict(stimLevel=p["stim_level"], baseline=p["baseline"], steadyState=p["steady_state"],
                             transientPeak=p["transient_peak"], sagAmp=p["sag_amp"], sagRatio=p["sag_ratio"])
                        for p in res["points"]])


def series(resp, resp_units, stim, stim_units):
    return Recording(file_path="x.nwb", file_name="x.nwb", format="NWB", groups=[Group(index=0, series_list=[
        Series(index=0, sweeps=[Sweep(index=i, traces=[
            Trace(data=r, sampling_rate=SR, units=resp_units, label="Response"),
            Trace(data=s, sampling_rate=SR, units=stim_units, label="Stimulus")])
            for i, (r, s) in enumerate(zip(resp, stim))])])])


def main():
    rng = np.random.default_rng(1)
    # --- the step detector
    clean = np.where(step, 125.0, 0.0)
    s = find_step(clean, SR)
    check("clean step", s is not None and s.level == 125.0 and abs(s.start_s - ON) < 1e-9
          and abs(s.end_s - OFF) < 1e-9, f"{s}")
    noisy = np.where(step, -70.0, -40.0) + rng.normal(0, 1.5, N)
    s = find_step(noisy, SR)
    check("noisy step", s is not None and abs(s.level + 70) < 0.2 and abs(s.start_s - ON) < 0.002
          and abs(s.end_s - OFF) < 0.002, f"{s}")
    check("flat sweep has no step", find_step(np.zeros(N) + rng.normal(0, 0.5, N), SR) is None)
    steps = steps_for_series([np.where(step, -50.0, 0.0), np.zeros(N), np.where(step, 50.0, 0.0)], SR)
    check("0 pA sweep gets the neighbours' timing", steps[1] is not None and steps[1].level == 0.0
          and abs(steps[1].start_s - ON) < 1e-9, f"{steps[1]}")

    # --- current clamp: V = EL + R·I, tau 20 ms
    EL, R, tau = -68.0, 150.0, 0.02
    levels = [-100.0 + 25.0 * k for k in range(7)]
    resp, stim = [], []
    for I in levels:
        dv = R * I / 1000.0                                 # mV (MΩ·pA = µV → /1000)
        on = np.where(step, 1 - np.exp(-(t - ON) / tau), 0.0)
        off = np.where(t >= OFF, (1 - np.exp(-(OFF - ON) / tau)) * np.exp(-(t - OFF) / tau), 0.0)
        resp.append(EL + dv * (on + off))
        stim.append(np.where(step, I, 0.0))
    rec = series(resp, "mV", stim, "pA")
    res = iv(rec, stim_trace=1)
    got = [p["stim_level"] for p in res["points"]]
    check("CC levels from the trace", np.allclose(got, levels), f"{got}")
    check("CC stim unit", res["stim_unit"] == "pA", res["stim_unit"])
    check("CC source reported", res["im_source"]["mode"] == "trace", f"{res['im_source']}")
    sc = extract_iv(as_sidecar(res), {})
    check("CC: no reversal potential", sc.scalars["reversal_potential"] is None,
          f"{sc.scalars['reversal_potential']}")
    check("CC slope = R", abs(sc.scalars["iv_slope"] * 1000 - R) < 0.5, f"{sc.scalars['iv_slope']}")

    # --- voltage clamp: hold -70, true reversal EL = -60
    EL, R, HOLD = -60.0, 200.0, -70.0
    cmds = [-120.0 + 10.0 * k for k in range(15)]
    resp = [1000.0 * (np.where(step, v, HOLD) - EL) / R for v in cmds]          # pA
    stim = [np.where(step, v, HOLD) for v in cmds]
    rec = series(resp, "pA", stim, "mV")
    res = iv(rec, stim_trace=1)
    got = [p["stim_level"] for p in res["points"]]
    check("VC levels from the trace", np.allclose(got, cmds), f"{got}")
    check("VC stim unit", res["stim_unit"] == "mV", res["stim_unit"])
    sc = extract_iv(as_sidecar(res), {})
    rev = sc.scalars["reversal_potential"]
    check("VC reversal = EL, not the holding potential", rev is not None and abs(rev - EL) < 0.01, f"{rev}")
    man = iv(rec, manual_im_enabled=True, manual_im_start_s=ON, manual_im_end_s=OFF,
             manual_im_start_pa=-120.0, manual_im_step_pa=10.0)
    check("VC manual levels are mV", man["stim_unit"] == "mV", man["stim_unit"])
    rev_m = extract_iv(as_sidecar(man), {}).scalars["reversal_potential"]
    check("VC reversal with Manual Im", rev_m is not None and abs(rev_m - EL) < 0.01, f"{rev_m}")

    if fails:
        print("FAIL")
        for f in fails:
            print("  " + f)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
