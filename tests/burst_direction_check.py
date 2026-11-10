"""Burst detection respects Peak direction (threshold and ISI methods).

Negative discharges, each followed by a positive rebound (as a 1 Hz
high-pass leaves after a large discharge), plus a few positive-only
events, in noise. With "negative" only the discharges are detected (the
rebounds and positive events were detected too: the detector thresholded
|signal - baseline| whatever the direction); "positive" finds the
rebounds and positive events; "auto" finds everything. The AP window's
noise-threshold method, which shares the detector, is unchanged.

Run from the repo root:  python tests/burst_direction_check.py
"""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
from analysis.bursts import BurstDetection  # noqa: E402

FS = 10_000.0
fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name}: {detail}")


rng = np.random.default_rng(3)
n = int(120 * FS)
t = np.arange(n) / FS
x = rng.normal(0, 0.05, n)
neg_t, pos_t = np.arange(5, 115, 10.0), np.arange(10, 115, 20.0)
for t0 in neg_t:                       # discharge, then a rebound 150-450 ms later
    u = t - t0
    up = np.clip(u, 0, None)
    x += np.where(u > 0, -1.0 * (np.exp(-up / 0.06) - np.exp(-up / 0.008)), 0)
    x += 0.4 * np.exp(-0.5 * ((u - 0.3) / 0.06) ** 2)
for t0 in pos_t:                       # positive-only events
    x += 0.6 * np.exp(-0.5 * ((t - t0) / 0.03) ** 2)


def peaks(direction, method="threshold"):
    p = dict(method=method, filter_enabled=False, baseline_mode="robust", noise_method="mad",
             n_sd=4, smooth_ms=10, min_duration_ms=20, min_gap_ms=100, peak_direction=direction,
             max_isi_ms=100, min_spikes_per_burst=1)
    return np.array([b["peak_time_s"] for b in BurstDetection().run(x, FS, p)["bursts"]])


def near(found, targets, tol=0.15):
    return sum(np.any(np.abs(found - tt) < tol) for tt in targets)


neg = peaks("negative")
check("negative: every discharge found", near(neg, neg_t + 0.02) == len(neg_t), f"{near(neg, neg_t + 0.02)}/{len(neg_t)}")
check("negative: no rebound or positive event", len(neg) == len(neg_t), f"{len(neg)} detections for {len(neg_t)} discharges")
pos = peaks("positive")
check("positive: rebounds and positive events, no discharge", near(pos, neg_t + 0.02, 0.05) == 0
      and near(pos, pos_t) == len(pos_t), f"{len(pos)} detections")
auto = peaks("auto")
check("auto: both sides", len(auto) >= len(neg_t) + len(pos_t), f"{len(auto)} detections")
isi_neg = peaks("negative", "isi")
check("ISI negative: no positive-only event", near(isi_neg, pos_t, 0.05) == 0, f"{near(isi_neg, pos_t, 0.05)} found")

if fails:
    print("FAIL")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print(f"OK  (negative {len(neg)}, positive {len(pos)}, auto {len(auto)} detections)")
