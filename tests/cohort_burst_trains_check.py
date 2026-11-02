"""Regression check: Cohort must emit train metrics for bursts.

Burst result blobs don't store their own group/series, so Cohort used to
miss the per-series ``train_params`` and silently drop train metrics.
Run from the repo root:  python tests/cohort_burst_trains_check.py"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from analysis import cohort  # noqa: E402

bursts = []
for c0 in (1.0, 10.0):          # two clusters of three bursts, 200 ms gaps
    for k in range(3):
        s = c0 + k * 0.5
        bursts.append({"sweepIndex": 0, "startS": s, "endS": s + 0.3, "peakTimeS": s + 0.1,
                       "durationMs": 300, "peakAmplitude": 1, "integral": 1})
sidecar = {
    "format": "tracer-sidecar", "version": 4,
    "meta": {"group_tags": ["WT"], "series_tags": {"0:2": ["field"]}},
    "analyses": {"bursts": {"0:2": {"channel": 0, "params": {}, "bursts": bursts}}},
    "train_params": {"bursts": {"0:2": {"enabled": True, "metric": "gap", "maxIeiMs": 500,
                                        "minCount": 2, "minDurationMs": 0, "minInterTrainMs": 0}}},
}
with tempfile.TemporaryDirectory() as d:
    (Path(d) / "c.abf").touch()
    (Path(d) / "c.abf.tracer").write_text(json.dumps(sidecar))
    out = cohort.aggregate_folder(d, "bursts")
sc = out["cells"][0]["scalars"]
if sc.get("n_trains") == 2.0 and sc.get("mean_events_per_train") == 3.0:
    print("OK")
else:
    print("FAIL", {k: v for k, v in sc.items() if "train" in k})
    sys.exit(1)
