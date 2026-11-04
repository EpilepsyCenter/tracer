"""Batch / window fidelity: the shared sweep selection and the backend
pieces the audit fixed.

- utils/sweepSelection.ts (window and Batch): 1-based → 0-based, clamped,
  excluded sweeps out (run through node + esbuild);
- the generic batch endpoint errors on a channel the series doesn't have
  (it used to return an empty result, saved as "0 bursts");
- the Cursor endpoint labels each measurement with its own sweep when a
  sweep is skipped;
- Spectral regions report what they were cut to on a shorter recording;
- Cohort I-V fits baseline-subtracted responses; I-O intensity follows the
  sweep number.
Run from the repo root:  python tests/batch_fidelity_check.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import numpy as np  # noqa: E402

failures: list[str] = []


def check(name, ok, detail=''):
    if not ok:
        failures.append(f"{name}{' — ' + str(detail) if detail else ''}")


# 1. Shared sweep selection (TypeScript).
with tempfile.TemporaryDirectory() as d:
    entry = Path(d) / 'entry.ts'
    entry.write_text(f"""
import {{ resolveSweeps }} from '{ROOT}/frontend/src/utils/sweepSelection'
const cases = [
  [{{ runMode: 'all' }}, 5, [2]],
  [{{ runMode: 'range', sweepFrom: 1, sweepTo: 5 }}, 5, []],
  [{{ runMode: 'range', sweepFrom: 3, sweepTo: 5 }}, 5, [3]],
  [{{ runMode: 'range', sweepFrom: 1, sweepTo: 10 }}, 4, []],
  [{{ runMode: 'one', sweepOne: 1 }}, 5, [0]],
  [{{ runMode: 'one', sweepOne: 9 }}, 5, []],
  [{{}}, 3, []],
]
console.log(JSON.stringify(cases.map(([s, n, ex]) => resolveSweeps(s as any, n as number, ex as number[]))))
""")
    out = Path(d) / 'out.mjs'
    subprocess.run(['npx', 'esbuild', str(entry), '--bundle', '--platform=node', '--format=esm',
                    f'--outfile={out}', '--log-level=error'], check=True, cwd=ROOT)
    got = json.loads(subprocess.run(['node', str(out)], capture_output=True, text=True, check=True).stdout)
expect = [[0, 1, 3, 4], [0, 1, 2, 3, 4], [2, 4], [0, 1, 2, 3], [0], [4], [0, 1, 2]]
check('sweep selection', got == expect, (got, expect))

# 2-3. Generic batch endpoint: missing channel; Cursor endpoint labels.
from fastapi import HTTPException  # noqa: E402
import api.analysis as api_analysis  # noqa: E402
import api.cursors as api_cursors  # noqa: E402


def trace(vals, sr=1000.0):
    return SimpleNamespace(data=np.asarray(vals, float), sampling_rate=sr, units='pA')


def sweep(traces):
    return SimpleNamespace(traces=traces, trace_count=len(traces))


def recording(sweeps):
    ser = SimpleNamespace(sweeps=sweeps, sweep_count=len(sweeps))
    return SimpleNamespace(groups=[SimpleNamespace(series=[ser], series_count=1)], group_count=1), ser


rec, ser = recording([sweep([trace(np.zeros(100))]) for _ in range(3)])
src = Path(api_analysis.__file__).read_text()
check('batch endpoint raises on a missing channel', "isn't recorded in this series" in src)

# Cursor label alignment: sweep 1 has no channel-0 data → sweeps 0 and 2
# must keep their own labels.
src_c = Path(api_cursors.__file__).read_text()
check('cursor endpoint pairs vectors with their sweep',
      'zip(measured_idx, data_vectors)' in src_c and 'measured_idx.append(idx)' in src_c)

# 4. Spectral region warnings on a shorter recording.
from analysis import spectral  # noqa: E402
short = SimpleNamespace(sweep_count=3, sweeps=[sweep([trace(np.zeros(30000))]) for _ in range(3)])
w = spectral.region_warnings(short, 0, {'sweep_from': 1, 'sweep_to': 9, 't_start': 20.0, 't_end': 120.0})
check('spectral: sweep range clamped is reported', any('up to 10' in x and 'has 3' in x for x in w), w)
check('spectral: time window clamped is reported', any('ends at 120 s' in x for x in w), w)
check('spectral: region within the data has no warning',
      spectral.region_warnings(short, 0, {'sweep_from': 0, 'sweep_to': 2, 't_start': 0.0, 't_end': 10.0}) == [])

# 5. Cohort I-V and I-O.
from analysis import cohort  # noqa: E402
pts = [{'stimLevel': v, 'steadyState': 200 + 2 * v, 'baseline': 200.0} for v in (-20, -10, 0, 10, 20)]
iv = cohort.extract_iv({'points': pts, 'responseMetric': 'steady'}, {})
check('I-V: baseline-subtracted fit', abs(iv.scalars['iv_slope'] - 2) < 1e-9 and abs(iv.scalars['iv_intercept']) < 1e-9,
      iv.scalars)
io_pts = [{'sweepIndices': [i], 'binIndex': j, 'slope': -(1.0 + i)} for j, i in enumerate([0, 1, 3, 4])]
io = cohort.extract_fpsp_io({'points': io_pts, 'ioInitialIntensity': 100, 'ioIntensityStep': 100}, {})
check('I-O: intensity from the sweep number, magnitudes', abs(io.scalars['io_slope'] - 0.01) < 1e-9, io.scalars)

if failures:
    print('FAILED')
    for f in failures:
        print('  -', f)
    sys.exit(1)
print('OK')
