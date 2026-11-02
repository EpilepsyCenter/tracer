"""LTTB downsampling: the vectorised implementation in
backend/utils/downsampling.py must pick exactly the same points as the
original per-point loop (kept below as the reference).
Run from the repo root:  python tests/lttb_check.py"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from utils.downsampling import lttb_downsample  # noqa: E402


def reference(x, y, n_out):
    n_in = len(x)
    if n_out >= n_in or n_out < 3:
        return x, y
    out_x = np.empty(n_out, dtype=x.dtype)
    out_y = np.empty(n_out, dtype=y.dtype)
    out_x[0], out_y[0] = x[0], y[0]
    out_x[-1], out_y[-1] = x[-1], y[-1]
    bucket_size = (n_in - 2) / (n_out - 2)
    a_idx = 0
    for i in range(1, n_out - 1):
        bs = int(np.floor((i - 1) * bucket_size)) + 1
        be = min(int(np.floor(i * bucket_size)) + 1, n_in - 1)
        ns = int(np.floor(i * bucket_size)) + 1
        ne = min(int(np.floor((i + 1) * bucket_size)) + 1, n_in)
        avg_x = np.mean(x[ns:ne])
        avg_y = np.mean(y[ns:ne])
        max_area, max_idx = -1.0, bs
        for j in range(bs, be):
            area = abs((x[a_idx] - avg_x) * (y[j] - y[a_idx]) - (x[a_idx] - x[j]) * (avg_y - y[a_idx]))
            if area > max_area:
                max_area, max_idx = area, j
        out_x[i], out_y[i] = x[max_idx], y[max_idx]
        a_idx = max_idx
    return out_x, out_y


rng = np.random.default_rng(0)
cases = [(10_000, 4000, np.float64, False), (123_457, 4000, np.float64, False),
         (50_000, 3, np.float64, False), (9, 5, np.float64, False),
         (60_000, 4000, np.float32, False), (40_000, 4000, np.float64, True)]
bad = []
for n, k, dt, ties in cases:
    x = np.arange(n) / 20000.0
    y = rng.normal(0, 1, n).astype(dt)
    if ties:
        y = np.round(y * 2) / 2
    a, b = reference(x, y, k), lttb_downsample(x, y, k)
    if not (np.array_equal(a[0], b[0]) and np.array_equal(a[1], b[1])):
        bad.append((n, k, dt.__name__, ties))
print("OK" if not bad else f"FAIL {bad}")
sys.exit(1 if bad else 0)
