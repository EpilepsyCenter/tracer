"""Numerical checks for backend/analysis/spectral.py against signals with
known answers. Run from the repo root:  python tests/spectral_check.py
Prints "OK" when every check passes."""

from __future__ import annotations

import math
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from analysis import spectral as S  # noqa: E402

rng = np.random.default_rng(0)
failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(f"{name}: {detail}")


def rel(a: float, b: float) -> float:
    return abs(a - b) / abs(b)


sr = 10_000.0
t = np.arange(int(60 * sr)) / sr

# 1. White noise: total power over 0..Nyquist equals the variance.
sigma = 0.2
noise = rng.normal(0, sigma, len(t))
p = S.merged_params({"fmin": 0.0, "fmax": sr / 2, "exclude_line_noise": False, "bands": []})
info = S.compute_psd([noise], sr, p)
df = info["freqs"][1] - info["freqs"][0]
total = float(info["psd"].sum() * df)
check("white noise variance", rel(total, sigma ** 2) < 0.03, f"{total} vs {sigma**2}")
check("freq resolution", abs(info["freq_res_hz"] - 0.5) < 1e-9, str(info["freq_res_hz"]))

# 2. Pooled Welch over one piece matches scipy.signal.welch exactly.
f_ref, p_ref = sps.welch(noise, fs=sr, nperseg=20000, noverlap=10000, window="hann", detrend="constant")
keep = f_ref <= p["fmax"]
check("matches scipy welch", np.allclose(info["psd"], p_ref[keep], rtol=1e-10),
      str(np.max(np.abs(info["psd"] - p_ref[keep]))))

# 3. Median averaging matches scipy welch(average='median').
pm = {**p, "average": "median"}
im = S.compute_psd([noise], sr, pm)
_, p_med = sps.welch(noise, fs=sr, nperseg=20000, noverlap=10000, window="hann",
                     detrend="constant", average="median")
check("matches scipy median welch", np.allclose(im["psd"], p_med[keep], rtol=1e-10))

# 4. Sine amplitude A at 8 Hz → theta band power ≈ A²/2.
A = 0.5
sine = A * np.sin(2 * np.pi * 8.0 * t) + rng.normal(0, 0.01, len(t))
pb = S.merged_params({"exclude_line_noise": False})
res = S.analyse_region([sine], sr, pb)
theta = res["bands"]["theta"]["power"]
check("sine band power", rel(theta, A ** 2 / 2) < 0.02, f"{theta} vs {A**2/2}")
check("sine theta peak", abs(res["bands"]["theta"]["peak_freq_hz"] - 8.0) < 0.6,
      str(res["bands"]["theta"]["peak_freq_hz"]))
check("dominant freq", abs(res["dominant_freq_hz"] - 8.0) < 0.6, str(res["dominant_freq_hz"]))
check("relative theta ~1", res["bands"]["theta"]["relative"] > 0.95, str(res["bands"]["theta"]["relative"]))

# 5. Multiple sweeps pooled: same answer as one long piece of the same process.
pieces = [sine[i * 100_000:(i + 1) * 100_000] for i in range(6)]
res_p = S.analyse_region(pieces, sr, pb)
check("pooled sweeps band power", rel(res_p["bands"]["theta"]["power"], A ** 2 / 2) < 0.03)
check("pooled segment count", res_p["n_segments"] == 6 * 9, str(res_p["n_segments"]))

# 6. A rhythm not phase-locked across sweeps survives pooling (time-domain
#    averaging would cancel it).
locked = []
for i in range(8):
    ph = rng.uniform(0, 2 * np.pi)
    locked.append(A * np.sin(2 * np.pi * 20.0 * t[:50_000] + ph))
res_l = S.analyse_region(locked, sr, pb)
check("non-phase-locked rhythm kept", rel(res_l["bands"]["beta"]["power"], A ** 2 / 2) < 0.03,
      str(res_l["bands"]["beta"]["power"]))

# 7. Line noise: 50 Hz at amplitude 0.05 → RMS 0.05/√2, prominent; and
#    excluding it keeps it out of low gamma.
hum = 0.05 * np.sin(2 * np.pi * 50.0 * t)
x = rng.normal(0, 0.01, len(t)) + hum
r_on = S.analyse_region([x], sr, S.merged_params({"exclude_line_noise": True}))
r_off = S.analyse_region([x], sr, S.merged_params({"exclude_line_noise": False}))
ln = r_on["line_noise"]
check("line rms", rel(ln["harmonics"][0]["rms"], 0.05 / math.sqrt(2)) < 0.05,
      str(ln["harmonics"][0]["rms"]))
check("line prominence", ln["harmonics"][0]["prominence_db"] > 20, str(ln["harmonics"][0]["prominence_db"]))
lg_on = r_on["bands"]["low gamma"]["power"]
lg_off = r_off["bands"]["low gamma"]["power"]
expected_noise_lg = (0.01 ** 2) / (sr / 2) * 50.0   # white floor × bandwidth
check("line exclusion", rel(lg_on, expected_noise_lg) < 0.1, f"{lg_on} vs {expected_noise_lg}")
check("line inclusion", lg_off > 10 * lg_on, f"{lg_off} vs {lg_on}")

