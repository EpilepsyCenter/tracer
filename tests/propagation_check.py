"""Dual-site propagation on a real field recording with a synthetic second
channel of known delay. Uses sample_data/heka_test_files/Burst_2.dat
(continuous 20 kHz field recording). The "CA1" channel is the recording
shifted by a fractional number of samples, scaled, with noise added and a
quarter of the discharges removed.
Run from the repo root:  python tests/propagation_check.py"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import api.files as af  # noqa: E402
from analysis.bursts import BurstDetection  # noqa: E402
from analysis import propagation as P  # noqa: E402

failures: list[str] = []


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name}: {detail}")


path = str(ROOT / "sample_data/heka_test_files/Burst_2.dat")
if not Path(path).exists():
    # The recording is lab data, not in the repository.
    print("SKIP: needs sample_data/heka_test_files/Burst_2.dat")
    sys.exit(0)
reader = next(r for r in af.READERS if r.can_read(path))
rec = reader.read(path, options=None)
tr = rec.groups[0].series_list[6].sweeps[0].traces[0]
sr = float(tr.sampling_rate)
x = np.asarray(tr.data, dtype=float)[: int(180 * sr)]          # first 3 min

params = {"method": "threshold", "baseline_mode": "percentile", "filter_enabled": True,
          "filter_type": "bandpass", "filter_low": 1, "filter_high": 50, "filter_order": 4,
          "noise_method": "sd", "n_sd": 1.5, "smooth_ms": 10, "min_duration_ms": 50,
          "min_gap_ms": 100, "baseline_percentile": 10, "baseline_window_s": 5,
          "baseline_end_s": 1, "pre_burst_window_ms": 100, "peak_direction": "auto"}


def detect(sig):
    out = BurstDetection().run(sig, sr, dict(params))
    return [{"sweepIndex": 0, "startS": b["start_s"], "endS": b["end_s"],
             "peakTimeS": b["peak_time_s"], "peakSigned": b["peak_signed"],
             "peakAmplitude": b["peak_amplitude"]} for b in out["bursts"]]


ref = detect(x)
check("reference has discharges", len(ref) > 30, str(len(ref)))

LAG_S = 0.00735                                   # 147 samples at 20 kHz: fractional
rng = np.random.default_rng(7)
f = np.fft.rfftfreq(len(x), 1 / sr)
shifted = np.fft.irfft(np.fft.rfft(x) * np.exp(-2j * np.pi * f * LAG_S), len(x))
partner = 0.6 * shifted
partner += rng.normal(0, 0.02 * np.std(partner), len(partner))
part_all = detect(partner)

# Simulate the two channels disagreeing, the way curated lists do: every
# 4th reference discharge "didn't reach" the partner (removed from the
# partner list), and every 7th partner discharge is "partner only"
# (removed from the reference list). Removing from the lists rather than
# the signal keeps the detector's noise-based threshold unchanged.
def nearest(ev, lst):
    return min(range(len(lst)), key=lambda j: abs(lst[j]["startS"] - ev["startS"] - LAG_S))

dropped = set(range(0, len(ref), 4))
drop_part = {nearest(ref[k], part_all) for k in dropped}
part = [e for j, e in enumerate(part_all) if j not in drop_part]
only_part = set(range(3, len(ref), 7)) - dropped
ref_full = ref
ref = [e for k, e in enumerate(ref_full) if k not in only_part]
expected_pairs = len(ref_full) - len(dropped) - len(only_part)
expected_frac = expected_pairs / len(ref)

series = SimpleNamespace(sweep_count=1, sweeps=[SimpleNamespace(trace_count=2, traces=[
    SimpleNamespace(data=x, sampling_rate=sr, units="mV"),
    SimpleNamespace(data=partner, sampling_rate=sr, units="mV")])])
res = P.analyse_propagation(series, 0, 1, ref, part, params, params,
                            {"max_lag_ms": 100}, [], lambda t: t.data)
s = res["summary"]
check("pairs", abs(s["n_pairs"] - expected_pairs) <= 2, f'{s["n_pairs"]} vs {expected_pairs}')
check("partner-only", abs(len(res["partner_only"]) - len(only_part)) <= 2,
      f'{len(res["partner_only"])} vs {len(only_part)}')
check("propagation fraction", abs(s["propagation_fraction"] - expected_frac) < 0.02,
      f'{s["propagation_fraction"]:.3f} vs {expected_frac:.3f}')
check("xcorr lag recovers shift", abs(s["lag_ms"]["xcorr"]["median"] - LAG_S * 1000) < 0.1,
      f'{s["lag_ms"]["xcorr"]["median"]:.3f} ms vs {LAG_S*1000} ms')
check("xcorr lag tight", (s["lag_ms"]["xcorr"]["q75"] - s["lag_ms"]["xcorr"]["q25"]) < 0.3,
      str(s["lag_ms"]["xcorr"]))
check("reference leads", s["ref_leads_fraction"] > 0.95, str(s["ref_leads_fraction"]))
check("amplitude ratio", abs(s["amp_ratio"]["median"] - 0.6) < 0.08, str(s["amp_ratio"]["median"]))
check("xcorr match quality", s["xcorr_r"]["median"] > 0.95, str(s["xcorr_r"]["median"]))
check("aligned average", res["average"] is not None and res["average"]["n"] > 10)
# The average must not be smeared by alignment jitter: its peak should be
# close to the typical single-discharge peak (measured the same way).
from analysis.bursts import _apply_pre_detection_filter  # noqa: E402
xf = _apply_pre_detection_filter(x, sr, params)
single = []
for row in res["pairs"]:
    ev_ = ref[row["ref_idx"]]
    i_pk = int(ev_["peakTimeS"] * sr)
    i_st = int(ev_["startS"] * sr)
    single.append(xf[i_pk] - np.mean(xf[max(0, i_st - int(0.1 * sr)):i_st]))
ratio = max(res["average"]["ref_mean"]) / float(np.mean(single))
check("average not smeared", ratio > 0.85, f"{ratio:.2f}")

# Swapping the channels flips the sign of every lag.
res2 = P.analyse_propagation(series, 1, 0, part, ref, params, params,
                             {"max_lag_ms": 100}, [], lambda t: t.data)
check("swap flips sign", abs(res2["summary"]["lag_ms"]["xcorr"]["median"] + LAG_S * 1000) < 0.1,
      str(res2["summary"]["lag_ms"]["xcorr"]["median"]))

# Opposite polarity (electrode in another layer) is detected and handled.
series_neg = SimpleNamespace(sweep_count=1, sweeps=[SimpleNamespace(trace_count=2, traces=[
    SimpleNamespace(data=x, sampling_rate=sr, units="mV"),
    SimpleNamespace(data=-partner, sampling_rate=sr, units="mV")])])
part_neg = [{**e, "peakSigned": -e["peakSigned"]} for e in part]
res3 = P.analyse_propagation(series_neg, 0, 1, ref, part_neg, params, params,
                             {"max_lag_ms": 100}, [], lambda t: t.data)
check("opposite polarity", abs(res3["summary"]["lag_ms"]["xcorr"]["median"] - LAG_S * 1000) < 0.1,
      str(res3["summary"]["lag_ms"]["xcorr"]["median"]))

# Onset (20 % of peak) recovers the shift too; the detector's start times
# don't (they're extended back to baseline and wander).
check("onset lag recovers shift", abs(s["lag_ms"]["onset"]["median"] - LAG_S * 1000) < 0.3,
      str(s["lag_ms"]["onset"]))
check("onset lag tight", (s["lag_ms"]["onset"]["q75"] - s["lag_ms"]["onset"]["q25"]) < 1.0,
      str(s["lag_ms"]["onset"]))

# Pairing uses peaks, one-to-one, closest first, same sweep only.
ev = lambda sw, st, pk: {"sweepIndex": sw, "startS": st, "peakTimeS": pk}
pairs = P.pair_events([ev(0, 0.95, 1.0), ev(0, 1.0, 1.05)],
                      [ev(0, 1.0, 1.04), ev(1, 0.9, 1.0)], 0.1)
check("greedy one-to-one pairing", pairs == [(1, 0)], str(pairs))
# Same discharge whose detector starts are 160 ms apart (the user's case)
# must still pair.
pairs = P.pair_events([ev(0, 22.883, 22.950)], [ev(0, 22.723, 22.958)], 0.1)
check("pairs despite wandering starts", pairs == [(0, 0)], str(pairs))

print(f"ref {len(ref)} · partner {len(part)} · pairs {s['n_pairs']} · "
      f"xcorr median {s['lag_ms']['xcorr']['median']:.3f} ms · onset {s['lag_ms']['onset']['median']:.2f} ms · "
      f"peak {s['lag_ms']['peak']['median']:.2f} ms")
if failures:
    print("FAIL")
    for f_ in failures:
        print("  -", f_)
    sys.exit(1)
print("OK")
