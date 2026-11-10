"""Two-channel coupling (backend/analysis/coupling.py) on signals with known
answers. Run from the repo root:  python tests/coupling_check.py"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from scipy import signal as sps

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from analysis import coupling as C  # noqa: E402
from analysis import spectral as S  # noqa: E402

failures: list[str] = []


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name}: {detail}")


sr = 2000.0
n = int(120 * sr)
t = np.arange(n) / sr
rng = np.random.default_rng(3)
# Shared source: 1–40 Hz noise plus an 8 Hz rhythm.
sos = sps.butter(4, [1, 40], btype="bandpass", fs=sr, output="sos")
src = sps.sosfiltfilt(sos, rng.normal(0, 1, n))
src = src / src.std() + 0.8 * np.sin(2 * np.pi * 8 * t)
TAU = 0.00735                                    # fractional number of samples


def delayed(x, tau):
    f = np.fft.rfftfreq(len(x), 1 / sr)
    return np.fft.irfft(np.fft.rfft(x) * np.exp(-2j * np.pi * f * tau), len(x))


def noise(scale):
    return sps.sosfiltfilt(sos, rng.normal(0, 1, n)) * scale


P = S.merged_params({"exclude_line_noise": True, "fmax": 200,
                     "bands": [{"name": "theta", "low": 4, "high": 12},
                               {"name": "beta", "low": 12, "high": 30}]})

# 1. Lagged coupling.
x = src + noise(0.3)
y = 0.7 * delayed(src, TAU) + noise(0.3)
res = C.analyse_coupling([x], [y], sr, P)
th = res["bands"]["theta"]
check("lagged: theta coherence high", th["coherence"] > 0.8, str(th["coherence"]))
check("lagged: phase-slope delay", th["phase_delay_ms"] is not None and abs(th["phase_delay_ms"] - TAU * 1000) < 0.5,
      str(th["phase_delay_ms"]))
check("lagged: wPLI high", th["wpli"] > 0.9, str(th["wpli"]))
check("lagged: debiased wPLI² close to wPLI²", abs(th["wpli_debiased"] - th["wpli"] ** 2) < 0.05,
      f'{th["wpli_debiased"]} vs {th["wpli"] ** 2}')
check("lagged: imaginary coherence positive (reference leads)", th["imag_coherence"] > 0.1, str(th["imag_coherence"]))
xc = res["xcorr"]
check("lagged: xcorr lag", xc["peak_lag_ms"] is not None and abs(xc["peak_lag_ms"] - TAU * 1000) < 0.2, str(xc["peak_lag_ms"]))
check("lagged: xcorr peak r", xc["peak_r"] > 0.8, str(xc["peak_r"]))

# 2. Channels swapped → delays flip sign.
res_s = C.analyse_coupling([y], [x], sr, P)
check("swap flips phase delay", abs(res_s["bands"]["theta"]["phase_delay_ms"] + TAU * 1000) < 0.5,
      str(res_s["bands"]["theta"]["phase_delay_ms"]))
check("swap flips xcorr lag", abs(res_s["xcorr"]["peak_lag_ms"] + TAU * 1000) < 0.2, str(res_s["xcorr"]["peak_lag_ms"]))
check("swap flips imaginary coherence", res_s["bands"]["theta"]["imag_coherence"] < -0.1,
      str(res_s["bands"]["theta"]["imag_coherence"]))

# 3. Zero-lag sharing (volume conduction): coherent but not lagged.
y0 = 0.7 * src + noise(0.3)
res0 = C.analyse_coupling([x], [y0], sr, P)
b0 = res0["bands"]["theta"]
check("zero lag: coherence still high", b0["coherence"] > 0.8, str(b0["coherence"]))
check("zero lag: wPLI low", b0["wpli"] < 0.3, str(b0["wpli"]))
check("zero lag: imaginary coherence ~0", abs(b0["imag_coherence"]) < 0.05, str(b0["imag_coherence"]))
check("zero lag: delay ~0", b0["phase_delay_ms"] is not None and abs(b0["phase_delay_ms"]) < 0.5, str(b0["phase_delay_ms"]))
check("zero lag: xcorr at 0", abs(res0["xcorr"]["peak_lag_ms"]) < 0.2, str(res0["xcorr"]["peak_lag_ms"]))

# 4. Independent channels: no coherence, no delay reported.
resi = C.analyse_coupling([x], [noise(1.0)], sr, P)
bi = resi["bands"]["theta"]
check("independent: coherence low", bi["coherence"] < 0.1, str(bi["coherence"]))
check("independent: no delay below the coherence floor", bi["phase_delay_ms"] is None, str(bi["phase_delay_ms"]))
# wPLI is biased above 0 with a finite number of segments; the debiased
# wPLI² (Vinck et al. 2011) is 0 on average. Over several independent
# pairs and every band, its mean is near 0 and well below wPLI's.
wp, dw = [], []
for _ in range(6):
    r_ = C.analyse_coupling([noise(1.0)], [noise(1.0)], sr, P)
    for v in r_["bands"].values():
        if v["wpli"] is not None:
            wp.append(v["wpli"]); dw.append(v["wpli_debiased"])
check("independent: debiased wPLI² ~0", abs(np.mean(dw)) < 0.01, f"mean {np.mean(dw):.4f}")
check("independent: wPLI biased above 0", np.mean(wp) > 0.05, f"mean {np.mean(wp):.3f}")

# 5. Through run_regions: two-channel fake series, several sweeps, one
#    sweep excluded; the coupling block rides on each region.
sweeps = []
for k in range(4):
    a, b = k * int(30 * sr), (k + 1) * int(30 * sr)
    sweeps.append(SimpleNamespace(trace_count=2, traces=[
        SimpleNamespace(data=x[a:b], sampling_rate=sr, units="mV"),
        SimpleNamespace(data=y[a:b], sampling_rate=sr, units="mV")]))
ser = SimpleNamespace(sweep_count=4, sweeps=sweeps)
out = S.run_regions(ser, 0, [{"id": "a", "label": "all"}, {"id": "b", "label": "early", "t_start": 0, "t_end": 10}],
                    {**P, "coupling_enabled": True, "coupling_channel": 1}, [2], lambda tr: tr.data)
cp = out[0].get("coupling") or {}
check("run_regions: coupling attached", "bands" in cp and "error" not in cp, str(cp.get("error")))
check("run_regions: excluded sweep skipped", out[0]["sweeps_used"] == [0, 1, 3], str(out[0]["sweeps_used"]))
check("run_regions: theta delay", abs((cp.get("bands", {}).get("theta", {}).get("phase_delay_ms") or 0) - TAU * 1000) < 0.5)
off = S.run_regions(ser, 0, [{"id": "a", "label": "all"}], {**P, "coupling_enabled": False, "coupling_channel": 1}, [], lambda tr: tr.data)
check("coupling off: no block", "coupling" not in off[0])

print(f"theta: coherence {th['coherence']:.3f} · wPLI {th['wpli']:.3f} · phase delay {th['phase_delay_ms']:.3f} ms · "
      f"xcorr {xc['peak_lag_ms']:.3f} ms (r {xc['peak_r']:.2f}) | zero-lag wPLI {b0['wpli']:.3f}")
if failures:
    print("FAIL")
    for f_ in failures:
        print("  -", f_)
    sys.exit(1)
print("OK")