# 8. Band beyond spectrum → None, not 0.
r_hi = S.analyse_region([x[:20000]], 800.0, S.merged_params({}))
check("band above nyquist", r_hi["bands"]["fast ripple"]["power"] is None)

# 9. Periodogram on a sine also integrates to A²/2.
r_pg = S.analyse_region([sine[:200_000]], sr, S.merged_params({"method": "periodogram",
                                                                "exclude_line_noise": False}))
check("periodogram band power", rel(r_pg["bands"]["theta"]["power"], A ** 2 / 2) < 0.02,
      str(r_pg["bands"]["theta"]["power"]))
check("thinned for display", len(r_pg["freqs"]) <= S.MAX_SPECTRUM_POINTS + 1, str(len(r_pg["freqs"])))

# 10. Region shorter than a segment → clear error.
try:
    S.analyse_region([sine[:5000]], sr, pb)
    check("short region error", False, "no error raised")
except ValueError as e:
    check("short region error", "shorter than one Welch segment" in str(e), str(e))

# 11. Regions over a fake series: sweep ranges, exclusions, time windows.
def fake_series(arrs):
    sweeps = [SimpleNamespace(trace_count=1, traces=[SimpleNamespace(
        data=a, sampling_rate=sr, units="mV")]) for a in arrs]
    return SimpleNamespace(sweep_count=len(sweeps), sweeps=sweeps)

ser = fake_series(pieces)
out = S.run_regions(
    ser, 0,
    [{"id": "a", "label": "all", "sweep_from": None, "sweep_to": None},
     {"id": "b", "label": "s2-3 5-9s", "sweep_from": 1, "sweep_to": 2, "t_start": 5, "t_end": 9},
     {"id": "c", "label": "too short", "t_start": 0, "t_end": 0.5}],
    {"exclude_line_noise": False}, excluded=[3], scaled_fn=lambda tr: tr.data,
)
check("region all sweeps minus excluded", out[0]["sweeps_used"] == [0, 1, 2, 4, 5], str(out[0].get("sweeps_used")))
check("region window duration", abs(out[1]["duration_s"] - 8.0) < 1e-6, str(out[1].get("duration_s")))
check("region error isolated", "error" in out[2] and "error" not in out[0])
check("units carried", out[0]["units"] == "mV")

# 12. Spectrogram: decimates, finds the 8 Hz line, times offset applied.
sg = S.compute_spectrogram(sine[:300_000], sr, 12.0, {"spec_window_s": 1.0, "spec_fmax": 100.0})
pdb = sg["power_db"]
peak_row = int(np.argmax(pdb.mean(axis=1)))
check("spectrogram peak", abs(sg["freqs"][peak_row] - 8.0) < 1.5, str(sg["freqs"][peak_row]))
check("spectrogram decimated", sg["analysis_rate_hz"] < 1000, str(sg["analysis_rate_hz"]))
check("spectrogram time offset", sg["times"][0] > 12.0, str(sg["times"][0]))

# 13. Band power over time: gamma switches on halfway → low-gamma power
#     jumps in the second half, matching A²/2; theta stays constant.
tt = np.arange(int(120 * 2000)) / 2000.0
xg = (rng.normal(0, 0.01, len(tt)) + 0.05 * np.sin(2 * np.pi * 6 * tt)
      + np.where(tt >= 60, 0.05 * np.sin(2 * np.pi * 40 * tt), 0))
sg_ser = SimpleNamespace(sweep_count=1, sweeps=[SimpleNamespace(trace_count=1, traces=[
    SimpleNamespace(data=xg, sampling_rate=2000.0, units="mV")])])
tc = S.band_timecourse(sg_ser, 0, {}, [], lambda tr: tr.data, bin_s=10.0)
lg = np.array(tc["bands"]["low gamma"]["power"])
th = np.array(tc["bands"]["theta"]["power"])
check("timecourse bins", len(tc["times"]) == 12 and abs(tc["times"][0] - 5.0) < 1e-9, str(tc["times"][:3]))
check("timecourse gamma onset", lg[:6].max() < 0.1 * lg[6:].min(), f"{lg}")
check("timecourse gamma level", rel(float(lg[6:].mean()), 0.05 ** 2 / 2) < 0.05, str(lg[6:].mean()))
check("timecourse theta steady", rel(float(th.min()), float(th.max())) < 0.05, f"{th}")
# Bins agree with the region analysis of the same stretch.
reg = S.run_regions(sg_ser, 0, [{"id": "x", "label": "x", "t_start": 60, "t_end": 70}], {}, [], lambda tr: tr.data)[0]
check("timecourse matches region", rel(float(lg[6]), reg["bands"]["low gamma"]["power"]) < 1e-9)
try:
    S.band_timecourse(sg_ser, 0, {}, [], lambda tr: tr.data, bin_s=1.0)
    check("timecourse short bin error", False, "no error")
except ValueError as e:
    check("timecourse short bin error", "shorter than the Welch segment" in str(e), str(e))

if failures:
    print("FAIL")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("OK")
